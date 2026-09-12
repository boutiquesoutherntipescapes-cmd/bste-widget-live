// Beds24 -> BSTE operations workflow webhook.
// Configure per property in Beds24: Settings > Properties > Access > Booking Webhook (V2).
// URL: https://<BSTE-domain>/api/booking-workflow?secret=<BSTE_BOOKING_WEBHOOK_SECRET>
//
// The endpoint normalises new / modified / cancelled reservations, forwards a
// privacy-minimised operations payload to the existing Google Apps Script
// webhook, and stores an event hash in Beds24 custom10 to make delivery
// idempotent. Updating custom10 triggers another Beds24 webhook, which is then
// safely ignored because the hash already matches.

import crypto from 'crypto';
import fs from 'fs';

const API_BASE = 'https://beds24.com/api/v2';
let cachedToken = null;
let cachedTokenExpiresAt = 0;

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? { properties: parsed } : (parsed || { properties: [] });
}

function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function normaliseName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\bin\b/g, '')
    .replace(/\bocean\b/g, '')
    .replace(/\bviews?\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function sourceLabel(channel) {
  const key = String(channel || '').toLowerCase().trim();
  if (key.includes('airbnb')) return 'Airbnb';
  if (key === 'booking' || key.includes('booking.com')) return 'Booking.com';
  if (key.includes('lekke')) return 'Lekkeslaap';
  if (key === 'direct' || key === 'bookingpage') return 'Direct BSTE';
  return String(channel || 'Beds24');
}

async function getAccessToken(force = false) {
  const refreshToken = String(process.env.BEDS24_REFRESH_TOKEN || '').trim();
  if (!refreshToken) throw new Error('Missing BEDS24_REFRESH_TOKEN');

  const now = Date.now();
  if (!force && cachedToken && now < cachedTokenExpiresAt - 60_000) return cachedToken;

  const response = await fetch(`${API_BASE}/authentication/token`, {
    headers: { accept: 'application/json', refreshToken }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.token) {
    throw new Error(`Beds24 authentication failed: ${response.status}`);
  }

  cachedToken = data.token;
  cachedTokenExpiresAt = now + Math.max(60, Number(data.expiresIn || 3600)) * 1000;
  return cachedToken;
}

async function beds24Fetch(path, options = {}, retry = true) {
  const token = await getAccessToken(false);
  const response = await fetch(`${API_BASE}/${String(path).replace(/^\/+/, '')}`, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (response.status === 401 && retry) {
    await getAccessToken(true);
    return beds24Fetch(path, options, false);
  }
  if (!response.ok) throw new Error(`Beds24 API failed: ${response.status} ${text}`);
  return data;
}

async function getBooking(bookingId) {
  const params = new URLSearchParams();
  params.append('id', String(bookingId));
  params.set('includeInvoiceItems', 'true');
  params.set('includeGuests', 'true');

  // Include every possible status because cancellations also trigger the webhook.
  ['confirmed','request','new','cancelled','black','inquiry'].forEach(s => params.append('status', s));

  const data = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.find(row => Number(row.id) === Number(bookingId)) || null;
}

async function resolveProperty(roomId) {
  const cfg = getConfig();
  const direct = (cfg.properties || []).find(p => Number(p.beds24_room_id) === Number(roomId));
  if (direct) return direct;

  const data = await beds24Fetch('properties?includeAllRooms=true');
  const bedsProperties = Array.isArray(data?.data) ? data.data : [];
  let roomName = '';
  let propertyName = '';

  for (const p of bedsProperties) {
    const room = (Array.isArray(p.roomTypes) ? p.roomTypes : [])
      .find(r => Number(r.id) === Number(roomId));
    if (room) {
      roomName = room.name || '';
      propertyName = p.name || '';
      break;
    }
  }

  const targets = [roomName, propertyName].filter(Boolean).map(normaliseName);
  return (cfg.properties || []).find(p => {
    const names = [p.display_name, p.beds24_room_name, p.beds24_property_name]
      .filter(Boolean).map(normaliseName);
    return names.some(name => targets.includes(name));
  }) || null;
}

function workflowHash(booking) {
  const canonical = [
    booking.id,
    booking.status,
    booking.subStatus,
    booking.roomId,
    booking.arrival,
    booking.departure,
    booking.numAdult,
    booking.numChild,
    booking.price,
    booking.deposit,
    booking.channel,
    booking.firstName,
    booking.lastName,
    booking.email,
    booking.mobile
  ].map(v => String(v ?? '')).join('|');

  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function buildTasks(booking) {
  const arrival = String(booking.arrival || '');
  const departure = String(booking.departure || '');
  if (!arrival || !departure) return [];

  const tasks = [
    {
      type: 'prep_inspection',
      date: addDays(arrival, -2),
      time: '10:00',
      label: 'Pre check-in inspection, surface clean & prep'
    },
    {
      type: 'check_in',
      date: arrival,
      time: '14:00',
      end_time: '16:00',
      label: 'Meet guest at property · tour & keys'
    },
    {
      type: 'check_out',
      date: departure,
      time: '10:00',
      end_time: '11:00',
      label: 'Meet guest for check-out'
    },
    {
      type: 'post_checkout_inspection',
      date: departure,
      time: '11:00',
      label: 'Post check-out walkthrough inspection'
    },
    {
      type: 'deep_clean',
      date: addDays(departure, 1),
      time: '09:00',
      label: 'Deep clean, professional laundry & reset'
    }
  ];

  if (['direct','bookingpage'].includes(String(booking.channel || '').toLowerCase())) {
    tasks.unshift({
      type: 'balance_due_check',
      date: addDays(arrival, -7),
      time: '09:00',
      label: 'Confirm balance paid'
    });
  }

  return tasks;
}

async function sendGoogleWorkflow(payload) {
  const url = String(process.env.GOOGLE_WEBHOOK_URL || '').trim();
  const secret = String(process.env.BSTE_WEBHOOK_SECRET || '').trim();
  if (!url || !secret) throw new Error('Google workflow webhook is not configured');

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, ...payload })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google workflow failed: ${response.status} ${text}`);
  }
  return text;
}

async function markProcessed(bookingId, marker) {
  const result = await beds24Fetch('bookings', {
    method: 'POST',
    body: [{
      id: Number(bookingId),
      custom10: marker,
      actions: {
        notifyGuest: false,
        notifyHost: false,
        allowWebhooks: true
      }
    }]
  });

  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : true;
  if (failed) throw new Error(`Could not store workflow marker: ${JSON.stringify(result)}`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  try {
    const expectedSecret = String(
      process.env.BSTE_BOOKING_WEBHOOK_SECRET || process.env.BSTE_WEBHOOK_SECRET || ''
    ).trim();
    const suppliedSecret = String(req.query?.secret || '').trim();

    if (!expectedSecret || !suppliedSecret || suppliedSecret !== expectedSecret) {
      return res.status(403).json({ ok: false, error: 'Invalid webhook secret' });
    }

    const webhookBooking = req.body?.booking || req.body || {};
    const bookingId = Number(webhookBooking.id || 0);
    if (!bookingId) return res.status(400).json({ ok: false, error: 'Missing booking id' });

    const booking = await getBooking(bookingId);
    if (!booking) return res.status(404).json({ ok: false, error: 'Booking not found in Beds24' });

    // Ignore owner blocks and other non-guest calendar records.
    if (String(booking.status || '').toLowerCase() === 'black' ||
        String(booking.custom1 || '') === 'BSTE_OWNER_BLOCK') {
      return res.status(200).json({ ok: true, ignored: 'owner_block' });
    }

    const hash = workflowHash(booking);
    const marker = `BSTEOPS1:${hash}`;
    const previousMarker = String(booking.custom10 || '');

    if (previousMarker === marker) {
      return res.status(200).json({ ok: true, ignored: 'duplicate' });
    }

    const status = String(booking.status || '').toLowerCase();
    const eventType = status === 'cancelled'
      ? 'booking_cancelled'
      : previousMarker.startsWith('BSTEOPS1:')
        ? 'booking_modified'
        : 'new_booking';

    const property = await resolveProperty(booking.roomId);
    const propertySlug = property?.property_slug || `beds24-room-${booking.roomId}`;
    const propertyName = property?.display_name || `Beds24 room ${booking.roomId}`;

    const guestName = [booking.firstName, booking.lastName].filter(Boolean).join(' ').trim();
    const totalGuests = Math.max(0, Number(booking.numAdult || 0)) + Math.max(0, Number(booking.numChild || 0));

    const payload = {
      action: 'booking_workflow',
      event_type: eventType,
      event_hash: hash,
      booking_id: Number(booking.id),
      booking_status: status,
      property_slug: propertySlug,
      property_name: propertyName,
      room_id: Number(booking.roomId || 0),
      channel: sourceLabel(booking.channel),
      channel_code: String(booking.channel || ''),
      arrival: booking.arrival || '',
      departure: booking.departure || '',
      adults: Number(booking.numAdult || 0),
      children: Number(booking.numChild || 0),
      guests: totalGuests,
      guest: {
        name: guestName,
        first_name: String(booking.firstName || ''),
        email: String(booking.email || ''),
        mobile: String(booking.mobile || ''),
        country: String(booking.country || '')
      },
      financial: {
        booking_value_zar: Number(booking.price || 0),
        deposit_zar: Number(booking.deposit || 0)
      },
      operational_tasks: buildTasks(booking),
      cleaner: {
        service_date: booking.departure ? addDays(booking.departure, 1) : '',
        guest_count: totalGuests,
        linen_turnover: true,
        professional_laundry: true
      },
      received_at: new Date().toISOString()
    };

    await sendGoogleWorkflow(payload);
    await markProcessed(bookingId, marker);

    return res.status(200).json({
      ok: true,
      event_type: eventType,
      booking_id: bookingId,
      property: propertyName
    });
  } catch (err) {
    console.error('BSTE booking workflow error', String(err));
    return res.status(500).json({ ok: false, error: 'Booking workflow failed', detail: String(err) });
  }
}
