import { Beds24MessagingError } from './beds24-messaging.js';

const BOOKINGCOM_ROUTE = 'beds24_bookingcom';
const DEFAULT_LATE_GRACE_MS = 15 * 60 * 1000;

function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function classifyGuestDispatchWindow({
  scheduledAt,
  now = new Date(),
  lateGraceMs = DEFAULT_LATE_GRACE_MS
}) {
  const scheduled = new Date(scheduledAt);
  const current = now instanceof Date ? now : new Date(now);

  if (!Number.isFinite(scheduled.getTime()) || !Number.isFinite(current.getTime())) {
    throw new Error('Valid schedule and current time are required');
  }

  if (current < scheduled) {
    return {
      state: 'future',
      scheduled_at: scheduled.toISOString()
    };
  }

  if (current.getTime() - scheduled.getTime() > lateGraceMs) {
    return {
      state: 'expired',
      scheduled_at: scheduled.toISOString(),
      reason: 'dispatch_window_expired'
    };
  }

  return {
    state: 'due',
    scheduled_at: scheduled.toISOString()
  };
}

export function inspectGuestDispatchCandidate({
  booking,
  communication,
  now = new Date(),
  lateGraceMs = DEFAULT_LATE_GRACE_MS
}) {
  if (!booking || !communication) {
    return { ready: false, reason: 'missing_booking_or_communication' };
  }

  if (communication.status !== 'scheduled') {
    return { ready: false, reason: 'communication_not_scheduled' };
  }

  if (communication.automation_enabled !== true) {
    return { ready: false, reason: 'automation_not_enabled' };
  }

  if (communication.route !== BOOKINGCOM_ROUTE) {
    return { ready: false, reason: 'unsupported_live_route' };
  }

  const status = normalise(
    booking.source_status || booking.booking_status || booking.status
  );

  if (!['new', 'confirmed'].includes(status)) {
    return {
      ready: false,
      reason: status === 'cancelled' ? 'booking_cancelled' : 'booking_not_confirmed'
    };
  }

  const channel = normalise(
    booking.source_channel || booking.channel || booking.channel_code
  );

  if (!(channel === 'booking' || channel.includes('booking.com'))) {
    return { ready: false, reason: 'booking_channel_mismatch' };
  }

  const bookingId = Number(booking.beds24_booking_id);
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return { ready: false, reason: 'invalid_beds24_booking_id' };
  }

  const window = classifyGuestDispatchWindow({
    scheduledAt: communication.scheduled_at,
    now,
    lateGraceMs
  });

  if (window.state !== 'due') {
    return {
      ready: false,
      reason: window.reason || 'not_due_yet',
      window: window.state,
      scheduled_at: window.scheduled_at
    };
  }

  return {
    ready: true,
    route: BOOKINGCOM_ROUTE,
    beds24_booking_id: bookingId,
    communication_id: communication.id || null,
    message_key: communication.message_key,
    scheduled_at: window.scheduled_at
  };
}

export function assertGuestDispatchCandidate(args) {
  const result = inspectGuestDispatchCandidate(args);
  if (!result.ready) {
    throw new Beds24MessagingError(
      result.reason || 'communication_not_dispatchable'
    );
  }
  return result;
}
