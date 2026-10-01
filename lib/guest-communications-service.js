import {
  buildGuestCommunicationPlan,
  reconcileGuestCommunicationPlan
} from './guest-communications.js';

const BOOKING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireBookingRow(booking) {
  if (!booking || typeof booking !== 'object') throw new Error('Booking record required');
  if (!booking.id || !BOOKING_UUID.test(String(booking.id))) throw new Error('Stored booking id required');
  if (!booking.arrival || !booking.departure) throw new Error('Stored booking dates required');
  return booking;
}

export function previewStoredGuestCommunications({
  booking,
  existingCommunications = [],
  now = new Date(),
  sendConfirmation = false,
  preArrivalTime = '09:00'
}) {
  requireBookingRow(booking);
  const enrolledAt = booking.automation_enrolled_at || now.toISOString();

  const plan = reconcileGuestCommunicationPlan({
    booking,
    enrolledAt,
    existing: existingCommunications,
    sendConfirmation,
    preArrivalTime
  });

  return {
    booking_id: booking.id,
    beds24_booking_id: booking.beds24_booking_id ?? null,
    guest_name: booking.guest_name || '',
    guest_email_present: Boolean(String(booking.guest_email || '').trim()),
    source_channel: booking.source_channel || '',
    automation_enrolled_at: enrolledAt,
    preview_only: true,
    communications: plan.map(row => ({
      booking_id: booking.id,
      message_key: row.message_key,
      route: row.route,
      scheduled_at: row.scheduled_at,
      status: row.status,
      automation_enabled: false,
      provider_message_id: row.provider_message_id || null,
      sent_at: row.sent_at || null,
      reason: row.reason || null
    }))
  };
}

export function storedCommunicationRows(preview) {
  if (!preview?.preview_only) throw new Error('Only preview plans may be persisted by this module');
  return preview.communications.map(row => ({
    ...row,
    automation_enabled: false
  }));
}

export function isSafePreviewPlan(preview) {
  return Boolean(preview?.preview_only)
    && Array.isArray(preview.communications)
    && preview.communications.length === 7
    && preview.communications.every(row => row.automation_enabled === false);
}
