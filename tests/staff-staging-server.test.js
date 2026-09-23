import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { staffLocalHandler } from '../scripts/staff-staging-server.mjs';
process.env.BSTE_STAFF_ORIGIN = 'https://localhost:3443';
function run(url, host = 'localhost:3443') {
  const req = new EventEmitter(); Object.assign(req, { url, method: 'GET', headers: { host } });
  const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, writeHead(n) {this.code=n;}, end(body) {this.body=body;} };
  staffLocalHandler(req,res); return res;
}
test('local runner serves only staff assets with anti-framing and no caching', () => {
  const res = run('/staff-login.html');
  assert.match(res.body.toString(), /Set up your authenticator/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY'); assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('local runner blocks all booking, owner, secret-file and traversal routes', () => {
  for (const url of ['/api/booking-workflow', '/api/owner-bookings', '/.env.staff.local', '/../.env', '/staff-login.html?password=test']) {
    assert.equal(run(url).code, 404);
  }
});
test('local runner rejects untrusted hosts', () => assert.equal(run('/staff-login.html','attacker.invalid').code,403));
