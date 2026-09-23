// Local staff-only HTTPS runner. No booking APIs, workers or environment auto-loading.
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import handler from '../api/staff-session.js';
import operationsHandler from '../api/staff-operations.js';
import { requireStaff } from '../lib/staff-auth.js';
import { operationsConfig } from '../lib/operations-store.js';

export async function staffLocalHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  const configured = new URL(process.env.BSTE_STAFF_ORIGIN);
  if (req.headers.host !== configured.host) { res.writeHead(403); res.end('Host not allowed'); return; }
  // Exact allowlist deliberately excludes all booking/owner/automation endpoints.
  if (['/api/staff-session','/api/staff-operations'].includes(req.url)) {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= 8192) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size > 8192) { res.writeHead(413); res.end(); return; }
      try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }
      res.status = code => { res.statusCode = code; return res; };
      res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
      try { await (req.url === '/api/staff-session' ? handler : operationsHandler)(req, res); }
      catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    return;
  }
  if (req.url === '/staff-dashboard.html') {
    try { operationsConfig(); await requireStaff(req); }
    catch { res.writeHead(303, {Location:'/staff-login.html'}); res.end(); return; }
  }
  const pages = {
    '/staff-dashboard.html': ['staff-dashboard.html','text/html; charset=utf-8'],
    '/staff-dashboard.js': ['staff-dashboard.js','text/javascript; charset=utf-8'],
    '/staff-dashboard.css': ['staff-dashboard.css','text/css; charset=utf-8'],
    '/': ['staff-login.html', 'text/html; charset=utf-8'],
    '/staff-login.html': ['staff-login.html', 'text/html; charset=utf-8'],
    '/staff-login.js': ['staff-login.js', 'text/javascript; charset=utf-8']
  };
  const page = pages[req.url];
  if (req.method !== 'GET' || !page) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', page[1]);
  res.end(fs.readFileSync(new URL(`../public/${page[0]}`, import.meta.url)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.BSTE_STAFF_ENV !== 'staging' || process.env.VERCEL_ENV) throw new Error();
    const origin = new URL(process.env.BSTE_STAFF_ORIGIN);
    if (origin.origin !== 'https://localhost:3443') throw new Error();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(process.env.BSTE_STAFF_SUPABASE_URL || '')
        || !process.env.BSTE_STAFF_SUPABASE_PUBLIC_KEY) throw new Error();
    const server = https.createServer({
      key: fs.readFileSync(process.env.BSTE_STAFF_TLS_KEY_FILE),
      cert: fs.readFileSync(process.env.BSTE_STAFF_TLS_CERT_FILE)
    }, staffLocalHandler);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on('error', () => { console.error('Staff HTTPS server could not start. Check local configuration.'); process.exitCode = 1; });
    server.listen(3443, '127.0.0.1', () => console.log('Local staff staging sign-in: https://localhost:3443/staff-login.html'));
  } catch {
    console.error('Staff staging requires the isolated project URL/public key, HTTPS localhost origin and local TLS certificate files. See docs/staff-staging-setup.md.');
    process.exitCode = 1;
  }
}
