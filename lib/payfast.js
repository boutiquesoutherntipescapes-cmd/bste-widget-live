import crypto from 'crypto';
import dns from 'dns/promises';

const SANDBOX = {
  merchantId: '10000100',
  merchantKey: '46f0cd694581a',
  passphrase: 'jt7NOE43FZPn',
  processUrl: 'https://sandbox.payfast.co.za/eng/process',
  validateUrl: 'https://sandbox.payfast.co.za/eng/query/validate'
};

const LIVE = {
  processUrl: 'https://www.payfast.co.za/eng/process',
  validateUrl: 'https://www.payfast.co.za/eng/query/validate'
};

function phpUrlEncode(value) {
  return encodeURIComponent(String(value ?? '').trim())
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function getPayfastConfig() {
  const mode = String(process.env.PAYFAST_MODE || 'sandbox').toLowerCase();
  const live = mode === 'live';

  const merchantId = live
    ? String(process.env.PAYFAST_MERCHANT_ID || '').trim()
    : String(process.env.PAYFAST_SANDBOX_MERCHANT_ID || SANDBOX.merchantId).trim();

  const merchantKey = live
    ? String(process.env.PAYFAST_MERCHANT_KEY || '').trim()
    : String(process.env.PAYFAST_SANDBOX_MERCHANT_KEY || SANDBOX.merchantKey).trim();

  const passphrase = live
    ? String(process.env.PAYFAST_PASSPHRASE || '').trim()
    : String(process.env.PAYFAST_SANDBOX_PASSPHRASE || SANDBOX.passphrase).trim();

  if (live && (!merchantId || !merchantKey)) {
    throw new Error('PayFast live credentials are not configured');
  }

  return {
    mode,
    live,
    merchantId,
    merchantKey,
    passphrase,
    processUrl: live ? LIVE.processUrl : SANDBOX.processUrl,
    validateUrl: live ? LIVE.validateUrl : SANDBOX.validateUrl
  };
}

export function generatePayfastSignature(fields, passphrase = '') {
  const pairs = [];

  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'signature' || value === undefined || value === null || String(value) === '') continue;
    pairs.push(`${key}=${phpUrlEncode(value)}`);
  }

  if (passphrase) pairs.push(`passphrase=${phpUrlEncode(passphrase)}`);

  return crypto.createHash('md5').update(pairs.join('&')).digest('hex');
}

export function buildPayfastParamString(fields) {
  const pairs = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (key === 'signature' || value === undefined || value === null || String(value) === '') continue;
    pairs.push(`${key}=${phpUrlEncode(value)}`);
  }
  return pairs.join('&');
}

export function signCheckoutState(payload) {
  const secret = String(
    process.env.PAYFAST_STATE_SECRET ||
    process.env.BSTE_WEBHOOK_SECRET ||
    process.env.BEDS24_REFRESH_TOKEN ||
    ''
  ).trim();

  if (!secret) throw new Error('Missing server secret for PayFast checkout state');

  const canonical = [
    payload.bookingId,
    payload.propertySlug,
    payload.arrival,
    payload.departure,
    payload.reference
  ].map(v => String(v || '')).join('|');

  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyCheckoutState(payload, signature) {
  const expected = signCheckoutState(payload);
  const supplied = String(signature || '');
  if (expected.length !== supplied.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(supplied, 'utf8')
  );
}

export async function validatePayfastServer(fields, config = getPayfastConfig()) {
  const body = buildPayfastParamString(fields);
  const response = await fetch(config.validateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'BSTE-PayFast-ITN'
    },
    body
  });

  const text = (await response.text()).trim();
  return response.ok && text === 'VALID';
}

function normaliseIp(value) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

export async function validatePayfastSource(req, config = getPayfastConfig()) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const remote = normaliseIp(forwarded || req.socket?.remoteAddress || '');

  // PayFast documents these as the valid notification hosts.
  const hosts = config.live
    ? ['www.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za']
    : ['sandbox.payfast.co.za'];

  const validIps = new Set();

  for (const host of hosts) {
    const [v4, v6] = await Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => [])
    ]);
    [...v4, ...v6].forEach(ip => validIps.add(normaliseIp(ip)));
  }

  // In sandbox, Vercel/proxy layers can occasionally hide the original source IP.
  // Signature + amount + PayFast server confirmation are still mandatory.
  if (!remote && !config.live) return true;

  return validIps.has(remote);
}

export function buildPayfastFields({
  config = getPayfastConfig(),
  baseUrl,
  bookingId,
  reference,
  amount,
  itemName,
  itemDescription,
  firstName,
  lastName,
  email,
  mobile,
  propertySlug,
  arrival,
  departure,
  adults,
  children,
  state
}) {
  // Order matters for PayFast's custom-integration signature.
  const fields = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: `${baseUrl}/payment-success.html?booking_id=${encodeURIComponent(bookingId)}&property=${encodeURIComponent(propertySlug)}&arrival=${encodeURIComponent(arrival)}&departure=${encodeURIComponent(departure)}&reference=${encodeURIComponent(reference)}&state=${encodeURIComponent(state)}`,
    cancel_url: `${baseUrl}/payment-cancelled.html?booking_id=${encodeURIComponent(bookingId)}&property=${encodeURIComponent(propertySlug)}&arrival=${encodeURIComponent(arrival)}&departure=${encodeURIComponent(departure)}&reference=${encodeURIComponent(reference)}&state=${encodeURIComponent(state)}`,
    notify_url: `${baseUrl}/api/payfast?action=itn`,
    name_first: String(firstName || '').slice(0, 100),
    name_last: String(lastName || '').slice(0, 100),
    email_address: String(email || '').slice(0, 100),
    cell_number: String(mobile || '').slice(0, 100),
    m_payment_id: String(bookingId),
    amount: Number(amount || 0).toFixed(2),
    item_name: String(itemName || 'BSTE Direct Booking').slice(0, 100),
    item_description: String(itemDescription || '').slice(0, 255),
    custom_str1: String(propertySlug || '').slice(0, 255),
    custom_str2: String(arrival || '').slice(0, 255),
    custom_str3: String(departure || '').slice(0, 255),
    custom_str4: `${Number(adults || 0)}:${Number(children || 0)}`,
    custom_str5: String(reference || '').slice(0, 255)
  };

  fields.signature = generatePayfastSignature(fields, config.passphrase);
  return fields;
}
