// /lib/beds24.js
// Beds24 API V2 helper for BSTE owner calendars.
// Uses a refresh token stored only in the deployment environment.

import fs from 'fs';

const API_BASE = 'https://beds24.com/api/v2';

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let cachedProperties = null;
let cachedPropertiesExpiresAt = 0;

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? { properties: parsed } : (parsed || { properties: [] });
}

function addDays(dateString, days) {
  const d = new Date(dateString + 'T00:00:00Z');
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
  const key = String(channel || '').toLowerCase();
  if (key === 'airbnb' || key === 'airbnbical') return 'Airbnb';
  if (key === 'booking') return 'Booking.com';
  if (key.includes('lekke')) return 'Lekkeslaap';
  if (key === 'direct' || key === 'bookingpage') return 'Direct BSTE';
  return 'Booked';
}

async function getAccessToken(force = false) {
  const refreshToken = String(process.env.BEDS24_REFRESH_TOKEN || '').trim();

  if (!refreshToken) {
    throw new Error('Beds24 sync is not configured: missing BEDS24_REFRESH_TOKEN');
  }

  const now = Date.now();
  if (!force && cachedAccessToken && now < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const response = await fetch(`${API_BASE}/authentication/token`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      refreshToken
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.token) {
    throw new Error(`Beds24 authentication failed: ${response.status} ${JSON.stringify(data)}`);
  }

  cachedAccessToken = data.token;
  cachedAccessTokenExpiresAt = now + Math.max(60, Number(data.expiresIn || 3600)) * 1000;
  return cachedAccessToken;
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

  if (!response.ok) {
    throw new Error(`Beds24 API failed: ${response.status} ${text}`);
  }

  return data;
}

async function getAllProperties() {
  const now = Date.now();
  if (cachedProperties && now < cachedPropertiesExpiresAt) return cachedProperties;

  const data = await beds24Fetch('properties?includeAllRooms=true');
  cachedProperties = data?.data || [];
  cachedPropertiesExpiresAt = now + 10 * 60 * 1000;
  return cachedProperties;
}

export async function getBeds24RoomId(propertySlug) {
  const cfg = getConfig();
  const prop = (cfg.properties || []).find(p => p.property_slug === propertySlug);

  if (!prop) throw new Error(`Property not found in BSTE config: ${propertySlug}`);

  if (Number(prop.beds24_room_id) > 0) {
    return Number(prop.beds24_room_id);
  }

  const targetNames = [
    prop.beds24_room_name,
    prop.beds24_property_name,
    prop.display_name
  ].filter(Boolean).map(normaliseName);

  const properties = await getAllProperties();

  for (const p of properties) {
    const propertyMatch = targetNames.includes(normaliseName(p.name));
    const rooms = Array.isArray(p.roomTypes) ? p.roomTypes : [];

    for (const room of rooms) {
      const roomMatch = targetNames.includes(normaliseName(room.name));
      if ((propertyMatch || roomMatch) && Number(room.id) > 0) {
        return Number(room.id);
      }
    }
  }

  throw new Error(`Could not resolve Beds24 room for ${prop.display_name || propertySlug}`);
}

export async function checkBeds24Availability(propertySlug, startDate, endDate) {
  const roomId = await getBeds24RoomId(propertySlug);
  const lastNight = addDays(endDate, -1);

  const params = new URLSearchParams({
    roomId: String(roomId),
    startDate,
    endDate: lastNight
  });

  const data = await beds24Fetch(`inventory/rooms/availability?${params.toString()}`);
  const row = (data?.data || []).find(item => Number(item.roomId) === Number(roomId));

  if (!row?.availability || typeof row.availability !== 'object') {
    throw new Error('Beds24 returned no availability data for this room');
  }

  const requested = [];
  for (let d = startDate; d < endDate; d = addDays(d, 1)) requested.push(d);

  const unavailableDates = requested.filter(d => row.availability[d] !== true);

  return {
    roomId,
    available: unavailableDates.length === 0,
    unavailableDates
  };
}

function ownerBlockSearchKey(blockId) {
  return `BSTE-OB-${blockId}`;
}

export async function createBeds24OwnerBlock({ propertySlug, blockId, startDate, endDate, ownerName, note }) {
  const roomId = await getBeds24RoomId(propertySlug);
  const searchKey = ownerBlockSearchKey(blockId);

  const payload = [{
    roomId,
    status: 'black',
    arrival: startDate,
    departure: endDate,
    firstName: 'Owner Use',
    lastName: searchKey,
    comments: note ? `Owner use: ${note}` : 'Owner use',
    notes: `BSTE owner block ${blockId} · ${ownerName || 'Owner'}`,
    custom1: 'BSTE_OWNER_BLOCK',
    custom2: String(blockId),
    actions: {
      checkAvailability: true,
      notifyGuest: false,
      notifyHost: false,
      allowWebhooks: true
    }
  }];

  const result = await beds24Fetch('bookings', { method: 'POST', body: payload });
  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : false;

  if (failed) {
    throw new Error(`Beds24 rejected owner block: ${JSON.stringify(result)}`);
  }

  return { roomId, searchKey, result };
}

export async function findBeds24OwnerBlockBooking(propertySlug, blockId) {
  const roomId = await getBeds24RoomId(propertySlug);
  const params = new URLSearchParams({
    roomId: String(roomId),
    status: 'black',
    searchString: ownerBlockSearchKey(blockId)
  });

  const data = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const match = rows.find(row =>
    Number(row.roomId) === Number(roomId) &&
    String(row.lastName || '').includes(ownerBlockSearchKey(blockId))
  );

  return match || null;
}

export async function cancelBeds24OwnerBlock(propertySlug, blockId) {
  const booking = await findBeds24OwnerBlockBooking(propertySlug, blockId);
  if (!booking?.id) return { found: false, cancelled: false };

  const result = await beds24Fetch('bookings', {
    method: 'POST',
    body: [{
      id: Number(booking.id),
      status: 'cancelled',
      comments: 'Owner block released from BSTE owner portal',
      actions: { allowWebhooks: true }
    }]
  });

  return { found: true, cancelled: true, bookingId: Number(booking.id), result };
}

export async function clearBeds24LegacyBlackout(propertySlug, startDate, endDate) {
  const roomId = await getBeds24RoomId(propertySlug);
  const lastNight = addDays(endDate, -1);

  const result = await beds24Fetch('inventory/rooms/calendar', {
    method: 'POST',
    body: [{
      roomId,
      calendar: [{
        from: startDate,
        to: lastNight,
        override: 'none'
      }]
    }]
  });

  return { roomId, result };
}

export async function loadBeds24BookingsForProperty(propertySlug) {
  const roomId = await getBeds24RoomId(propertySlug);
  const params = new URLSearchParams({ roomId: String(roomId) });
  const data = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];

  return rows
    .filter(row => ['confirmed', 'new', 'request'].includes(String(row.status || '').toLowerCase()))
    .map(row => ({
      id: `beds24-${row.id}`,
      property_slug: propertySlug,
      start_date: row.arrival,
      end_date: row.departure,
      type: 'external_booking',
      label: 'Booked',
      source: sourceLabel(row.channel),
      note: 'Booked'
    }))
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
}

export async function getBeds24Diagnostics(propertySlug) {
  const roomId = await getBeds24RoomId(propertySlug);
  return {
    configured: true,
    room_id: roomId,
    source: 'Beds24 API V2'
  };
}
