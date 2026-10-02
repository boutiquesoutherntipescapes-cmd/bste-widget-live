import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGuestDispatchWindow,
  inspectGuestDispatchCandidate,
  assertGuestDispatchCandidate
} from '../lib/guest-communications-dispatch.js';

const booking = {
  beds24_booking_id: 12345678,
  source_status: 'new',
  source_channel: 'Booking.com'
};

function row(overrides = {}) {
  return {
    id: 'd10bd6cf-ed6d-467e-9bab-903b0ebcca51',
    message_key: 'departure_eve',
    route: 'beds24_bookingcom',
    scheduled_at: '2026-10-03T16:00:00.000Z',
    status: 'scheduled',
    automation_enabled: false,
    ...overrides
  };
}

test('current staging rows cannot dispatch while automation_enabled is false', () => {
  const result = inspectGuestDispatchCandidate({
    booking,
    communication: row(),
    now: new Date('2026-10-03T16:00:00.000Z')
  });

  assert.deepEqual(result, {
    ready: false,
    reason: 'automation_not_enabled'
  });
});

test('future Booking.com message stays future', () => {
  const result = inspectGuestDispatchCandidate({
    booking,
    communication: row({ automation_enabled: true }),
    now: new Date('2026-10-03T15:59:59.000Z')
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'not_due_yet');
  assert.equal(result.window, 'future');
});

test('due Booking.com message is ready only inside the grace window', () => {
  const result = inspectGuestDispatchCandidate({
    booking,
    communication: row({ automation_enabled: true }),
    now: new Date('2026-10-03T16:10:00.000Z')
  });

  assert.equal(result.ready, true);
  assert.equal(result.beds24_booking_id, 12345678);
  assert.equal(result.message_key, 'departure_eve');
});

test('old scheduled message expires instead of catch-up sending', () => {
  const result = inspectGuestDispatchCandidate({
    booking,
    communication: row({
      message_key: 'arrival_evening_essentials',
      scheduled_at: '2026-10-01T18:00:00.000Z',
      automation_enabled: true
    }),
    now: new Date('2026-10-02T08:30:00.000Z')
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'dispatch_window_expired');
  assert.equal(result.window, 'expired');
});

test('cancelled booking cannot dispatch', () => {
  const result = inspectGuestDispatchCandidate({
    booking: { ...booking, source_status: 'cancelled' },
    communication: row({ automation_enabled: true }),
    now: new Date('2026-10-03T16:00:00.000Z')
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'booking_cancelled');
});

test('non Booking.com route cannot dispatch in first release', () => {
  const result = inspectGuestDispatchCandidate({
    booking,
    communication: row({
      route: 'beds24_airbnb',
      automation_enabled: true
    }),
    now: new Date('2026-10-03T16:00:00.000Z')
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'unsupported_live_route');
});

test('assert helper fails closed for disabled rows', () => {
  assert.throws(
    () => assertGuestDispatchCandidate({
      booking,
      communication: row(),
      now: new Date('2026-10-03T16:00:00.000Z')
    }),
    error => error?.code === 'automation_not_enabled'
  );
});

test('window classifier uses fifteen-minute default late grace', () => {
  assert.equal(
    classifyGuestDispatchWindow({
      scheduledAt: '2026-10-03T16:00:00.000Z',
      now: new Date('2026-10-03T16:15:00.000Z')
    }).state,
    'due'
  );

  assert.equal(
    classifyGuestDispatchWindow({
      scheduledAt: '2026-10-03T16:00:00.000Z',
      now: new Date('2026-10-03T16:15:00.001Z')
    }).state,
    'expired'
  );
});
