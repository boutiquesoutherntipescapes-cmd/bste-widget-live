import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Beds24MessagingError,
  getBeds24MessagingAccessToken,
  resetBeds24MessagingTokenCacheForTests,
  sendBeds24GuestMessage
} from '../lib/beds24-messaging.js';

const baseEnv = {
  BEDS24_REFRESH_TOKEN: 'fixture-refresh-token',
  BSTE_GUEST_LIVE_SENDING: 'false'
};

function fakeResponse({
  ok = true,
  status = 200,
  json = null
} = {}) {
  return {
    ok,
    status,
    async json() {
      return json;
    }
  };
}

test('live messaging is hard-disabled by default', async () => {
  resetBeds24MessagingTokenCacheForTests();

  let called = false;

  await assert.rejects(
    sendBeds24GuestMessage({
      bookingId: 93636297,
      route: 'beds24_bookingcom',
      message: 'fixture',
      env: baseEnv,
      fetcher: async () => {
        called = true;
        throw new Error('must not call provider');
      }
    }),
    error =>
      error instanceof Beds24MessagingError &&
      error.code === 'live_guest_sending_disabled'
  );

  assert.equal(called, false);
});

test('refresh token is exchanged without sending a guest message', async () => {
  resetBeds24MessagingTokenCacheForTests();

  const token = await getBeds24MessagingAccessToken({
    env: baseEnv,
    fetcher: async (url, options) => {
      assert.equal(
        url,
        'https://beds24.com/api/v2/authentication/token'
      );

      assert.equal(
        options.headers.refreshToken,
        'fixture-refresh-token'
      );

      return fakeResponse({
        json: {
          token: 'fixture-access-token',
          expiresIn: 3600
        }
      });
    }
  });

  assert.equal(token, 'fixture-access-token');
});

test('Booking.com live route posts documented Beds24 message payload', async () => {
  resetBeds24MessagingTokenCacheForTests();

  const calls = [];

  const result = await sendBeds24GuestMessage({
    bookingId: 93636297,
    route: 'beds24_bookingcom',
    message: 'Departure reminder fixture',
    env: {
      ...baseEnv,
      BSTE_GUEST_LIVE_SENDING: 'true'
    },
    fetcher: async (url, options) => {
      calls.push({ url, options });

      if (url.endsWith('/authentication/token')) {
        return fakeResponse({
          json: {
            token: 'fixture-access-token',
            expiresIn: 3600
          }
        });
      }

      if (url.endsWith('/bookings/messages')) {
        return fakeResponse({
          json: [
            {
              success: true
            }
          ]
        });
      }

      throw new Error('Unexpected request');
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'beds24');

  assert.equal(calls.length, 2);

  assert.equal(
    calls[1].url,
    'https://beds24.com/api/v2/bookings/messages'
  );

  assert.equal(
    calls[1].options.method,
    'POST'
  );

  assert.equal(
    calls[1].options.headers.token,
    'fixture-access-token'
  );

  assert.deepEqual(
    JSON.parse(calls[1].options.body),
    [
      {
        bookingId: 93636297,
        message: 'Departure reminder fixture'
      }
    ]
  );
});

test('first live release refuses unsupported OTA routes', async () => {
  resetBeds24MessagingTokenCacheForTests();

  await assert.rejects(
    sendBeds24GuestMessage({
      bookingId: 93636297,
      route: 'beds24_airbnb',
      message: 'fixture',
      env: {
        ...baseEnv,
        BSTE_GUEST_LIVE_SENDING: 'true'
      }
    }),
    error =>
      error instanceof Beds24MessagingError &&
      error.code === 'unsupported_live_route'
  );
});

test('network loss after outbound POST becomes uncertain, not blindly retryable', async () => {
  resetBeds24MessagingTokenCacheForTests();

  let calls = 0;

  await assert.rejects(
    sendBeds24GuestMessage({
      bookingId: 93636297,
      route: 'beds24_bookingcom',
      message: 'fixture',
      env: {
        ...baseEnv,
        BSTE_GUEST_LIVE_SENDING: 'true'
      },
      fetcher: async url => {
        calls += 1;

        if (url.endsWith('/authentication/token')) {
          return fakeResponse({
            json: {
              token: 'fixture-access-token',
              expiresIn: 3600
            }
          });
        }

        throw new Error('connection lost');
      }
    }),
    error =>
      error instanceof Beds24MessagingError &&
      error.code === 'provider_outcome_uncertain'
  );

  assert.equal(calls, 2);
});
