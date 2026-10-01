import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGuestCommunicationPlan,
  reconcileGuestCommunicationPlan,
  communicationRoute,
  sastDateTime
} from '../lib/guest-communications.js';

const direct = {
  source_kind: 'manual_direct',
  source_status: 'confirmed',
  arrival: '2026-10-15',
  departure: '2026-10-18'
};

test('approved seven-message cadence uses Johannesburg clock times', () => {
  const plan = buildGuestCommunicationPlan({
    booking: direct,
    enrolledAt: '2026-10-01T08:00:00Z',
    sendConfirmation: true,
    preArrivalTime: '09:00'
  });
  assert.equal(plan.length, 7);
  assert.deepEqual(plan.map(x => [x.message_key, x.scheduled_at]), [
    ['booking_confirmation', '2026-10-01T08:00:00.000Z'],
    ['pre_arrival', '2026-10-12T07:00:00.000Z'],
    ['arrival_morning', '2026-10-15T07:00:00.000Z'],
    ['arrival_evening_essentials', '2026-10-15T18:00:00.000Z'],
    ['departure_eve', '2026-10-17T16:00:00.000Z'],
    ['departure_morning', '2026-10-18T06:00:00.000Z'],
    ['post_stay', '2026-10-19T08:00:00.000Z']
  ]);
  assert.ok(plan.every(x => x.automation_enabled === false));
});

test('pre-arrival timing is locked to 09:00 SAST', () => {
  const plan = buildGuestCommunicationPlan({
    booking: direct,
    enrolledAt: '2026-10-01T08:00:00Z',
    sendConfirmation: false,
    preArrivalTime: '09:00'
  });
  assert.equal(plan.find(x => x.message_key === 'pre_arrival').scheduled_at, '2026-10-12T07:00:00.000Z');
});

test('late enrollment skips historical windows instead of catch-up sending', () => {
  const plan = buildGuestCommunicationPlan({
    booking: direct,
    enrolledAt: '2026-10-15T10:00:00Z'
  });
  assert.equal(plan.find(x => x.message_key === 'booking_confirmation').reason, 'existing_booking_confirmation_not_retroactive');
  assert.equal(plan.find(x => x.message_key === 'pre_arrival').reason, 'window_passed_before_enrollment');
  assert.equal(plan.find(x => x.message_key === 'arrival_morning').reason, 'window_passed_before_enrollment');
  assert.equal(plan.find(x => x.message_key === 'arrival_evening_essentials').status, 'scheduled');
});

test('cancelled bookings suppress every unsent communication', () => {
  const plan = buildGuestCommunicationPlan({
    booking: { ...direct, source_status: 'cancelled' },
    enrolledAt: '2026-10-01T08:00:00Z',
    sendConfirmation: true
  });
  assert.ok(plan.every(x => x.status === 'skipped' && x.reason === 'booking_cancelled'));
});

test('OTA routes stay on Beds24 channel routes while direct bookings use email', () => {
  assert.equal(communicationRoute(direct), 'direct_email');
  assert.equal(communicationRoute({ source_status:'confirmed', source_channel:'Airbnb' }), 'beds24_airbnb');
  assert.equal(communicationRoute({ source_status:'confirmed', source_channel:'Booking.com' }), 'beds24_bookingcom');
  assert.equal(communicationRoute({ source_status:'confirmed', source_channel:'Lekkeslaap' }), 'beds24_other');
});

test('date changes reschedule only unsent messages', () => {
  const initial = buildGuestCommunicationPlan({
    booking: direct,
    enrolledAt: '2026-10-01T08:00:00Z',
    sendConfirmation: true
  });
  const existing = initial.map(x => ({ ...x }));
  existing[0] = { ...existing[0], status:'sent', sent_at:'2026-10-01T08:01:00Z', provider_message_id:'fixture' };
  const moved = reconcileGuestCommunicationPlan({
    booking: { ...direct, arrival:'2026-10-17', departure:'2026-10-20' },
    enrolledAt: '2026-10-01T08:00:00Z',
    existing,
    sendConfirmation: true
  });
  assert.equal(moved[0].scheduled_at, initial[0].scheduled_at);
  assert.equal(moved[0].status, 'sent');
  assert.equal(moved.find(x => x.message_key === 'pre_arrival').scheduled_at, '2026-10-14T07:00:00.000Z');
  assert.equal(moved.find(x => x.message_key === 'departure_morning').scheduled_at, '2026-10-20T06:00:00.000Z');
});

test('failed/uncertain provider result is preserved and never blindly retried', () => {
  const initial = buildGuestCommunicationPlan({
    booking: direct,
    enrolledAt: '2026-10-01T08:00:00Z',
    sendConfirmation: true
  });
  const failed = initial.map(x => x.message_key === 'arrival_morning'
    ? { ...x, status:'failed', reason:'provider_outcome_uncertain' }
    : x);
  const plan = reconcileGuestCommunicationPlan({
    booking: { ...direct, arrival:'2026-10-16', departure:'2026-10-19' },
    enrolledAt: '2026-10-01T08:00:00Z',
    existing: failed,
    sendConfirmation: true
  });
  assert.equal(plan.find(x => x.message_key === 'arrival_morning').status, 'failed');
  assert.equal(plan.find(x => x.message_key === 'arrival_morning').reason, 'provider_outcome_uncertain');
});

test('Johannesburg conversion is fixed at UTC+2', () => {
  assert.equal(sastDateTime('2026-10-12','09:00'), '2026-10-12T07:00:00.000Z');
  assert.equal(sastDateTime('2026-10-12','20:00'), '2026-10-12T18:00:00.000Z');
});
