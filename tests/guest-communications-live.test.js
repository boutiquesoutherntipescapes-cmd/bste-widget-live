import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GuestLiveWorkerError,
  deliverClaimedGuestCommunication,
  deliverPersistedGuestQueue,
  guestLiveWorkerConfig
} from '../lib/guest-communications-live.js';

const ref = 'abcdefghijklmnopqrst';
const liveEnv = {
  BSTE_GUEST_WORKER_MODE: 'live',
  BSTE_GUEST_LIVE_SENDING: 'true',
  BSTE_STAFF_ENV: 'staging',
  BSTE_OPERATIONS_ENABLED: 'true',
  BSTE_OPERATIONS_STAGING_PROJECT_REF: ref,
  BSTE_STAFF_SUPABASE_URL: `https://${ref}.supabase.co`,
  BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
  BEDS24_REFRESH_TOKEN: 'fixture-refresh-token'
};

function reply(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return json; }
  };
}

const booking = {
  id: 'booking-fixture',
  beds24_booking_id: 12345678,
  source_environment: 'production',
  source_status: 'new',
  source_channel: 'Booking.com',
  property_slug: 'legacy-suiderstrand',
  guest_name: 'Sample Guest',
  arrival: '2026-11-10',
  departure: '2026-11-13',
  adults: 2,
  children: 0
};

test('live worker requires explicit live mode and live flag', () => {
  assert.throws(
    () => guestLiveWorkerConfig({ ...liveEnv, BSTE_GUEST_WORKER_MODE: 'dry_run' }),
    error => error instanceof GuestLiveWorkerError
      && error.code === 'worker_not_in_live_mode'
  );

  assert.throws(
    () => guestLiveWorkerConfig({ ...liveEnv, BSTE_GUEST_LIVE_SENDING: 'false' }),
    error => error instanceof GuestLiveWorkerError
      && error.code === 'live_sending_not_enabled'
  );
});

test('claim rejection never calls Beds24', async () => {
  let beds24Called = false;

  const result = await deliverClaimedGuestCommunication({
    communicationId: 'comm-fixture',
    now: new Date('2026-11-12T16:00:00Z'),
    env: liveEnv,
    uuid: () => '11111111-1111-4111-8111-111111111111',
    storageFetcher: async (url) => {
      assert.match(url, /ops_claim_guest_communication$/);
      return reply({
        claimed: false,
        reason: 'automation_not_enabled',
        communication_id: 'comm-fixture'
      });
    },
    beds24Fetcher: async () => {
      beds24Called = true;
      throw new Error('must not call Beds24');
    }
  });

  assert.equal(result.outcome, 'not_claimed');
  assert.equal(result.reason, 'automation_not_enabled');
  assert.equal(beds24Called, false);
});

test('successful claim renders, sends once, then finalizes sent', async () => {
  const storageCalls = [];
  const beds24Calls = [];

  const result = await deliverClaimedGuestCommunication({
    communicationId: 'comm-fixture',
    now: new Date('2026-11-12T16:00:00Z'),
    env: liveEnv,
    uuid: () => '22222222-2222-4222-8222-222222222222',
    storageFetcher: async (url, options) => {
      storageCalls.push({ url, options });

      if (url.endsWith('/ops_claim_guest_communication')) {
        return reply({
          claimed: true,
          communication_id: 'comm-fixture',
          booking_id: 'booking-fixture',
          message_key: 'departure_eve',
          route: 'beds24_bookingcom',
          scheduled_at: '2026-11-12T16:00:00Z',
          beds24_booking_id: 12345678,
          booking
        });
      }

      if (url.endsWith('/ops_mark_guest_communication_sent')) {
        return reply({
          ok: true,
          status: 'sent',
          communication_id: 'comm-fixture'
        });
      }

      throw new Error('Unexpected storage call');
    },
    beds24Fetcher: async (url, options) => {
      beds24Calls.push({ url, options });

      if (url.endsWith('/authentication/token')) {
        return reply({ token: 'fixture-access-token', expiresIn: 3600 });
      }

      if (url.endsWith('/bookings/messages')) {
        const body = JSON.parse(options.body);
        assert.equal(body[0].bookingId, 12345678);
        assert.match(body[0].message, /^Hi Sample,/);
        return reply([{ success: true }]);
      }

      throw new Error('Unexpected Beds24 call');
    }
  });

  assert.equal(result.outcome, 'sent');
  assert.equal(beds24Calls.filter(call => call.url.endsWith('/bookings/messages')).length, 1);
  assert.ok(storageCalls.some(call => call.url.endsWith('/ops_mark_guest_communication_sent')));
});

test('provider uncertainty is recorded failed and not retried', async () => {
  let messagePosts = 0;
  let failedRecorded = false;

  const result = await deliverClaimedGuestCommunication({
    communicationId: 'comm-fixture',
    now: new Date('2026-11-12T16:00:00Z'),
    env: liveEnv,
    uuid: () => '33333333-3333-4333-8333-333333333333',
    storageFetcher: async (url, options) => {
      if (url.endsWith('/ops_claim_guest_communication')) {
        return reply({
          claimed: true,
          communication_id: 'comm-fixture',
          booking_id: 'booking-fixture',
          message_key: 'departure_eve',
          route: 'beds24_bookingcom',
          scheduled_at: '2026-11-12T16:00:00Z',
          beds24_booking_id: 12345678,
          booking
        });
      }

      if (url.endsWith('/ops_mark_guest_communication_failed')) {
        const body = JSON.parse(options.body);
        assert.equal(body.failure_reason, 'provider_outcome_uncertain');
        failedRecorded = true;
        return reply({ ok: true, status: 'failed' });
      }

      throw new Error('Unexpected storage call');
    },
    beds24Fetcher: async (url) => {
      if (url.endsWith('/authentication/token')) {
        return reply({ token: 'fixture-access-token', expiresIn: 3600 });
      }

      if (url.endsWith('/bookings/messages')) {
        messagePosts += 1;
        throw new Error('connection lost');
      }

      throw new Error('Unexpected Beds24 call');
    }
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'provider_outcome_uncertain');
  assert.equal(messagePosts, 1);
  assert.equal(failedRecorded, true);
});

test('queue scanner only reads explicitly enabled due Booking.com rows', async () => {
  const storageUrls = [];

  const result = await deliverPersistedGuestQueue({
    env: liveEnv,
    now: new Date('2026-11-12T16:00:00Z'),
    uuid: () => '55555555-5555-4555-8555-555555555555',
    storageFetcher: async (url, options) => {
      storageUrls.push(url);

      if (options.method === 'GET') {
        assert.match(url, /status=eq\.scheduled/);
        assert.match(url, /automation_enabled=eq\.true/);
        assert.match(url, /claim_token=is\.null/);
        assert.match(url, /route=eq\.beds24_bookingcom/);
        assert.match(url, /scheduled_at=gte\./);
        assert.match(url, /scheduled_at=lte\./);
        return reply([]);
      }

      throw new Error('Unexpected storage call');
    },
    beds24Fetcher: async () => {
      throw new Error('must not call Beds24 when no due rows exist');
    }
  });

  assert.equal(result.scanned, 0);
  assert.equal(result.sent, 0);
  assert.equal(storageUrls.length, 1);
});
