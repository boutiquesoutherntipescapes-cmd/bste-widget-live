import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previewStoredGuestCommunications,
  storedCommunicationRows,
  isSafePreviewPlan
} from '../lib/guest-communications-service.js';

const mandyStyle = {
  id: '11111111-1111-4111-8111-111111111111',
  beds24_booking_id: 93636297,
  source_kind: 'beds24',
  source_status: 'confirmed',
  source_channel: 'Booking.com',
  guest_name: 'Mandy Pelser',
  guest_email: 'guest@example.com',
  arrival: '2026-10-01',
  departure: '2026-10-04',
  automation_enrolled_at: '2026-10-01T06:30:00Z'
};

test('Booking.com booking routes all seven communications through Beds24 and never enables sending', () => {
  const preview = previewStoredGuestCommunications({
    booking: mandyStyle,
    now: new Date('2026-10-01T06:45:00Z')
  });

  assert.equal(preview.preview_only, true);
  assert.equal(preview.guest_email_present, true);
  assert.equal(preview.source_channel, 'Booking.com');
  assert.equal(preview.communications.length, 7);
  assert.ok(preview.communications.every(row => row.route === 'beds24_bookingcom'));
  assert.ok(preview.communications.every(row => row.automation_enabled === false));
  assert.equal(isSafePreviewPlan(preview), true);
});

test('late enrollment for arrival-day Booking.com stay never backfills missed messages', () => {
  const preview = previewStoredGuestCommunications({
    booking: mandyStyle,
    now: new Date('2026-10-01T06:45:00Z')
  });

  const pre = preview.communications.find(x => x.message_key === 'pre_arrival');
  const morning = preview.communications.find(x => x.message_key === 'arrival_morning');
  const evening = preview.communications.find(x => x.message_key === 'arrival_evening_essentials');
  assert.equal(pre.status, 'skipped');
  assert.equal(pre.reason, 'window_passed_before_enrollment');
  assert.equal(morning.status, 'scheduled');
  assert.equal(evening.status, 'scheduled');
});

test('existing Booking.com relay or personal email does not change the route', () => {
  const withRelay = previewStoredGuestCommunications({
    booking: { ...mandyStyle, guest_email:'mpelse.107435@guest.booking.com' }
  });
  const withPersonal = previewStoredGuestCommunications({
    booking: { ...mandyStyle, guest_email:'mandy@example.com' }
  });
  assert.ok(withRelay.communications.every(x => x.route === 'beds24_bookingcom'));
  assert.ok(withPersonal.communications.every(x => x.route === 'beds24_bookingcom'));
});

test('preview persistence remains hard-disabled', () => {
  const preview = previewStoredGuestCommunications({ booking: mandyStyle });
  const rows = storedCommunicationRows(preview);
  assert.equal(rows.length, 7);
  assert.ok(rows.every(row => row.booking_id === mandyStyle.id && row.automation_enabled === false));
});

test('cancelled stored booking suppresses all unsent communications', () => {
  const preview = previewStoredGuestCommunications({
    booking: { ...mandyStyle, source_status:'cancelled' }
  });
  assert.ok(preview.communications.every(x => x.status === 'skipped' && x.reason === 'booking_cancelled'));
});

test('requires a real stored booking identity', () => {
  assert.throws(() => previewStoredGuestCommunications({
    booking: { ...mandyStyle, id:'not-a-uuid' }
  }), /Stored booking id required/);
});
