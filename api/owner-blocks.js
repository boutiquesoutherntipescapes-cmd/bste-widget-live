// /api/owner-blocks.js
// Owner calendar blocks API.
// GET    = list owner blocks + external booked dates for a property token
// POST   = create a new owner block
// DELETE = delete an owner block

import fs from 'fs';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

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

async function supabaseFetch(path, options = {}) {
  const { url, key } = getSupabase();

  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || ''
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`);
  }

  if (!text) return null;

  return JSON.parse(text);
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return { properties: parsed };
  }

  return parsed || { properties: [] };
}

async function getOwnerByToken(token) {
  if (!token) {
    throw new Error('Missing owner token');
  }

  const safeToken = encodeURIComponent(token);

  const rows = await supabaseFetch(
    `owner_access?select=property_slug,owner_name,is_active&owner_token=eq.${safeToken}&is_active=eq.true&limit=1`
  );

  if (!rows || !rows.length) {
    throw new Error('Invalid or inactive owner token');
  }

  return rows[0];
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sourceLabel(sourceKey) {
  const key = String(sourceKey || '').toLowerCase();

  if (key.includes('airbnb')) return 'Airbnb';
  if (key.includes('booking')) return 'Booking.com';
  if (key.includes('lekke')) return 'Lekkeslaap';

  return 'External calendar';
}

// version-agnostic node-ical loader
async function loadNodeIcal() {
  const mod = await import('node-ical').catch(() => null);
  const lib = mod?.default ?? mod;

  const hasAsync = typeof lib?.async?.fromURL === 'function';
  const hasDirect = typeof lib?.fromURL === 'function';

  async function fromURLCompat(url, options = {}) {
    if (hasAsync) {
      return await lib.async.fromURL(url, options);
    }

    if (hasDirect) {
      return await new Promise((resolve, reject) => {
        lib.fromURL(url, options, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
    }

    throw new Error('node-ical: no fromURL found');
  }

  return { fromURLCompat };
}

async function loadExternalBookingsForProperty(propertySlug) {
  const cfg = getConfig();
  const prop = (cfg.properties || []).find(p => p.property_slug === propertySlug);

  if (!prop) {
    return {
      bookings: [],
      diagnostics: {
        feeds_total: 0,
        feeds_ok: 0,
        feeds_failed: ['Property not found in config']
      }
    };
  }

  const feeds = Object.entries(prop.ical || {})
    .filter(([key, url]) => Boolean(url))
    .map(([key, url]) => ({
      key,
      url,
      label: sourceLabel(key)
    }));

  if (!feeds.length) {
    return {
      bookings: [],
      diagnostics: {
        feeds_total: 0,
        feeds_ok: 0,
        feeds_failed: []
      }
    };
  }

  const { fromURLCompat } = await loadNodeIcal();

  const allBookings = [];
  const failed = [];
  let ok = 0;

  for (const feed of feeds) {
    try {
      const data = await fromURLCompat(feed.url);

      const events = Object.values(data || {})
        .filter(e => e && e.type === 'VEVENT');

      ok++;

      for (const ev of events) {
        if (!ev.start || !ev.end) continue;

        allBookings.push({
          id: `${feed.key}-${dateOnly(ev.start)}-${dateOnly(ev.end)}`,
          property_slug: propertySlug,
          start_date: dateOnly(ev.start),
          end_date: dateOnly(ev.end),
          type: 'external_booking',
          label: 'Booked',
          source: feed.label,
          note: 'Booked'
        });
      }

    } catch (err) {
      failed.push(feed.label);
    }
  }

  allBookings.sort((a, b) => {
    if (a.start_date < b.start_date) return -1;
    if (a.start_date > b.start_date) return 1;
    return 0;
  });

  return {
    bookings: allBookings,
    diagnostics: {
      feeds_total: feeds.length,
      feeds_ok: ok,
      feeds_failed: failed
    }
  };
}

export default async function handler(req, res) {
  try {
    cors(res);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const token =
      req.method === 'GET' || req.method === 'DELETE'
        ? req.query?.token
        : req.body?.token;

    const owner = await getOwnerByToken(token);
    const propertySlug = owner.property_slug;

    if (req.method === 'GET') {
      const ownerBlocks = await supabaseFetch(
        `owner_blocks?select=id,property_slug,start_date,end_date,block_type,note,created_by,created_at&property_slug=eq.${encodeURIComponent(propertySlug)}&order=start_date.asc`
      );

      const external = await loadExternalBookingsForProperty(propertySlug);

      return res.status(200).json({
        ok: true,
        property_slug: propertySlug,
        owner_name: owner.owner_name,

        // Owner-created blocks. These can be deleted by the owner.
        blocks: ownerBlocks || [],

        // Airbnb / Booking.com / Lekkeslaap booked dates.
        // These are read-only and contain no guest information.
        bookings: external.bookings || [],

        diagnostics: {
          owner_blocks_count: (ownerBlocks || []).length,
          external_bookings_count: (external.bookings || []).length,
          external_calendar_feeds: external.diagnostics
        }
      });
    }

    if (req.method === 'POST') {
      const { start_date, end_date, note = '' } = req.body || {};

      if (!isValidDateString(start_date) || !isValidDateString(end_date)) {
        return res.status(400).json({
          ok: false,
          error: 'Dates must be in YYYY-MM-DD format'
        });
      }

      if (end_date <= start_date) {
        return res.status(400).json({
          ok: false,
          error: 'End date must be after start date'
        });
      }

      const inserted = await supabaseFetch('owner_blocks?select=*', {
        method: 'POST',
        prefer: 'return=representation',
        body: {
          property_slug: propertySlug,
          start_date,
          end_date,
          block_type: 'owner_block',
          note,
          created_by: 'owner'
        }
      });

      return res.status(200).json({
        ok: true,
        message: 'Owner block created',
        property_slug: propertySlug,
        block: inserted?.[0] || null
      });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: 'Missing block id'
        });
      }

      await supabaseFetch(
        `owner_blocks?id=eq.${encodeURIComponent(id)}&property_slug=eq.${encodeURIComponent(propertySlug)}`,
        {
          method: 'DELETE',
          prefer: 'return=minimal'
        }
      );

      return res.status(200).json({
        ok: true,
        message: 'Owner block deleted',
        property_slug: propertySlug
      });
    }

    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Server error in owner-blocks',
      detail: String(err)
    });
  }
}
