const SAST_OFFSET_MINUTES = 120;

export const GUEST_MESSAGE_DEFINITIONS = Object.freeze([
  { key: 'booking_confirmation', label: 'Booking confirmation', anchor: 'enrollment' },
  { key: 'pre_arrival', label: 'Full arrival information', anchor: 'arrival', offsetDays: -3, time: '09:00' },
  { key: 'arrival_morning', label: 'Arrival-day reminder', anchor: 'arrival', offsetDays: 0, time: '09:00' },
  { key: 'arrival_evening_essentials', label: 'House essentials / settled-in message', anchor: 'arrival', offsetDays: 0, time: '20:00' },
  { key: 'departure_eve', label: 'Checkout information', anchor: 'departure', offsetDays: -1, time: '18:00' },
  { key: 'departure_morning', label: 'Checkout reminder', anchor: 'departure', offsetDays: 0, time: '08:00' },
  { key: 'post_stay', label: 'Thank-you, review request and direct-booking invitation', anchor: 'departure', offsetDays: 1, time: '10:00' }
]);

function normalise(value) {
  return String(value ?? '').trim().toLowerCase();
}

function validDateParts(dateString) {
  const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

function validTimeParts(timeString) {
  const match = String(timeString || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function addCalendarDays(dateString, offsetDays) {
  const parts = validDateParts(dateString);
  if (!parts) throw new Error('Invalid booking date');
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(offsetDays || 0)));
  return date.toISOString().slice(0, 10);
}

export function sastDateTime(dateString, timeString) {
  const date = validDateParts(dateString);
  const time = validTimeParts(timeString);
  if (!date || !time) throw new Error('Invalid Johannesburg date/time');
  return new Date(
    Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute)
      - SAST_OFFSET_MINUTES * 60_000
  ).toISOString();
}

export function communicationRoute(booking = {}) {
  const sourceKind = normalise(booking.source_kind);
  const channel = normalise(booking.source_channel || booking.channel || booking.channel_code);

  if (sourceKind === 'manual_direct'
      || ['direct', 'direct bste', 'bookingpage', 'website', 'bste direct'].includes(channel)) {
    return 'direct_email';
  }
  if (channel.includes('airbnb')) return 'beds24_airbnb';
  if (channel === 'booking' || channel.includes('booking.com')) return 'beds24_bookingcom';
  if (channel) return 'beds24_other';
  return 'unresolved';
}

export function guestCommunicationEligible(booking = {}) {
  const status = normalise(booking.source_status || booking.booking_status || booking.status);
  if (status === 'cancelled' || status === 'black') return false;
  if (status === 'request' || status === 'inquiry') return false;
  return status === 'confirmed' || status === 'new';
}

function dueAtFor(definition, booking, enrolledAt, preArrivalTime) {
  if (definition.anchor === 'enrollment') return new Date(enrolledAt).toISOString();
  const anchorDate = definition.anchor === 'arrival' ? booking.arrival : booking.departure;
  const date = addCalendarDays(anchorDate, definition.offsetDays);
  const time = definition.key === 'pre_arrival' ? preArrivalTime : definition.time;
  return sastDateTime(date, time);
}

export function buildGuestCommunicationPlan({
  booking,
  enrolledAt,
  sendConfirmation = false,
  preArrivalTime = '09:00'
}) {
  if (!booking || !booking.arrival || !booking.departure) throw new Error('Booking arrival and departure are required');
  const enrolled = new Date(enrolledAt);
  if (!Number.isFinite(enrolled.getTime())) throw new Error('Valid enrollment time is required');

  const route = communicationRoute(booking);
  const eligible = guestCommunicationEligible(booking);
  const sourceStatus = normalise(booking.source_status || booking.booking_status || booking.status);

  return GUEST_MESSAGE_DEFINITIONS.map(definition => {
    const scheduledAt = dueAtFor(definition, booking, enrolled.toISOString(), preArrivalTime);
    const row = {
      message_key: definition.key,
      label: definition.label,
      route,
      scheduled_at: scheduledAt,
      status: 'scheduled',
      automation_enabled: false,
      reason: null
    };

    if (sourceStatus === 'cancelled') {
      return { ...row, status: 'skipped', reason: 'booking_cancelled' };
    }
    if (!eligible) {
      return { ...row, status: 'skipped', reason: 'booking_not_confirmed' };
    }
    if (route === 'unresolved') {
      return { ...row, status: 'skipped', reason: 'communication_route_unresolved' };
    }
    if (definition.key === 'booking_confirmation' && !sendConfirmation) {
      return { ...row, status: 'skipped', reason: 'existing_booking_confirmation_not_retroactive' };
    }
    if (definition.key !== 'booking_confirmation' && new Date(scheduledAt) < enrolled) {
      return { ...row, status: 'skipped', reason: 'window_passed_before_enrollment' };
    }

    return row;
  });
}

export function reconcileGuestCommunicationPlan({
  booking,
  enrolledAt,
  existing = [],
  sendConfirmation = false,
  preArrivalTime = '09:00'
}) {
  const desired = buildGuestCommunicationPlan({ booking, enrolledAt, sendConfirmation, preArrivalTime });
  const byKey = new Map(existing.map(row => [row.message_key, row]));

  return desired.map(row => {
    const prior = byKey.get(row.message_key);
    if (!prior) return row;

    // A sent message is historical evidence and is never recreated or rescheduled.
    if (prior.status === 'sent') return { ...prior };

    // A failed/uncertain provider outcome requires reconciliation, never a blind retry.
    if (prior.status === 'failed') return { ...prior };

    // Preserve explicit staff/manual skips. System-derived skips can be recalculated after a date change.
    if (prior.status === 'skipped' && String(prior.reason || '').startsWith('manual_')) {
      return { ...prior };
    }

    return {
      ...prior,
      route: row.route,
      scheduled_at: row.scheduled_at,
      status: row.status,
      automation_enabled: false,
      reason: row.reason
    };
  });
}
