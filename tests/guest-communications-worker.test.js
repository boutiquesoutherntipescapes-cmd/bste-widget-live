import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GuestWorkerError,
  guestWorkerConfig,
  inspectPersistedGuestQueue
} from '../lib/guest-communications-worker.js';
import {
  createGuestCommunicationsWorkerHandler
} from '../api/guest-communications-worker.js';

const ref = 'abcdefghijklmnopqrst';
const env = {
  BSTE_GUEST_WORKER_MODE: 'dry_run',
  BSTE_GUEST_LIVE_SENDING: 'false',
  BSTE_STAFF_ENV: 'staging',
  BSTE_OPERATIONS_ENABLED: 'true',
  BSTE_OPERATIONS_STAGING_PROJECT_REF: ref,
  BSTE_STAFF_SUPABASE_URL: `https://${ref}.supabase.co`,
  BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key',
  CRON_SECRET: 'fixture-cron-secret'
};

function reply(json, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return json; }
  };
}

function res() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('worker refuses any mode except explicit dry_run', () => {
  assert.throws(
    () => guestWorkerConfig({ ...env, BSTE_GUEST_WORKER_MODE: 'live' }),
    error => error instanceof GuestWorkerError
      && error.code === 'worker_not_in_dry_run_mode'
  );
});

test('worker refuses to run when live guest sending is enabled', () => {
  assert.throws(
    () => guestWorkerConfig({ ...env, BSTE_GUEST_LIVE_SENDING: 'true' }),
    error => error instanceof GuestWorkerError
      && error.code === 'live_sending_must_remain_disabled'
  );
});

test('worker requires exact staging Supabase project identity', () => {
  assert.throws(
    () => guestWorkerConfig({
      ...env,
      BSTE_STAFF_SUPABASE_URL: 'https://wrong.supabase.co'
    }),
    error => error instanceof GuestWorkerError
      && error.code === 'staging_project_mismatch'
  );
});

test('dry-run worker reads queue and bookings but never calls Beds24 or mutates storage', async () => {
  const calls = [];

  const result = await inspectPersistedGuestQueue({
    env,
    now: new Date('2026-10-02T08:30:00Z'),
    fetcher: async (url, options) => {
      calls.push({ url, options });

      if (url.includes('/ops_communications?')) {
        return reply([
          {
            id: 'old-row',
            booking_id: 'booking-1',
            message_key: 'arrival_evening_essentials',
            route: 'beds24_bookingcom',
            scheduled_at: '2026-10-01T18:00:00Z',
            status: 'scheduled',
            automation_enabled: false,
            reason: null
          },
          {
            id: 'future-row',
            booking_id: 'booking-1',
            message_key: 'departure_eve',
            route: 'beds24_bookingcom',
            scheduled_at: '2026-10-03T16:00:00Z',
            status: 'scheduled',
            automation_enabled: false,
            reason: null
          }
        ]);
      }

      if (url.includes('/ops_bookings?')) {
        return reply([
          {
            id: 'booking-1',
            beds24_booking_id: 12345678,
            source_status: 'new',
            source_channel: 'Booking.com',
            arrival: '2026-10-01',
            departure: '2026-10-04',
            property_slug: 'legacy-suiderstrand',
            guest_name: 'Sample Guest',
            adults: 7,
            children: 0
          }
        ]);
      }

      throw new Error('Unexpected fetch');
    }
  });

  assert.equal(result.mode, 'dry_run');
  assert.equal(result.live_guest_sending_enabled, false);
  assert.equal(result.queue_mutated, false);
  assert.equal(result.beds24_called, false);
  assert.deepEqual(result.counts, {
    total: 2,
    future: 1,
    due: 0,
    expired: 1,
    invalid: 0,
    enabled: 0,
    ready: 0
  });
  assert.equal(result.items[0].timing_state, 'expired');
  assert.equal(result.items[1].timing_state, 'future');
  assert.ok(result.items.every(item => item.readiness_reason === 'automation_not_enabled'));
  assert.equal(result.items[0].render.status, 'blocked');
  assert.equal(result.items[0].render.reason, 'wifi_secret_missing');
  assert.equal(result.items[1].render.status, 'rendered');
  assert.equal(result.items[1].render.subject, 'We hope you’ve enjoyed your stay 🌊');
  assert.ok(result.items[1].render.body_length > 100);
  assert.ok(!('body' in result.items[1].render));
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.ok(calls.every(call => !call.url.includes('beds24.com')));
});

test('cron route rejects missing authorization before inspecting queue', async () => {
  let inspected = false;
  const handler = createGuestCommunicationsWorkerHandler({
    env,
    inspect: async () => { inspected = true; return {}; }
  });

  const response = res();
  await handler({ method: 'GET', headers: {} }, response);

  assert.equal(response.code, 401);
  assert.equal(inspected, false);
});

test('cron route accepts exact CRON_SECRET and returns dry-run report', async () => {
  const handler = createGuestCommunicationsWorkerHandler({
    env,
    inspect: async () => ({
      ok: true,
      mode: 'dry_run',
      live_guest_sending_enabled: false,
      queue_mutated: false,
      beds24_called: false
    })
  });

  const response = res();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer fixture-cron-secret' }
  }, response);

  assert.equal(response.code, 200);
  assert.equal(response.body.mode, 'dry_run');
  assert.equal(response.body.live_guest_sending_enabled, false);
  assert.equal(response.body.queue_mutated, false);
  assert.equal(response.body.beds24_called, false);
});

test('cron route is GET-only', async () => {
  const handler = createGuestCommunicationsWorkerHandler({ env });
  const response = res();

  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer fixture-cron-secret' }
  }, response);

  assert.equal(response.code, 405);
  assert.equal(response.headers.Allow, 'GET');
});

test('cron route dispatches live mode only when explicitly configured', async () => {
  let inspected = false;
  let delivered = false;
  const liveEnv = {
    ...env,
    BSTE_GUEST_WORKER_MODE: 'live',
    BSTE_GUEST_LIVE_SENDING: 'true'
  };

  const handler = createGuestCommunicationsWorkerHandler({
    env: liveEnv,
    inspect: async () => { inspected = true; return {}; },
    deliver: async () => {
      delivered = true;
      return {
        ok: true,
        mode: 'live',
        live_guest_sending_enabled: true,
        scanned: 0,
        sent: 0,
        failed: 0,
        not_claimed: 0,
        items: []
      };
    }
  });

  const response = res();
  await handler({
    method: 'GET',
    headers: { authorization: 'Bearer fixture-cron-secret' }
  }, response);

  assert.equal(response.code, 200);
  assert.equal(response.body.mode, 'live');
  assert.equal(delivered, true);
  assert.equal(inspected, false);
});
