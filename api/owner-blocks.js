// /api/owner-blocks.js
// Owner calendar blocks API.
// GET    = list owner blocks + booked dates for a property token
// POST   = create a new owner block, conflict-check in Beds24, then sync it
// DELETE = remove an owner block from Beds24 and BSTE storage
// Also sends webhook events to Google Sheets / email workflow.

import fs from 'fs';
import {
  checkBeds24Availability,
  createBeds24OwnerBlock,
  cancelBeds24OwnerBlock,
  clearBeds24LegacyBlackout,
  loadBeds24BookingsForProperty,
  getBeds24Diagnostics
} from './beds24.js';

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
  return Array.isArray(parsed) ? { properties: parsed } : (parsed || { properties: [] });
}

async function getOwnerByToken(token) {
  if (!token) throw new Error('Missing owner token');

  const rows = await supabaseFetch(
    `owner_access?select=property_slug,owner_name,is_active&owner_token=eq.${encodeURIComponent(token)}&is_active=eq.true&limit=1`
  );

  if (!rows || !rows.length) throw new Error('Invalid or inactive owner token');
  return rows[0];
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return String(aStart) < String(bEnd) && String(bStart) < String(aEnd);
}

function sourceLabel(sourceKey) {
  const key = String(sourceKey || '').toLowerCase();
  if (key.includes('airbnb')) return 'Airbnb';
  if (key.includes('booking')) return 'Booking.com';
  if (key.includes('lekke')) return 'Lekkeslaap';
  return 'External calendar';
}

async function sendGoogleWebhook(payload) {
  const webhookUrl = process.env.GOOGLE_WEBHOOK_URL;
  const secret = process.env.BSTE_WEBHOOK_SECRET;

  if (!webhookUrl || !secret) {
    console.log('Google webhook not configured, skipping notification.');
    return { ok: false, skipped: true };
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, ...payload })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google webhook failed: ${response.status} ${text}`);
  }

  return { ok: true, response_text: text };
}

// -------- iCal fallback (kept for resilience while Beds24 is unavailable) --------
async function loadNodeIcal() {
  const mod = await import('node-ical').catch(() => null);
  const lib = mod?.default ?? mod;

  const hasAsync = typeof lib?.async?.fromURL === 'function';
  const hasDirect = typeof lib?.fromURL === 'function';

  async function fromURLCompat(url, options = {}) {
    if (hasAsync) return await lib.async.fromURL(url, options);

    if (hasDirect) {
      return await new Promise((resolve, reject) => {
        lib.fromURL(url, options, (err, data) => err ? reject(err) : resolve(data));
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
      diagnostics: { feeds_total: 0, feeds_ok: 0, feeds_failed: ['Property not found in config'] }
    };
  }

  const feeds = Object.entries(prop.ical || {})
    .filter(([, url]) => Boolean(url))
    .map(([key, url]) => ({ key, url, label: sourceLabel(key) }));

  if (!feeds.length) {
    return { bookings: [], diagnostics: { feeds_total: 0, feeds_ok: 0, feeds_failed: [] } };
  }

  const { fromURLCompat } = await loadNodeIcal();
  const allBookings = [];
  const failed = [];
  let ok = 0;

  for (const feed of feeds) {
    try {
      const data = await fromURLCompat(feed.url);
      const events = Object.values(data || {}).filter(e => e && e.type === 'VEVENT');
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
    } catch {
      failed.push(feed.label);
    }
  }

  allBookings.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

  return {
    bookings: allBookings,
    diagnostics: { feeds_total: feeds.length, feeds_ok: ok, feeds_failed: failed }
  };
}

async function loadBookings(propertySlug) {
  try {
    const bookings = await loadBeds24BookingsForProperty(propertySlug);
    const beds24 = await getBeds24Diagnostics(propertySlug);

    return {
      bookings,
      sync: {
        ok: true,
        provider: 'Beds24',
        detail: 'Live channel inventory connected',
        ...beds24
      }
    };
  } catch (err) {
    const fallback = await loadExternalBookingsForProperty(propertySlug);

    return {
      bookings: fallback.bookings || [],
      sync: {
        ok: false,
        provider: 'Beds24',
        detail: String(err),
        fallback: 'iCal',
        external_calendar_feeds: fallback.diagnostics
      }
    };
  }
}

async function otherOverlappingOwnerBlocks(propertySlug, excludedId, startDate, endDate) {
  const rows = await supabaseFetch(
    `owner_blocks?select=id,start_date,end_date&property_slug=eq.${encodeURIComponent(propertySlug)}&id=neq.${encodeURIComponent(excludedId)}`
  );

  return (rows || []).filter(row => overlaps(startDate, endDate, row.start_date, row.end_date));
}

export default async function handler(req, res) {
  try {
    cors(res);

    if (req.method === 'OPTIONS') return res.status(204).end();

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

      const live = await loadBookings(propertySlug);

      return res.status(200).json({
        ok: true,
        property_slug: propertySlug,
        owner_name: owner.owner_name,
        blocks: ownerBlocks || [],
        bookings: live.bookings || [],
        diagnostics: {
          owner_blocks_count: (ownerBlocks || []).length,
          external_bookings_count: (live.bookings || []).length,
          channel_sync: live.sync
        }
      });
    }

    if (req.method === 'POST') {
      const { start_date, end_date, note = '' } = req.body || {};

      if (!isValidDateString(start_date) || !isValidDateString(end_date)) {
        return res.status(400).json({ ok: false, error: 'Dates must be in YYYY-MM-DD format' });
      }

      if (end_date <= start_date) {
        return res.status(400).json({ ok: false, error: 'End date must be after start date' });
      }

      let availability;
      try {
        availability = await checkBeds24Availability(propertySlug, start_date, end_date);
      } catch (err) {
        return res.status(503).json({
          ok: false,
          error: 'Could not verify live channel availability. No dates were blocked.',
          detail: String(err)
        });
      }

      if (!availability.available) {
        return res.status(409).json({
          ok: false,
          error: 'Those dates cannot be blocked because one or more nights are already unavailable.',
          unavailable_dates: availability.unavailableDates
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

      const block = inserted?.[0] || null;

      if (!block?.id) {
        return res.status(500).json({ ok: false, error: 'Could not create owner block record' });
      }

      let beds24Result;
      try {
        beds24Result = await createBeds24OwnerBlock({
          propertySlug,
          blockId: block.id,
          startDate: start_date,
          endDate: end_date,
          ownerName: owner.owner_name,
          note
        });
      } catch (err) {
        // Roll back the BSTE record: never tell an owner the dates are blocked
        // when the live channel manager did not accept the block.
        await supabaseFetch(
          `owner_blocks?id=eq.${encodeURIComponent(block.id)}&property_slug=eq.${encodeURIComponent(propertySlug)}`,
          { method: 'DELETE', prefer: 'return=minimal' }
        ).catch(() => null);

        return res.status(503).json({
          ok: false,
          error: 'The dates could not be blocked across the booking channels. No owner block was saved.',
          detail: String(err)
        });
      }

      try {
        await sendGoogleWebhook({
          action: 'created',
          property_slug: propertySlug,
          owner_name: owner.owner_name,
          start_date,
          end_date,
          note,
          block_id: block.id,
          beds24_synced: true
        });
      } catch (webhookErr) {
        console.error('Webhook error after create:', String(webhookErr));
      }

      return res.status(200).json({
        ok: true,
        message: 'Owner block created and synced',
        property_slug: propertySlug,
        block,
        sync: {
          ok: true,
          provider: 'Beds24',
          room_id: beds24Result.roomId
        }
      });
    }

    if (req.method === 'DELETE') {
      const id = req.query?.id;

      if (!id) return res.status(400).json({ ok: false, error: 'Missing block id' });

      const existingRows = await supabaseFetch(
        `owner_blocks?select=id,property_slug,start_date,end_date,note&id=eq.${encodeURIComponent(id)}&property_slug=eq.${encodeURIComponent(propertySlug)}&limit=1`
      );

      const existing = existingRows?.[0];
      if (!existing) return res.status(404).json({ ok: false, error: 'Owner block not found' });

      let syncResult;
      try {
        syncResult = await cancelBeds24OwnerBlock(propertySlug, id);

        // Existing BSTE owner blocks created before this API integration were
        // manually blacked out in Beds24 and have no BSTE-linked Beds24 booking.
        if (!syncResult.found) {
          const overlapsOther = await otherOverlappingOwnerBlocks(
            propertySlug,
            id,
            existing.start_date,
            existing.end_date
          );

          if (!overlapsOther.length) {
            await clearBeds24LegacyBlackout(propertySlug, existing.start_date, existing.end_date);
          }
        }
      } catch (err) {
        return res.status(503).json({
          ok: false,
          error: 'The owner block could not be released across the booking channels. It has not been deleted.',
          detail: String(err)
        });
      }

      await supabaseFetch(
        `owner_blocks?id=eq.${encodeURIComponent(id)}&property_slug=eq.${encodeURIComponent(propertySlug)}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      );

      try {
        await sendGoogleWebhook({
          action: 'deleted',
          property_slug: propertySlug,
          owner_name: owner.owner_name,
          start_date: existing.start_date || '',
          end_date: existing.end_date || '',
          note: existing.note || '',
          block_id: existing.id || id,
          beds24_synced: true
        });
      } catch (webhookErr) {
        console.error('Webhook error after delete:', String(webhookErr));
      }

      return res.status(200).json({
        ok: true,
        message: 'Owner block deleted and channels reopened',
        property_slug: propertySlug,
        sync: {
          ok: true,
          provider: 'Beds24',
          legacy_blackout_released: !syncResult.found
        }
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Server error in owner-blocks',
      detail: String(err)
    });
  }
}
