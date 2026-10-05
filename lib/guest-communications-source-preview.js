import { validGuestEmail } from './direct-guest-email.js';
import { collectBookings } from './beds24-operations-import.js';
import { getBeds24MessagingAccessToken } from './beds24-messaging.js';
import { guestWorkerConfig, guestStorageConfig, GuestWorkerError } from './guest-communications-worker.js';
import { communicationRoute, guestCommunicationEligible, reconcileGuestCommunicationPlan } from './guest-communications.js';
import { renderGuestCommunication, GuestMessageRenderError } from './guest-message-renderer.js';

// Read-only preview: no storage RPC, provider write or delivery import.
export async function previewBeds24GuestSource({ env = process.env, now = new Date(), fetcher = fetch, channel = 'bookingcom' } = {}) {
  const newChannels = channel === 'new_channels';
  if (!newChannels && channel !== 'bookingcom') throw new GuestWorkerError('preview_channel_invalid');
  if (newChannels && (!['live','dry_run'].includes(env.BSTE_GUEST_WORKER_MODE) || env.BSTE_GUEST_AIRBNB_SENDING === 'true' || env.BSTE_GUEST_DIRECT_SENDING === 'true')) throw new GuestWorkerError('preview_channels_must_remain_disabled');
  const cfg = newChannels ? guestStorageConfig(env) : guestWorkerConfig(env);
  const account = String(env.BSTE_BEDS24_ACCOUNT_KEY || '').trim();
  if (!account) throw new GuestWorkerError('beds24_account_key_missing');
  const token = await getBeds24MessagingAccessToken({ env, fetcher });
  const batch = await collectBookings({ token, account, now, fetcher, includeInvoiceItems: false });
  async function read(path, limit) {
    const response = await fetcher(`${cfg.url}/rest/v1/${path}`, {
      method: 'GET', headers: { apikey: cfg.serviceKey, ...(cfg.serviceKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${cfg.serviceKey}` }), Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new GuestWorkerError('worker_storage_rejected');
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length >= limit) throw new GuestWorkerError('preview_storage_limit_or_invalid');
    return rows;
  }
  const stored = await read('ops_bookings?select=id,beds24_booking_id,source_account,source_environment,source_kind,source_channel,source_status,guest_name,guest_email,property_slug,arrival,departure,adults,children,automation_enrolled_at&limit=2001', 2001);
  const communications = await read('ops_communications?select=booking_id,message_key,status,reason,scheduled_at,claim_token&limit=14001', 14001);
  const snapshots = batch.items.map(item => item.snapshot);
  const bookings = snapshots.filter(b => (newChannels ? ['beds24_airbnb','direct_email'].includes(communicationRoute(b)) : communicationRoute(b) === 'beds24_bookingcom') && guestCommunicationEligible(b)).map(b => {
    const prior = b.source_kind === 'manual_direct' ? b : stored.find(row => Number(row.beds24_booking_id) === b.beds24_booking_id && row.source_account === account && row.source_environment === 'production');
    const existing = communications.filter(row => row.booking_id === prior?.id);
    const plan = reconcileGuestCommunicationPlan({booking:b,enrolledAt:prior?.automation_enrolled_at || now.toISOString(),existing,sendConfirmation:false});
    return { route:communicationRoute(b), recipient_available:communicationRoute(b) !== 'direct_email' || validGuestEmail(b.guest_email), beds24_booking_id:b.beds24_booking_id, guest_name:b.guest_name, property_slug:b.property_slug, arrival:b.arrival, departure:b.departure,
      enrollment_saved:Boolean(prior?.automation_enrolled_at), messages:plan.map(row => {
        let render;
        try { const message = renderGuestCommunication({booking:b,communication:row,env}); render={status:'rendered',subject:message.subject,body_length:message.body.length}; }
        catch(error) { render={status:'blocked',reason:error instanceof GuestMessageRenderError ? error.code : 'render_failed'}; }
        const at = Date.parse(row.scheduled_at);
        return { message_key:row.message_key,scheduled_at:row.scheduled_at,status:row.status,reason:row.reason,
          automation_enabled:false,claimed:Boolean(row.claim_token), window:at>now.getTime()?'future':at>=now.getTime()-15*60000?'due':'expired',render };
      }) };
  });
  return {ok:true,mode:'dry_run',channel,preview_only:true,live_guest_sending_enabled:false,queue_mutated:false,beds24_called:true,provider_messages_sent:0,
    inspected_at:now.toISOString(),source_booking_count:batch.items.length,eligible_bookingcom_count:newChannels ? 0 : bookings.length,eligible_airbnb_count:bookings.filter(b=>b.route==='beds24_airbnb').length,eligible_direct_count:bookings.filter(b=>b.route==='direct_email').length, direct_email_configured:Boolean(env.BSTE_GMAIL_CLIENT_ID && env.BSTE_GMAIL_CLIENT_SECRET && env.BSTE_GMAIL_REFRESH_TOKEN),bookings};
}
