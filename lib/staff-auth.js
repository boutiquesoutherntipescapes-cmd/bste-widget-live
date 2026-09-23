// Separate from owner URL tokens and privileged Supabase service-role access.
const COOKIE = '__Host-bste_staff';

export class StaffAuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function config() {
  const url = String(process.env.BSTE_STAFF_SUPABASE_URL || '').trim()
    .replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
  const key = process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY;
  let validUrl = false;
  try { const parsed = new URL(url); validUrl = parsed.protocol === 'https:' && parsed.origin === url; } catch { /* fail closed */ }
  let privilegedKey = String(key || '').startsWith('sb_secret_');
  if (String(key || '').split('.').length === 3) {
    try { privilegedKey ||= JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role !== 'anon'; }
    catch { privilegedKey = true; }
  }
  if (!validUrl || !key || privilegedKey) {
    throw new StaffAuthError(503, 'Staff authentication is not configured');
  }
  if (process.env.VERCEL_ENV === 'preview' && (
    process.env.BSTE_STAFF_PREVIEW_ENABLED !== 'true' ||
    process.env.BSTE_STAFF_PREVIEW_SUPABASE_URL !== url ||
    !process.env.BSTE_STAFF_PRODUCTION_SUPABASE_URL ||
    process.env.BSTE_STAFF_PRODUCTION_SUPABASE_URL.replace(/\/+$/, '') === url)) {
    throw new StaffAuthError(503, 'Isolated preview authentication is not configured');
  }
  return { url, key };
}

export function assertStaffOrigin(req) {
  const allowed = process.env.BSTE_STAFF_ORIGIN;
  let valid = false;
  try {
    const parsed = new URL(allowed);
    valid = parsed.protocol === 'https:' && parsed.origin === allowed && !parsed.username && !parsed.password;
    // Preview must opt into an isolated project AND its exact deployment origin.
    if (process.env.VERCEL_ENV === 'preview') {
      valid = valid && process.env.BSTE_STAFF_PREVIEW_ENABLED === 'true'
        && allowed === `https://${process.env.VERCEL_URL}`;
    }
  } catch { /* fail closed */ }
  if (!valid || req.headers?.origin !== allowed) {
    throw new StaffAuthError(403, 'Request origin is not allowed');
  }
}

async function request(path, token, options = {}) {
  const { url, key } = config();
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      ...options,
      headers: {
        apikey: key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
  } catch {
    throw new StaffAuthError(503, 'Staff authentication is temporarily unavailable');
  }
  if (!response.ok) {
    // Never propagate upstream response bodies, tokens, passwords or SQL details.
    if ([400, 401, 403, 422].includes(response.status)) {
      throw new StaffAuthError(401, 'Sign-in or verification failed. Check your details or current authenticator code.');
    }
    throw new StaffAuthError(503, 'Staff authentication is temporarily unavailable');
  }
  if (response.status === 204) return null;
  try { return await response.json(); } catch {
    throw new StaffAuthError(503, 'Invalid authentication response');
  }
}

export async function verifyStaffToken(token, allowPending = false) {
  if (!token || token.length > 8192) throw new StaffAuthError(401, 'Sign in required');
  const user = await request('/auth/v1/user', token);
  if (!user?.id) throw new StaffAuthError(401, 'Sign in required');
  // Database verifies Auth session existence, active staff and required assurance.
  const access = await request('/rest/v1/rpc/ops_staff_access', token, {
    method: 'POST', body: '{}'
  });
  if (!access?.active || access.user_id !== user.id) {
    throw new StaffAuthError(403, 'Active staff session required');
  }
  if (typeof access.mfa_required !== 'boolean' || typeof access.mfa_satisfied !== 'boolean') {
    throw new StaffAuthError(503, 'Authentication assurance unavailable');
  }
  if (access.mfa_required && !access.mfa_satisfied) {
    if (!allowPending) throw new StaffAuthError(403, 'Multi-factor authentication required');
    const factors = (user.factors || []).filter(f => f.status === 'verified' && f.factor_type === 'totp');
    return { pending: true, factors: factors.map(f => ({ id: f.id })),
      hasVerifiedFactor: (user.factors || []).some(f => f.status === 'verified'),
      unverified: (user.factors || []).filter(f => f.status === 'unverified'
        && f.factor_type === 'totp' && f.friendly_name === 'BSTE staff TOTP').map(f => ({ id: f.id })) };

  }
  if (!Array.isArray(access.permissions)) throw new StaffAuthError(503, 'Permissions unavailable');
  return { user_id: user.id, display_name: access.display_name, role: access.role,
    permissions: access.permissions };
}

export function staffToken(req) {
  const cookies = String(req.headers?.cookie || '').split(';').map(s => s.trim());
  return cookies.find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}

export async function requireStaff(req, permission = 'operations.read') {
  const token = staffToken(req);
  const staff = await verifyStaffToken(token);
  if (!staff.permissions.includes(permission)) throw new StaffAuthError(403, 'Permission denied');
  return { staff, token }; // token stays server-side; never serialize this wrapper.
}

export async function signInStaff(email, password) {
  if (typeof email !== 'string' || email.length > 254 || !email.includes('@') ||
      typeof password !== 'string' || !password || password.length > 1024) {
    throw new StaffAuthError(400, 'Email and password required');
  }
  const session = await request('/auth/v1/token?grant_type=password', null, {
    method: 'POST', body: JSON.stringify({ email, password })
  });
  if (!session?.access_token || !Number.isFinite(session.expires_in) || session.expires_in <= 0) {
    throw new StaffAuthError(503, 'Invalid authentication response');
  }
  const staff = await verifyStaffToken(session.access_token, true);
  if (staff.pending) return { mfa_required: true, factors: staff.factors,
    token: session.access_token, seconds: Math.min(session.expires_in, 300) };
  await request('/rest/v1/rpc/ops_record_session', session.access_token, {
    method: 'POST', body: JSON.stringify({ event_name: 'application.session_started' })
  });
  // No refresh token is stored or returned. Re-login on expiry in this foundation.
  return { staff, token: session.access_token, seconds: Math.min(session.expires_in, 3600) };
}

export async function enrollStaffMfa(token) {
  const pending = await verifyStaffToken(token, true);
  // Password-only sessions cannot replace an existing verified authenticator.
  if (!pending.pending || pending.hasVerifiedFactor) {
    throw new StaffAuthError(403, 'Use your existing authenticator or the staff recovery process');
  }
  // Setup secrets are returned once by Supabase. Restart only our own unfinished
  // enrollments; never delete a verified factor or a factor owned by another app.
  for (const factor of pending.unverified) {
    await request(`/auth/v1/factors/${encodeURIComponent(factor.id)}`, token, { method: 'DELETE' });
  }
  const enrollment = await request('/auth/v1/factors', token, {
    method: 'POST', body: JSON.stringify({ factor_type: 'totp', friendly_name: 'BSTE staff TOTP' })
  });
  if (!enrollment?.id || typeof enrollment.totp?.qr_code !== 'string'
      || typeof enrollment.totp?.secret !== 'string') {
    throw new StaffAuthError(503, 'Authenticator setup could not be completed');
  }
  // The setup secret must reach the enrolling user's browser, but is never
  // persisted, logged, placed in a URL, or returned again after verification.
  return { factor_id: enrollment.id, qr_code: enrollment.totp.qr_code, secret: enrollment.totp.secret };
}

export async function verifyStaffMfa(token, factorId, code) {
  const pending = await verifyStaffToken(token, true);
  const eligible = pending.pending && (pending.factors.some(f => f.id === factorId)
    || (!pending.hasVerifiedFactor && pending.unverified.some(f => f.id === factorId)));
  if (!eligible || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new StaffAuthError(400, 'Your authenticator and six-digit code are required');
  }
  const path = `/auth/v1/factors/${encodeURIComponent(factorId)}`;
  const challenge = await request(`${path}/challenge`, token, { method: 'POST', body: '{}' });
  const session = await request(`${path}/verify`, token, {
    method: 'POST', body: JSON.stringify({ challenge_id: challenge.id, code })
  });
  if (!session.access_token || !Number.isFinite(session.expires_in) || session.expires_in <= 0) {
    throw new StaffAuthError(503, 'Invalid authentication response');
  }
  const staff = await verifyStaffToken(session.access_token);
  await request('/rest/v1/rpc/ops_record_session', session.access_token, {
    method: 'POST', body: JSON.stringify({ event_name: 'application.session_started' })
  });
  return { staff, token: session.access_token, seconds: Math.min(session.expires_in, 3600) };
}

export async function recordSignOut(token) {
  // This is an application report, not proof of a provider logout.
  // An audit outage must never prevent the provider termination request.
  try {
    await request('/rest/v1/rpc/ops_record_session', token, {
      method: 'POST', body: JSON.stringify({ event_name: 'application.sign_out_requested' })
    });
  } catch { /* Provider Auth logs are the authoritative authentication history. */ }
  await request('/auth/v1/logout?scope=local', token, { method: 'POST' });
}

export function sessionCookie(token = '', seconds = 0) {
  if (/[\s;,\r\n]/.test(token)) throw new StaffAuthError(503, 'Invalid session');
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(seconds)}`;
}
