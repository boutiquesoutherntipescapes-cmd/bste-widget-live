import { randomUUID } from 'node:crypto';
import { Beds24MessagingError, getBeds24MessagingAccessToken, sendBeds24GuestMessage } from './beds24-messaging.js';
import { collectBookings } from './beds24-operations-import.js';
import { GuestMessageRenderError, renderGuestCommunication } from './guest-message-renderer.js';

export class GuestLiveWorkerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GuestLiveWorkerError';
    this.code = code;
  }
}

function required(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new GuestLiveWorkerError(code);
  return text;
}

export function guestLiveWorkerConfig(env = process.env) {
  if (env.BSTE_GUEST_WORKER_MODE !== 'live') {
    throw new GuestLiveWorkerError('worker_not_in_live_mode');
  }
  if (env.BSTE_GUEST_LIVE_SENDING !== 'true') {
    throw new GuestLiveWorkerError('live_sending_not_enabled');
  }
  if (env.BSTE_STAFF_ENV !== 'staging' || env.BSTE_OPERATIONS_ENABLED !== 'true') {
    throw new GuestLiveWorkerError('staging_operations_not_enabled');
  }

  const ref = required(env.BSTE_OPERATIONS_STAGING_PROJECT_REF, 'staging_project_ref_missing');
  const url = required(env.BSTE_STAFF_SUPABASE_URL, 'staging_url_missing');
  const serviceKey = required(env.BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY, 'staging_service_key_missing');

  if (!/^[a-z0-9]{20}$/.test(ref) || url !== `https://${ref}.supabase.co`) {
    throw new GuestLiveWorkerError('staging_project_mismatch');
  }

  required(env.BEDS24_REFRESH_TOKEN, 'beds24_refresh_token_missing');
  return { url, serviceKey };
}

function headers(serviceKey) {
  return {
    apikey: serviceKey,
    ...(serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${serviceKey}` }),
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

async function rpc(name, body, { fetcher, env }) {
  const cfg = guestLiveWorkerConfig(env);
  const response = await fetcher(`${cfg.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: headers(cfg.serviceKey),
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);

  if (!response) throw new GuestLiveWorkerError('worker_storage_unavailable');
  if (!response.ok) throw new GuestLiveWorkerError('worker_storage_rejected');

  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GuestLiveWorkerError('worker_storage_invalid_response');
  }
  return data;
}

async function serviceGet(path, { fetcher = fetch, env = process.env } = {}) {
  const cfg = guestLiveWorkerConfig(env);
  const response = await fetcher(`${cfg.url}/rest/v1/${path}`, {
    method: 'GET',
    headers: headers(cfg.serviceKey),
    redirect: 'error',
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);

  if (!response) throw new GuestLiveWorkerError('worker_storage_unavailable');
  if (!response.ok) throw new GuestLiveWorkerError('worker_storage_rejected');

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new GuestLiveWorkerError('worker_storage_invalid_response');
  }
  return data;
}

async function syncCurrentBeds24Bookings({
  now,
  storageFetcher,
  beds24Fetcher,
  env,
  collect
}) {
  const account = required(env.BSTE_BEDS24_ACCOUNT_KEY, 'beds24_account_key_missing');
  const token = await getBeds24MessagingAccessToken({
    fetcher: beds24Fetcher,
    env
  });

  const batch = await collect({
    token,
    account,
    now,
    fetcher: beds24Fetcher
  });

  for (const item of batch.items) {
    await rpc('ops_guest_sync_booking', {
      snapshot: item.snapshot
    }, {
      fetcher: storageFetcher,
      env
    });
  }

  return {
    synced: batch.items.length,
    property_counts: batch.counts
  };
}

function failureReason(error) {
  if (error instanceof GuestMessageRenderError) {
    return error.code === 'wifi_secret_missing' ? 'wifi_secret_missing' : 'render_failed';
  }
  if (error instanceof Beds24MessagingError && [
    'provider_outcome_uncertain',
    'provider_rejected_message',
    'authentication_unavailable',
    'authentication_failed',
    'messaging_not_configured'
  ].includes(error.code)) return error.code;
  return null;
}

export async function deliverClaimedGuestCommunication({
  communicationId,
  now = new Date(),
  storageFetcher = fetch,
  beds24Fetcher = fetch,
  env = process.env,
  uuid = randomUUID
}) {
  guestLiveWorkerConfig(env);

  const observedAt = now.toISOString();
  const claimToken = uuid();

  const claim = await rpc('ops_claim_guest_communication', {
    target_communication: communicationId,
    requested_claim_token: claimToken,
    observed_at: observedAt
  }, { fetcher: storageFetcher, env });

  if (claim.claimed !== true) {
    return {
      ok: true,
      outcome: 'not_claimed',
      reason: claim.reason || 'claim_rejected',
      communication_id: communicationId
    };
  }

  let rendered;
  try {
    rendered = renderGuestCommunication({
      booking: claim.booking,
      communication: {
        id: claim.communication_id,
        message_key: claim.message_key,
        route: claim.route,
        scheduled_at: claim.scheduled_at,
        status: 'scheduled',
        automation_enabled: true
      },
      env
    });
  } catch (error) {
    const reason = failureReason(error) || 'render_failed';
    await rpc('ops_mark_guest_communication_failed', {
      target_communication: claim.communication_id,
      expected_claim_token: claimToken,
      failure_reason: reason,
      observed_at: observedAt
    }, { fetcher: storageFetcher, env });

    return { ok: false, outcome: 'failed', reason, communication_id: claim.communication_id };
  }

  let provider;
  try {
    provider = await sendBeds24GuestMessage({
      bookingId: claim.beds24_booking_id,
      route: claim.route,
      message: rendered.body,
      fetcher: beds24Fetcher,
      env
    });
  } catch (error) {
    const reason = failureReason(error);
    if (!reason) throw new GuestLiveWorkerError('unexpected_delivery_failure');

    await rpc('ops_mark_guest_communication_failed', {
      target_communication: claim.communication_id,
      expected_claim_token: claimToken,
      failure_reason: reason,
      observed_at: observedAt
    }, { fetcher: storageFetcher, env });

    return { ok: false, outcome: 'failed', reason, communication_id: claim.communication_id };
  }

  const finalized = await rpc('ops_mark_guest_communication_sent', {
    target_communication: claim.communication_id,
    expected_claim_token: claimToken,
    provider_message_id_value: provider.provider_message_id || null,
    observed_at: observedAt
  }, { fetcher: storageFetcher, env }).catch(() => null);

  if (!finalized || finalized.ok !== true || finalized.status !== 'sent') {
    throw new GuestLiveWorkerError('provider_accepted_storage_uncertain');
  }

  return {
    ok: true,
    outcome: 'sent',
    communication_id: claim.communication_id,
    provider: 'beds24'
  };
}

export async function deliverPersistedGuestQueue({
  now = new Date(),
  storageFetcher = fetch,
  beds24Fetcher = fetch,
  env = process.env,
  uuid = randomUUID,
  collect = collectBookings
} = {}) {
  guestLiveWorkerConfig(env);

  const observedAt = now.toISOString();
  const dispatchFloor = new Date(now.getTime() - 15 * 60_000).toISOString();
  const sourceSync = await syncCurrentBeds24Bookings({
    now,
    storageFetcher,
    beds24Fetcher,
    env,
    collect
  });
  const rows = await serviceGet(
    'ops_communications?select=id' +
      '&status=eq.scheduled' +
      '&automation_enabled=eq.true' +
      '&claim_token=is.null' +
      '&route=eq.beds24_bookingcom' +
      '&scheduled_at=gte.' + encodeURIComponent(dispatchFloor) +
      '&scheduled_at=lte.' + encodeURIComponent(observedAt) +
      '&order=scheduled_at.asc&limit=20',
    { fetcher: storageFetcher, env }
  );

  const items = [];
  for (const row of rows) {
    items.push(await deliverClaimedGuestCommunication({
      communicationId: row.id,
      now,
      storageFetcher,
      beds24Fetcher,
      env,
      uuid
    }));
  }

  return {
    ok: true,
    mode: 'live',
    live_guest_sending_enabled: true,
    inspected_at: observedAt,
    source_sync: sourceSync,
    scanned: rows.length,
    sent: items.filter(item => item.outcome === 'sent').length,
    failed: items.filter(item => item.outcome === 'failed').length,
    not_claimed: items.filter(item => item.outcome === 'not_claimed').length,
    items
  };
}
