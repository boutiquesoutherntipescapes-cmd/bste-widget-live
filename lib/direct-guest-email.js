// Gmail API delivery. This module accepts only the recipient from an atomic
// database claim; the worker never accepts a recipient from an HTTP request.
export const DIRECT_GUEST_SENDER = 'boutiquesoutherntipescapes@gmail.com';
export class DirectEmailError extends Error {
  constructor(code) { super(code); this.name = 'DirectEmailError'; this.code = code; }
}
export function validGuestEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value);
}
export function directEmailConfig(env = process.env) {
  const clientId = String(env.BSTE_GMAIL_CLIENT_ID || '').trim();
  const clientSecret = String(env.BSTE_GMAIL_CLIENT_SECRET || '').trim();
  const refreshToken = String(env.BSTE_GMAIL_REFRESH_TOKEN || '').trim();
  if (!clientId || !clientSecret || !refreshToken) throw new DirectEmailError('messaging_not_configured');
  return {clientId, clientSecret, refreshToken};
}
export async function sendDirectGuestEmail({communicationId, recipient, subject, message, fetcher = fetch, env = process.env}) {
  if (env.BSTE_GUEST_LIVE_SENDING !== 'true' || env.BSTE_GUEST_DIRECT_SENDING !== 'true') {
    throw new DirectEmailError('messaging_not_configured');
  }
  const cfg = directEmailConfig(env);
  if (!validGuestEmail(recipient) || !/^[a-f0-9-]{36}$/i.test(communicationId || '')
      || typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject)
      || typeof message !== 'string' || !message.trim() || message.length > 10000) {
    throw new DirectEmailError('render_failed');
  }
  let auth;
  try {
    auth = await fetcher('https://oauth2.googleapis.com/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:cfg.clientId, client_secret:cfg.clientSecret, refresh_token:cfg.refreshToken, grant_type:'refresh_token'}).toString(),
      redirect:'error', signal:AbortSignal.timeout(15000)
    });
  } catch { throw new DirectEmailError('authentication_unavailable'); }
  const token = await auth.json().catch(() => null);
  if (!auth.ok || !token?.access_token) throw new DirectEmailError('authentication_failed');
  const body64 = Buffer.from(message, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  const subjectChars = [...subject];
  const encodedSubject = [];
  for (let i = 0; i < subjectChars.length; i += 11) encodedSubject.push('=?UTF-8?B?' + Buffer.from(subjectChars.slice(i,i+11).join('')).toString('base64') + '?=');
  const raw = Buffer.from([
    `From: Boutique Southern Tip Escapes <${DIRECT_GUEST_SENDER}>`,
    `Reply-To: ${DIRECT_GUEST_SENDER}`, `To: ${recipient}`,
    `Subject: ${encodedSubject.join('\r\n ')}`,
    `Message-ID: <bste-${communicationId}@gmail.com>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', body64
  ].join('\r\n'), 'utf8').toString('base64url');
  let response;
  try {
    response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(DIRECT_GUEST_SENDER)}/messages/send`, {
      method:'POST', headers:{Authorization:`Bearer ${token.access_token}`, 'Content-Type':'application/json'},
      body:JSON.stringify({raw}), redirect:'error', signal:AbortSignal.timeout(15000)
    });
  } catch { throw new DirectEmailError('provider_outcome_uncertain'); }
  if (!response.ok) throw new DirectEmailError(response.status >= 500 ? 'provider_outcome_uncertain' : 'provider_rejected_message');
  const result = await response.json().catch(() => null);
  if (!result?.id || typeof result.id !== 'string') throw new DirectEmailError('provider_outcome_uncertain');
  // Gmail does not guarantee deduplication by Message-ID. Retain the database
  // claim permanently on uncertain outcomes; never retry automatically.
  return {ok:true, provider:'gmail', provider_message_id:result.id};
}
