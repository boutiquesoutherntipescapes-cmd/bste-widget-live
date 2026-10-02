const API_BASE = 'https://beds24.com/api/v2';

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export class Beds24MessagingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'Beds24MessagingError';
    this.code = code;
  }
}

function config(env = process.env) {
  const refreshToken = String(env.BEDS24_REFRESH_TOKEN || '').trim();
  if (!refreshToken) throw new Beds24MessagingError('messaging_not_configured');
  return {
    refreshToken,
    liveEnabled: env.BSTE_GUEST_LIVE_SENDING === 'true'
  };
}

export async function getBeds24MessagingAccessToken({
  fetcher = fetch,
  env = process.env,
  force = false,
  now = Date.now()
} = {}) {
  const { refreshToken } = config(env);

  if (!force && cachedToken && now < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }

  let response;
  try {
    response = await fetcher(API_BASE + '/authentication/token', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        refreshToken
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Beds24MessagingError('authentication_unavailable');
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.token) {
    throw new Beds24MessagingError('authentication_failed');
  }

  cachedToken = String(data.token);
  cachedTokenExpiresAt =
    now + Math.max(60, Number(data.expiresIn || 3600)) * 1000;

  return cachedToken;
}

export async function sendBeds24GuestMessage({
  bookingId,
  route,
  message,
  fetcher = fetch,
  env = process.env
}) {
  const cfg = config(env);

  if (!cfg.liveEnabled) {
    throw new Beds24MessagingError('live_guest_sending_disabled');
  }

  if (route !== 'beds24_bookingcom') {
    throw new Beds24MessagingError('unsupported_live_route');
  }

  const id = Number(bookingId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Beds24MessagingError('invalid_booking_id');
  }

  const text = String(message || '').trim();
  if (!text || text.length > 10000) {
    throw new Beds24MessagingError('invalid_message');
  }

  const token = await getBeds24MessagingAccessToken({ fetcher, env });

  let response;
  try {
    response = await fetcher(API_BASE + '/bookings/messages', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{
        bookingId: id,
        message: text
      }]),
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Beds24MessagingError('provider_outcome_uncertain');
  }

  let data = null;
  try { data = await response.json(); } catch {}

  if (!response.ok) {
    throw new Beds24MessagingError('provider_rejected_message');
  }

  const result = Array.isArray(data) ? data[0] : null;
  if (!result?.success) {
    throw new Beds24MessagingError('provider_rejected_message');
  }

  return {
    ok: true,
    provider: 'beds24',
    provider_result: 'accepted',
    booking_id: id,
    route
  };
}

export function resetBeds24MessagingTokenCacheForTests() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
}
