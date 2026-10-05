import {
  classifyGuestDispatchWindow,
  inspectGuestDispatchCandidate
} from './guest-communications-dispatch.js';
import {
  GuestMessageRenderError,
  renderGuestCommunication
} from './guest-message-renderer.js';

export class GuestWorkerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GuestWorkerError';
    this.code = code;
  }
}

function required(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new GuestWorkerError(code);
  return text;
}

export function guestWorkerConfig(env = process.env) {
  if (env.BSTE_GUEST_WORKER_MODE !== 'dry_run') {
    throw new GuestWorkerError('worker_not_in_dry_run_mode');
  }
  if (env.BSTE_GUEST_LIVE_SENDING === 'true') {
    throw new GuestWorkerError('live_sending_must_remain_disabled');
  }
  return guestStorageConfig(env);
}

export function guestStorageConfig(env = process.env) {
  if (env.BSTE_STAFF_ENV !== 'staging' || env.BSTE_OPERATIONS_ENABLED !== 'true') {
    throw new GuestWorkerError('staging_operations_not_enabled');
  }

  const ref = required(
    env.BSTE_OPERATIONS_STAGING_PROJECT_REF,
    'staging_project_ref_missing'
  );
  const url = required(
    env.BSTE_STAFF_SUPABASE_URL,
    'staging_url_missing'
  );
  const serviceKey = required(
    env.BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY,
    'staging_service_key_missing'
  );

  if (!/^[a-z0-9]{20}$/.test(ref) || url !== `https://${ref}.supabase.co`) {
    throw new GuestWorkerError('staging_project_mismatch');
  }

  return {
    url,
    serviceKey,
    mode: env.BSTE_GUEST_WORKER_MODE
  };
}

async function serviceGet(path, {
  fetcher = fetch,
  env = process.env
} = {}) {
  const cfg = guestWorkerConfig(env);
  let response;

  try {
    response = await fetcher(`${cfg.url}/rest/v1/${path}`, {
      method: 'GET',
      headers: {
        apikey: cfg.serviceKey,
        ...(cfg.serviceKey.startsWith('sb_secret_')
          ? {}
          : { Authorization: `Bearer ${cfg.serviceKey}` }),
        Accept: 'application/json'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new GuestWorkerError('worker_storage_unavailable');
  }

  if (!response.ok) {
    throw new GuestWorkerError('worker_storage_rejected');
  }

  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    throw new GuestWorkerError('worker_storage_invalid_response');
  }

  return data;
}

function bookingFilter(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return null;
  return 'id=in.(' + unique.join(',') + ')';
}

export async function inspectPersistedGuestQueue({
  now = new Date(),
  fetcher = fetch,
  env = process.env
} = {}) {
  guestWorkerConfig(env);

  const communications = await serviceGet(
    'ops_communications?select=id,booking_id,message_key,route,scheduled_at,status,automation_enabled,reason&status=eq.scheduled&order=scheduled_at.asc&limit=200',
    { fetcher, env }
  );

  const filter = bookingFilter(communications.map(row => row.booking_id));
  const bookings = filter
    ? await serviceGet(
        'ops_bookings?select=id,beds24_booking_id,source_status,source_channel,arrival,departure,property_slug,guest_name,adults,children&' + filter,
        { fetcher, env }
      )
    : [];

  const byBooking = new Map(bookings.map(row => [row.id, row]));

  const items = communications.map(communication => {
    const booking = byBooking.get(communication.booking_id) || null;

    let timing;
    try {
      timing = classifyGuestDispatchWindow({
        scheduledAt: communication.scheduled_at,
        now
      });
    } catch {
      timing = {
        state: 'invalid',
        reason: 'invalid_schedule'
      };
    }

    const candidate = inspectGuestDispatchCandidate({
      booking,
      communication,
      now
    });

    let render = {
      status: 'not_attempted',
      reason: booking ? null : 'booking_missing',
      subject: null,
      body_length: null
    };

    if (booking) {
      try {
        const message = renderGuestCommunication({
          booking,
          communication,
          env
        });
        render = {
          status: 'rendered',
          reason: null,
          subject: message.subject,
          body_length: message.body.length
        };
      } catch (error) {
        render = {
          status: 'blocked',
          reason: error instanceof GuestMessageRenderError
            ? error.code
            : 'render_failed',
          subject: null,
          body_length: null
        };
      }
    }

    return {
      communication_id: communication.id,
      message_key: communication.message_key,
      route: communication.route,
      scheduled_at: communication.scheduled_at,
      automation_enabled: communication.automation_enabled === true,
      timing_state: timing.state,
      timing_reason: timing.reason || null,
      readiness_reason: candidate.reason || null,
      ready: candidate.ready === true,
      render
    };
  });

  const counts = {
    total: items.length,
    future: items.filter(item => item.timing_state === 'future').length,
    due: items.filter(item => item.timing_state === 'due').length,
    expired: items.filter(item => item.timing_state === 'expired').length,
    invalid: items.filter(item => item.timing_state === 'invalid').length,
    enabled: items.filter(item => item.automation_enabled).length,
    ready: items.filter(item => item.ready).length
  };

  return {
    ok: true,
    mode: 'dry_run',
    live_guest_sending_enabled: false,
    queue_mutated: false,
    beds24_called: false,
    inspected_at: now.toISOString(),
    counts,
    items
  };
}
