// /api/owner-blocks-ics.js
// Generates a private iCal feed of owner blocks for one property.
// External platforms like Airbnb / Booking.com can import this feed.

function cleanSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/g, '');
}

function getSupabase() {
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  return { url, key };
}

async function supabaseFetch(path) {
  const { url, key } = getSupabase();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`);
  }

  if (!text) return [];

  return JSON.parse(text);
}

async function getOwnerByToken(token) {
  if (!token) {
    throw new Error('Missing owner token');
  }

  const rows = await supabaseFetch(
    `owner_access?select=property_slug,owner_name,is_active&owner_token=eq.${encodeURIComponent(token)}&is_active=eq.true&limit=1`
  );

  if (!rows || !rows.length) {
    throw new Error('Invalid or inactive owner token');
  }

  return rows[0];
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function ymdToIcsDate(value) {
  return String(value || '').replace(/-/g, '');
}

function buildIcs({ property_slug, owner_name, blocks }) {
  const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Boutique Southern Tip Escapes//Owner Blocks//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(owner_name || property_slug)} Owner Blocks`
  ];

  for (const block of blocks || []) {
    const uid = `${block.id || block.start_date + '-' + block.end_date}@bste-owner-blocks`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(uid)}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${ymdToIcsDate(block.start_date)}`,
      `DTEND;VALUE=DATE:${ymdToIcsDate(block.end_date)}`,
      'SUMMARY:Blocked',
      'DESCRIPTION:Owner block',
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  return lines.join('\r\n');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).send('Method not allowed');
    }

    const token = req.query?.token;
    const owner = await getOwnerByToken(token);

    const blocks = await supabaseFetch(
      `owner_blocks?select=id,start_date,end_date,block_type,note&property_slug=eq.${encodeURIComponent(owner.property_slug)}&order=start_date.asc`
    );

    const ics = buildIcs({
      property_slug: owner.property_slug,
      owner_name: owner.owner_name,
      blocks
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `inline; filename="${owner.property_slug}-owner-blocks.ics"`);

    return res.status(200).send(ics);

  } catch (err) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).send(`Owner blocks iCal error: ${String(err)}`);
  }
}
