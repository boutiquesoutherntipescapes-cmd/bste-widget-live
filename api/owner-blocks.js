// /api/owner-blocks.js
// Owner calendar blocks API.
// GET    = list owner blocks + booked dates for a property token
// POST   = create a new owner block, conflict-check in Beds24, then sync it
// DELETE = remove an owner block from Beds24 and BSTE storage
// Also sends webhook events to Google Sheets / email workflow.

import fs from 'fs';
import {
  checkBeds24Availability,
  setBeds24Blackout,
  clearBeds24Blackout,
  loadBeds24BookingsForProperty,
  getBeds24Diagnostics,
  getBeds24BlackoutDates
} from '../lib/beds24.js';

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

function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function getPropertyConfig(propertySlug) {
  const cfg = getConfig();
  return (cfg.properties || []).find(p => p.property_slug === propertySlug) || null;
}

function getPrepBufferNights(propertySlug) {
  const cfg = getConfig();
  const prop = (cfg.properties || []).find(p => p.property_slug === propertySlug);
  return Math.max(0, Number(prop?.prep_buffer_nights ?? 1));
}

function bufferedRange(startDate, endDate, bufferNights) {
  const n = Math.max(0, Number(bufferNights || 0));
  return {
    start: addDays(startDate, -n),
    end: addDays(endDate, n)
  };
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

async function otherOverlappingOwnerBlocks(propertySlug, excludedId, startDate, endDate, bufferNights) {
  const rows = await supabaseFetch(
    `owner_blocks?select=id,start_date,end_date&property_slug=eq.${encodeURIComponent(propertySlug)}&id=neq.${encodeURIComponent(excludedId)}`
  );

  const target = bufferedRange(startDate, endDate, bufferNights);

  return (rows || []).filter(row => {
    const other = bufferedRange(row.start_date, row.end_date, bufferNights);
    return overlaps(target.start, target.end, other.start, other.end);
  });
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
      const prop = getPropertyConfig(propertySlug);
      const prepBufferNights = getPrepBufferNights(propertySlug);
      const today = new Date().toISOString().slice(0, 10);

      // Owner blocks are stored in Supabase, but the actual channel protection is
      // a Beds24 blackout. Verify future owner blocks against the live Beds24
      // calendar so the dashboard can flag any drift instead of assuming sync.
      const futureBlocks = (ownerBlocks || []).filter(block => String(block.end_date || '') >= today);
      let verifiedBlocks = ownerBlocks || [];
      let ownerSync = {
        checked: false,
        verified_count: 0,
        attention_count: 0
      };

      if (live.sync?.ok === true && futureBlocks.length) {
        try {
          const protectedRanges = futureBlocks.map(block => bufferedRange(
            block.start_date,
            block.end_date,
            prepBufferNights
          ));

          const queryStart = protectedRanges
            .map(range => range.start)
            .sort()[0];

          const queryLastNight = protectedRanges
            .map(range => addDays(range.end, -1))
            .sort()
            .slice(-1)[0];

          const blackout = await getBeds24BlackoutDates(
            propertySlug,
            queryStart,
            queryLastNight
          );

          verifiedBlocks = (ownerBlocks || []).map(block => {
            if (String(block.end_date || '') < today) {
              return { ...block, sync_verified: null };
            }

            const protectedRange = bufferedRange(
              block.start_date,
              block.end_date,
              prepBufferNights
            );

            const missingDates = [];
            for (
              let d = protectedRange.start;
              d < protectedRange.end;
              d = addDays(d, 1)
            ) {
              if (!blackout.blackoutDates.has(d)) missingDates.push(d);
            }

            return {
              ...block,
              prep_start_date: protectedRange.start,
              prep_end_date: protectedRange.end,
              sync_verified: missingDates.length === 0,
              missing_blackout_dates: missingDates
            };
          });

          ownerSync = {
            checked: true,
            verified_count: verifiedBlocks.filter(b => b.sync_verified === true).length,
            attention_count: verifiedBlocks.filter(b => b.sync_verified === false).length
          };
        } catch (err) {
          ownerSync = {
            checked: false,
            verified_count: 0,
            attention_count: 0,
            detail: String(err)
          };
        }
      }

      return res.status(200).json({
        ok: true,
        property_slug: propertySlug,
        property_name: prop?.display_name || propertySlug,
        owner_name: owner.owner_name,
        prep_buffer_nights: prepBufferNights,
        refreshed_at: new Date().toISOString(),
        blocks: verifiedBlocks,
        bookings: live.bookings || [],
        diagnostics: {
          owner_blocks_count: (ownerBlocks || []).length,
          guest_bookings_count: (live.bookings || []).length,
          owner_block_sync: ownerSync,
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

      const prepBufferNights = getPrepBufferNights(propertySlug);
      const syncRange = bufferedRange(start_date, end_date, prepBufferNights);

      let availability;
      try {
        availability = await checkBeds24Availability(propertySlug, syncRange.start, syncRange.end);
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
          error: 'Those dates cannot be blocked because the stay or its preparation buffer overlaps unavailable dates.',
          unavailable_dates: availability.unavailableDates,
          prep_buffer_nights: prepBufferNights
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
        beds24Result = await setBeds24Blackout(
          propertySlug,
          syncRange.start,
          syncRange.end
        );
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
          beds24_synced: true,
          prep_buffer_nights: prepBufferNights,
          blackout_start_date: syncRange.start,
          blackout_end_date: syncRange.end
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
          room_id: beds24Result.roomId,
          prep_buffer_nights: prepBufferNights,
          blackout_start_date: syncRange.start,
          blackout_end_date: syncRange.end
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

      const prepBufferNights = getPrepBufferNights(propertySlug);
      const existingSyncRange = bufferedRange(
        existing.start_date,
        existing.end_date,
        prepBufferNights
      );

      let syncResult = { cleared: false, reapplied: 0 };
      try {
        const overlapsOther = await otherOverlappingOwnerBlocks(
          propertySlug,
          id,
          existing.start_date,
          existing.end_date,
          prepBufferNights
        );

        // Clear the owner stay plus its prep buffer, then re-apply the buffered
        // ranges of any overlapping owner stays so no protected prep nights reopen.
        await clearBeds24Blackout(
          propertySlug,
          existingSyncRange.start,
          existingSyncRange.end
        );
        syncResult.cleared = true;

        for (const other of overlapsOther) {
          const otherSyncRange = bufferedRange(
            other.start_date,
            other.end_date,
            prepBufferNights
          );
          await setBeds24Blackout(
            propertySlug,
            otherSyncRange.start,
            otherSyncRange.end
          );
          syncResult.reapplied += 1;
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
          beds24_synced: true,
          prep_buffer_nights: prepBufferNights,
          blackout_start_date: existingSyncRange.start,
          blackout_end_date: existingSyncRange.end
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
          blackout_released: syncResult.cleared === true,
          prep_buffer_nights: prepBufferNights
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
