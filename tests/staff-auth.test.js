import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/staff-session.js';
import { requireStaff, sessionCookie, assertStaffOrigin } from '../lib/staff-auth.js';
import fs from 'node:fs';

process.env.BSTE_STAFF_SUPABASE_URL = 'https://example.invalid/rest/v1/';
process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY = 'test-public-key';
process.env.BSTE_STAFF_ORIGIN = 'https://staff.example.invalid';
const realFetch = globalThis.fetch;
const userId = '11111111-1111-1111-1111-111111111111';
const access = { active: true, user_id: userId, display_name: 'Test Operator', role: 'operations',
  mfa_required: false, mfa_satisfied: false, permissions: ['operations.read', 'operations.write'] };
const session = { access_token: 'test-access', refresh_token: 'never-return-refresh', expires_in: 3600 };
function mock(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    assert.ok(next, 'No unexpected external request');
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), { status: next.status || 200 });
  };
  return calls;
}
function res() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; }, json(data) { this.body = data; return this; } };
}
const login = () => ({ method: 'POST', headers: { origin: process.env.BSTE_STAFF_ORIGIN, 'content-type': 'application/json' }, body: { email: 'staff@example.invalid', password: 'test-password' } });
const cookieReq = () => ({ method: 'GET', headers: { cookie: '__Host-bste_staff=test-access' } });
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.VERCEL_ENV; delete process.env.VERCEL_URL; delete process.env.BSTE_STAFF_PREVIEW_ENABLED; delete process.env.BSTE_STAFF_PREVIEW_SUPABASE_URL; delete process.env.BSTE_STAFF_PRODUCTION_SUPABASE_URL; });

test('anonymous and owner-token access denied without network calls', async () => {
  const calls = mock([]); const response = res();
  await handler({ method: 'GET', headers: {}, query: { token: 'owner-token' } }, response);
  assert.equal(response.code, 401); assert.equal(calls.length, 0);
});
test('cross-origin and malformed origin rejected before provider access', async () => {
  const calls = mock([]);
  for (const origin of ['https://attacker.invalid', 'null', 'https://staff.example.invalid/', undefined]) {
    const req = login(); req.headers.origin = origin;
    const response = res(); await handler(req, response); assert.equal(response.code, 403);
  }
  assert.equal(calls.length, 0);
});
test('preview disabled by default and never trusts wildcard preview hosts', () => {
  process.env.VERCEL_ENV = 'preview'; process.env.VERCEL_URL = 'preview.example.invalid';
  assert.throws(() => assertStaffOrigin(login()), { status: 403 });
  process.env.BSTE_STAFF_PREVIEW_ENABLED = 'true';
  assert.throws(() => assertStaffOrigin(login()), { status: 403 });
  process.env.VERCEL_URL = 'staff.example.invalid';
  assert.doesNotThrow(() => assertStaffOrigin(login()));
});
test('operations login verifies Auth and database access, audits, keeps tokens out of JSON', async () => {
  const calls = mock([{ body: session }, { body: { id: userId } }, { body: access }, { body: true }]);
  const response = res(); await handler(login(), response);
  assert.equal(response.code, 200);
  assert.match(response.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict; Max-Age=3600/);
  assert.equal(response.body.staff.display_name, 'Test Operator');
  assert.doesNotMatch(JSON.stringify(response.body), /test-access|never-return-refresh|test-password/);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(c => c.options.headers.apikey === 'test-public-key'));
  assert.equal(calls[3].options.body, '{"event_name":"application.session_started"}');
});
test('unprovisioned, inactive or terminated session cannot obtain staff cookie', async () => {
  mock([{ body: session }, { body: { id: userId } }, { body: { active: false } }]);
  const response = res(); await handler(login(), response);
  assert.equal(response.code, 403); assert.equal(response.headers['Set-Cookie'], undefined);
});
for (const role of ['administrator', 'finance']) {
  test(`${role} password alone cannot access session data`, async () => {
    mock([{ body: { id: userId } }, { body: { ...access, role, mfa_required: true, permissions: [] } }]);
    const response = res(); await handler(cookieReq(), response); assert.equal(response.code, 403);
  });
  test(`${role} password login is pending MFA and records no successful session`, async () => {
    const calls = mock([{ body: session }, { body: { id: userId, factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] } },
      { body: { ...access, role, mfa_required: true, permissions: [] } }]);
    const response = res(); await handler(login(), response);
    assert.equal(response.code, 200); assert.equal(response.body.mfa_required, true);
    assert.equal(response.body.staff, undefined); assert.equal(calls.length, 3);
    assert.match(response.headers['Set-Cookie'], /Max-Age=300/);
  });
}
test('MFA challenge verifies only an existing verified factor and rechecks database access', async () => {
  const calls = mock([{ body: { id: userId, factors: [{ id: 'factor-1', status: 'verified', factor_type: 'totp' }] } },
    { body: { ...access, role: 'administrator', mfa_required: true, permissions: [] } },
    { body: { id: 'challenge-1' } }, { body: session }, { body: { id: userId } },
    { body: { ...access, role: 'administrator', mfa_required: true, mfa_satisfied: true } }, { body: true }]);
  const req = login(); req.headers.cookie = cookieReq().headers.cookie;
  req.body = { action: 'verify_mfa', factor_id: 'factor-1', code: '123456' };
  const response = res(); await handler(req, response); assert.equal(response.code, 200);
  assert.equal(response.body.staff.role, 'administrator');
  assert.equal(calls[3].options.body, '{"challenge_id":"challenge-1","code":"123456"}');
});
test('unverified or another user factor cannot be challenged', async () => {
  const calls = mock([{ body: { id: userId, factors: [] } }, { body: { ...access, mfa_required: true } }]);
  const req = login(); req.headers.cookie = cookieReq().headers.cookie;
  req.body = { action: 'verify_mfa', factor_id: 'other-factor', code: '123456' };
  const response = res(); await handler(req, response); assert.equal(response.code, 400); assert.equal(calls.length, 2);
});
test('Operations cannot write finance', async () => {
  mock([{ body: { id: userId } }, { body: access }]);
  await assert.rejects(requireStaff(cookieReq(), 'finance.write'), { status: 403 });
});
test('Finance cannot approve arrangements, write operational tasks or read audit', async () => {
  for (const permission of ['arrangements.approve', 'operations.write', 'audit.read']) {
    mock([{ body: { id: userId } }, { body: { ...access, role: 'finance', mfa_required: true,
      mfa_satisfied: true, permissions: ['operations.read', 'finance.read', 'finance.write'] } }]);
    await assert.rejects(requireStaff(cookieReq(), permission), { status: 403 });
  }
});
test('provider error bodies are never disclosed', async () => {
  mock([{ status: 500, body: { token: 'secret-upstream-value' } }]);
  const response = res(); await handler(login(), response);
  assert.equal(response.code, 503); assert.doesNotMatch(JSON.stringify(response), /secret-upstream-value/);
});
test('logout calls provider local-session termination and accepts empty 204 response', async () => {
  const calls = mock([{ body: true }, { status: 204 }]);
  const response = res(); await handler({ method: 'DELETE', headers: { ...login().headers, ...cookieReq().headers } }, response);
  assert.equal(response.code, 200); assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
  assert.match(calls[1].url, /\/auth\/v1\/logout\?scope=local$/); assert.equal(calls[1].options.method, 'POST');
});
test('audit failure does not prevent logout; provider failure is not reported as success', async () => {
  const calls = mock([{ status: 500, body: {} }, { status: 500, body: {} }]);
  const response = res(); await handler({ method: 'DELETE', headers: { ...login().headers, ...cookieReq().headers } }, response);
  assert.equal(response.code, 503); assert.match(response.headers['Set-Cookie'], /Max-Age=0/); assert.equal(calls.length, 2);
});
test('cookie rejects header injection', () => assert.throws(() => sessionCookie('invalid\r\nheader', 30)));
test('no-JavaScript login fails closed: POST only, disabled fieldset, no named credentials', async () => {
  const html = fs.readFileSync(new URL('../public/staff-login.html', import.meta.url), 'utf8');
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)];
  assert.equal(forms.length, 2);
  for (const [, attributes, content] of forms) {
    assert.match(attributes, /method="post"/); assert.match(attributes, /action="\/api\/staff-session"/);
    assert.match(content, /<fieldset\b[^>]*\bdisabled/);
    assert.doesNotMatch(content, /\bname\s*=/);
  }
  const calls = mock([]); const req = login(); req.headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = res(); await handler(req, response); assert.equal(response.code, 415); assert.equal(calls.length, 0);
});
test('staff routes and API responses deny framing', async () => {
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.equal(config.routes[0].src, '/staff-(.*)');
  assert.match(config.routes[0].headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  const response = res(); await handler({ method: 'GET', headers: {} }, response);
  assert.equal(response.headers['X-Frame-Options'], 'DENY');
});
test('all three property mappings are explicit', () => {
  const properties = JSON.parse(fs.readFileSync(new URL('../config/properties.json', import.meta.url)));
  assert.deepEqual(properties.map(p => [p.beds24_property_id, p.beds24_room_id]), [[351452,724919],[352005,726060],[352276,726696]]);
});

test('preview session reads cannot contact production or run without isolation configuration', async () => {
  const calls = mock([]);
  process.env.VERCEL_ENV = 'preview';
  let response = res(); await handler(cookieReq(), response); assert.equal(response.code, 503);
  process.env.BSTE_STAFF_PREVIEW_ENABLED = 'true';
  process.env.BSTE_STAFF_PREVIEW_SUPABASE_URL = 'https://example.invalid';
  process.env.BSTE_STAFF_PRODUCTION_SUPABASE_URL = 'https://example.invalid';
  response = res(); await handler(cookieReq(), response); assert.equal(response.code, 503);
  assert.equal(calls.length, 0);
});
test('missing assurance metadata fails closed', async () => {
  mock([{ body: { id: userId } }, { body: { ...access, mfa_required: undefined } }]);
  const response = res(); await handler(cookieReq(), response); assert.equal(response.code, 503);
});

const privileged = { ...access, role: 'administrator', mfa_required: true, permissions: [] };
const unfinished = { id: 'setup-factor', factor_type: 'totp', status: 'unverified', friendly_name: 'BSTE staff TOTP' };
const enrolled = { ...unfinished, status: 'verified' };
const actionReq = (action, fields = {}) => ({ ...login(), headers: { ...login().headers, ...cookieReq().headers }, body: { action, ...fields } });
test('first privileged password login offers enrollment without granting access', async () => {
  mock([{ body: session }, { body: { id: userId, factors: [] } }, { body: privileged }]);
  const response = res(); await handler(login(), response);
  assert.equal(response.body.mfa_required, true); assert.deepEqual(response.body.factors, []);
  assert.equal(response.body.staff, undefined);
});
test('first-time enrollment returns only own setup data and does not extend pending cookie', async () => {
  const calls = mock([{ body: { id: userId, factors: [] } }, { body: privileged },
    { body: { id: 'setup-factor', totp: { qr_code: '<svg></svg>', secret: 'TEST-SETUP-SECRET' } } }]);
  const response = res(); await handler(actionReq('enroll_mfa'), response);
  assert.equal(response.code, 200); assert.equal(response.body.enrollment.factor_id, 'setup-factor');
  assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.headers['Set-Cookie'], undefined);
  assert.equal(calls[2].options.body, '{"factor_type":"totp","friendly_name":"BSTE staff TOTP"}');
  assert.doesNotMatch(JSON.stringify(response.body), /test-access|never-return-refresh/);
});
test('enrollment retry cleans only own unfinished factor, never another app factor', async () => {
  const calls = mock([{ body: { id: userId, factors: [unfinished, { ...unfinished, id: 'unrelated', friendly_name: 'Other app' }] } },
    { body: privileged }, { status: 204 },
    { body: { id: 'new-factor', totp: { qr_code: '<svg/>', secret: 'TEST-SETUP-SECRET' } } }]);
  const response = res(); await handler(actionReq('enroll_mfa'), response);
  assert.equal(response.code, 200); assert.match(calls[2].url, /\/factors\/setup-factor$/);
  assert.equal(calls[2].options.method, 'DELETE'); assert.equal(calls.length, 4);
});
test('existing verified factor blocks replacement enrollment at AAL1', async () => {
  const calls = mock([{ body: { id: userId, factors: [enrolled] } }, { body: privileged }]);
  const response = res(); await handler(actionReq('enroll_mfa'), response);
  assert.equal(response.code, 403); assert.equal(calls.length, 2);
});
test('an existing non-TOTP verified factor also blocks password-only replacement', async () => {
  const calls = mock([{ body: { id: userId, factors: [{ ...enrolled, factor_type: 'phone' }] } }, { body: privileged }]);
  const response = res(); await handler(actionReq('enroll_mfa'), response);
  assert.equal(response.code, 403); assert.equal(calls.length, 2);
});
test('first-time enrollment verifies code and requires upgraded AAL2 before success', async () => {
  mock([{ body: { id: userId, factors: [unfinished] } }, { body: privileged },
    { body: { id: 'challenge' } }, { body: session }, { body: { id: userId, factors: [enrolled] } },
    { body: { ...privileged, mfa_satisfied: true, permissions: ['operations.read'] } }, { body: true }]);
  const response = res(); await handler(actionReq('verify_mfa', { factor_id: unfinished.id, code: '123456' }), response);
  assert.equal(response.code, 200); assert.equal(response.body.staff.role, 'administrator');
  assert.match(response.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(JSON.stringify(response.body), /secret|qr_code|test-access/);
});
test('wrong enrollment code cannot set a session cookie or record success', async () => {
  const calls = mock([{ body: { id: userId, factors: [unfinished] } }, { body: privileged },
    { body: { id: 'challenge' } }, { status: 422, body: { error: 'Invalid code', secret: 'never-echo' } }]);
  const response = res(); await handler(actionReq('verify_mfa', { factor_id: unfinished.id, code: '999999' }), response);
  assert.notEqual(response.code, 200); assert.equal(response.headers['Set-Cookie'], undefined);
  assert.equal(calls.length, 4); assert.doesNotMatch(JSON.stringify(response.body), /never-echo/);
});
test('provider response that remains AAL1 cannot grant privileged access', async () => {
  mock([{ body: { id: userId, factors: [unfinished] } }, { body: privileged },
    { body: { id: 'challenge' } }, { body: session }, { body: { id: userId, factors: [enrolled] } }, { body: privileged }]);
  const response = res(); await handler(actionReq('verify_mfa', { factor_id: unfinished.id, code: '123456' }), response);
  assert.equal(response.code, 403); assert.equal(response.headers['Set-Cookie'], undefined);
});
test('privileged AAL2 session can pass dashboard access guard', async () => {
  mock([{ body: { id: userId, factors: [enrolled] } },
    { body: { ...privileged, mfa_satisfied: true, permissions: ['operations.read'] } }]);
  const result = await requireStaff(cookieReq()); assert.equal(result.staff.role, 'administrator');
});
test('no self-service recovery, factor deletion or bypass actions exist', async () => {
  const calls = mock([]);
  for (const action of ['recover', 'delete_factor', 'bypass_mfa']) {
    const response = res(); await handler(actionReq(action), response); assert.equal(response.code, 400);
  }
  assert.equal(calls.length, 0);
});
test('anonymous and cross-origin enrollment are denied before any provider call', async () => {
  const calls = mock([]); let req = actionReq('enroll_mfa'); delete req.headers.cookie;
  let response = res(); await handler(req, response); assert.equal(response.code, 401);
  req = actionReq('enroll_mfa'); req.headers.origin = 'https://attacker.invalid';
  response = res(); await handler(req, response); assert.equal(response.code, 403); assert.equal(calls.length, 0);
});
test('missing dedicated staff configuration never falls back to shared project settings', async () => {
  const value = process.env.BSTE_STAFF_SUPABASE_URL;
  const calls = mock([]);
  try {
    delete process.env.BSTE_STAFF_SUPABASE_URL;
    const response = res(); await handler(login(), response); assert.equal(response.code, 503); assert.equal(calls.length, 0);
  } finally { process.env.BSTE_STAFF_SUPABASE_URL = value; }
});

test('a secret/service-role key cannot be used as the staff public key', async () => {
  const original = process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY;
  const calls = mock([]);
  try {
    for (const key of ['sb_secret_test-only', 'header.' + Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url') + '.signature']) {
      process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY = key;
      const response = res(); await handler(login(), response); assert.equal(response.code, 503);
      assert.doesNotMatch(JSON.stringify(response.body), /sb_secret_test|signature/);
    }
    assert.equal(calls.length, 0);
  } finally { process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY = original; }
});
