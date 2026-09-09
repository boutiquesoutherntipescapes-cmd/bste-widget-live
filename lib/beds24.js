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
  const key = String(channel || '').toLowerCase().trim();
  if (key.includes('airbnb')) return 'Airbnb';
  if (key === 'booking' || key.includes('booking.com')) return 'Booking.com';
  if (key.includes('lekke')) return 'Lekkeslaap';
  if (key === 'direct' || key === 'bookingpage') return 'Direct BSTE';
  return 'Booked';
}

async function beds24FetchAllPages(path, params) {
  const rows = [];
  const maxPages = 25;

  for (let page = 1; page <= maxPages; page++) {
    const pageParams = new URLSearchParams(params);
    if (page > 1) pageParams.set('page', String(page));

    const data = await beds24Fetch(`${path}?${pageParams.toString()}`);
    rows.push(...(Array.isArray(data?.data) ? data.data : []));

    if (data?.pages?.nextPageExists !== true) break;

    if (page === maxPages) {
      throw new Error(`Beds24 pagination exceeded ${maxPages} pages for ${path}`);
    }
  }

  return rows;
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
    status: 'black'
  });

  const data = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const match = rows.find(row =>
    Number(row.roomId) === Number(roomId) &&
    String(row.custom1 || '') === 'BSTE_OWNER_BLOCK' &&
    String(row.custom2 || '') === String(blockId)
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

export async function setBeds24Blackout(propertySlug, startDate, endDate) {
  const roomId = await getBeds24RoomId(propertySlug);
  const lastNight = addDays(endDate, -1);

  const result = await beds24Fetch('inventory/rooms/calendar', {
    method: 'POST',
    body: [{
      roomId,
      calendar: [{
        from: startDate,
        to: lastNight,
        override: 'blackout'
      }]
    }]
  });

  return { roomId, result };
}

export async function clearBeds24Blackout(propertySlug, startDate, endDate) {
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

export async function getBeds24BlackoutDates(propertySlug, startDate, endDate) {
  const roomId = await getBeds24RoomId(propertySlug);

  if (!startDate || !endDate || endDate < startDate) {
    return { roomId, blackoutDates: new Set(), ranges: [] };
  }

  const params = new URLSearchParams();
  params.append('roomId', String(roomId));
  params.set('startDate', startDate);
  params.set('endDate', endDate);
  params.set('includeOverride', 'true');

  const rows = await beds24FetchAllPages('inventory/rooms/calendar', params);
  const roomRows = rows.filter(row => Number(row.roomId) === Number(roomId));
  const blackoutDates = new Set();
  const ranges = [];

  for (const row of roomRows) {
    for (const item of (Array.isArray(row.calendar) ? row.calendar : [])) {
      if (String(item.override || '').toLowerCase() !== 'blackout') continue;
      if (!item.from || !item.to) continue;

      ranges.push({ from: item.from, to: item.to });

      for (let d = item.from; d <= item.to; d = addDays(d, 1)) {
        blackoutDates.add(d);
      }
    }
  }

  return { roomId, blackoutDates, ranges };
}

export async function loadBeds24BookingsForProperty(propertySlug) {
  const roomId = await getBeds24RoomId(propertySlug);
  const today = new Date().toISOString().slice(0, 10);

  // Query Beds24 explicitly for active/current-and-future reservations and follow
  // all result pages. The API defaults to upcoming bookings, but being explicit
  // here avoids silently missing a reservation if Beds24 defaults change or the
  // property accumulates enough bookings to paginate.
  const params = new URLSearchParams();
  params.append('roomId', String(roomId));
  params.append('departureFrom', addDays(today, -1));
  params.append('status', 'confirmed');
  params.append('status', 'new');
  params.append('status', 'request');

  const rows = await beds24FetchAllPages('bookings', params);

  return rows
    .filter(row => ['confirmed', 'new', 'request'].includes(String(row.status || '').toLowerCase()))
    .filter(row => String(row.departure || '') >= today)
    .filter(row => String(row.arrival || '') && String(row.departure || ''))
    .map(row => ({
      id: `beds24-${row.id}`,
      property_slug: propertySlug,
      start_date: row.arrival,
      end_date: row.departure,
      type: 'guest_booking',
      label: 'Booked',
      source: sourceLabel(row.channel),
      booking_status: String(row.status || '').toLowerCase(),
      note: 'Booked'
    }))
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
}

export async function findBeds24AvailableNight(propertySlug, startDate, endDate) {
  const roomId = await getBeds24RoomId(propertySlug);
  const params = new URLSearchParams({
    roomId: String(roomId),
    startDate,
    endDate
  });

  const data = await beds24Fetch(`inventory/rooms/availability?${params.toString()}`);
  const row = (data?.data || []).find(item => Number(item.roomId) === Number(roomId));

  if (!row?.availability || typeof row.availability !== 'object') {
    throw new Error('Beds24 returned no availability data for the test window');
  }

  const availableDate = Object.keys(row.availability)
    .sort()
    .find(date => row.availability[date] === true);

  if (!availableDate) {
    throw new Error('No available night found in the safe test window');
  }

  return {
    roomId,
    startDate: availableDate,
    endDate: addDays(availableDate, 1)
  };
}


export async function findBeds24AvailableBufferedStay(
  propertySlug,
  startDate,
  endDate,
  stayNights = 2,
  bufferNights = 1
) {
  const roomId = await getBeds24RoomId(propertySlug);
  const params = new URLSearchParams({
    roomId: String(roomId),
    startDate,
    endDate
  });

  const data = await beds24Fetch(`inventory/rooms/availability?${params.toString()}`);
  const row = (data?.data || []).find(item => Number(item.roomId) === Number(roomId));

  if (!row?.availability || typeof row.availability !== 'object') {
    throw new Error('Beds24 returned no availability data for the direct-booking test window');
  }

  const dates = Object.keys(row.availability).sort();
  const totalProtectedNights = Number(stayNights) + (Number(bufferNights) * 2);

  for (let i = 0; i <= dates.length - totalProtectedNights; i++) {
    const sequence = dates.slice(i, i + totalProtectedNights);
    const consecutive = sequence.every((date, idx) => {
      if (idx === 0) return true;
      return date === addDays(sequence[idx - 1], 1);
    });
    const allAvailable = sequence.every(date => row.availability[date] === true);

    if (!consecutive || !allAvailable) continue;

    const arrival = sequence[Number(bufferNights)];
    const departure = addDays(arrival, Number(stayNights));

    return {
      roomId,
      arrival,
      departure,
      prepBeforeStart: addDays(arrival, -Number(bufferNights)),
      prepBeforeEnd: arrival,
      prepAfterStart: departure,
      prepAfterEnd: addDays(departure, Number(bufferNights)),
      stayNights: Number(stayNights),
      bufferNights: Number(bufferNights)
    };
  }

  throw new Error('No fully available stay with preparation buffers was found in the test window');
}

export async function createBeds24DirectBooking({
  propertySlug,
  arrival,
  departure,
  adults = 2,
  children = 0,
  firstName,
  lastName,
  email,
  mobile = '',
  country = '',
  country2 = '',
  price = 0,
  reference,
  comments = '',
  notifyGuest = false,
  notifyHost = false,
  allowWebhooks = true,
  status = 'confirmed',
  custom3 = '',
  custom4 = '',
  custom5 = '',
  custom6 = ''
}) {
  const roomId = await getBeds24RoomId(propertySlug);
  const trackingId = String(reference || `BSTE-DIRECT-${Date.now()}`);

  const payload = [{
    roomId,
    status: String(status || 'confirmed').toLowerCase(),
    arrival,
    departure,
    numAdult: Math.max(0, Number(adults || 0)),
    numChild: Math.max(0, Number(children || 0)),
    firstName: String(firstName || '').slice(0, 100),
    lastName: String(lastName || '').slice(0, 100),
    email: String(email || '').slice(0, 100),
    mobile: String(mobile || '').slice(0, 100),
    country: String(country || '').slice(0, 100),
    country2: country2 ? String(country2).slice(0, 2).toUpperCase() : undefined,
    price: Math.max(0, Number(price || 0)),
    comments: String(comments || 'Direct booking via Boutique Southern Tip Escapes').slice(0, 1000),
    notes: `BSTE direct booking · ${trackingId}`,
    custom1: 'BSTE_DIRECT_BOOKING',
    custom2: trackingId,
    custom3: String(custom3 || '').slice(0, 255),
    custom4: String(custom4 || '').slice(0, 255),
    custom5: String(custom5 || '').slice(0, 255),
    custom6: String(custom6 || '').slice(0, 255),
    actions: {
      checkAvailability: true,
      notifyGuest: Boolean(notifyGuest),
      notifyHost: Boolean(notifyHost),
      autoInvoiceItemCharge: true,
      allowWebhooks: Boolean(allowWebhooks)
    }
  }];

  const result = await beds24Fetch('bookings', { method: 'POST', body: payload });
  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : true;

  if (failed) {
    throw new Error(`Beds24 rejected direct booking: ${JSON.stringify(result)}`);
  }

  const params = new URLSearchParams({
    roomId: String(roomId),
    arrival,
    departure,
    includeInvoiceItems: 'true'
  });

  const verify = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(verify?.data) ? verify.data : [];
  const booking = rows.find(row =>
    Number(row.roomId) === Number(roomId) &&
    String(row.custom1 || '') === 'BSTE_DIRECT_BOOKING' &&
    String(row.custom2 || '') === trackingId
  );

  if (!booking?.id) {
    throw new Error(`Beds24 created the booking but it could not be verified: ${JSON.stringify(result)}`);
  }

  return { roomId, trackingId, booking, result };
}

export async function findBeds24DirectBookingByReference(
  propertySlug,
  reference,
  arrival = '',
  departure = ''
) {
  const roomId = await getBeds24RoomId(propertySlug);
  const params = new URLSearchParams({ roomId: String(roomId) });
  if (arrival) params.set('arrivalFrom', arrival);
  if (departure) params.set('departureTo', departure);

  const rows = await beds24FetchAllPages('bookings', params);
  return rows.find(row =>
    Number(row.roomId) === Number(roomId) &&
    String(row.custom1 || '') === 'BSTE_DIRECT_BOOKING' &&
    String(row.custom2 || '') === String(reference || '')
  ) || null;
}

export async function getBeds24BookingById(bookingId) {
  if (!Number(bookingId)) throw new Error('Missing Beds24 booking ID');

  const params = new URLSearchParams({
    id: String(Number(bookingId)),
    includeInvoiceItems: 'true'
  });

  const data = await beds24Fetch(`bookings?${params.toString()}`);
  const rows = Array.isArray(data?.data) ? data.data : [];
  const booking = rows.find(row => Number(row.id) === Number(bookingId));

  if (!booking) throw new Error(`Beds24 booking not found: ${bookingId}`);
  return booking;
}

export async function updateBeds24DirectBookingStatus(
  bookingId,
  status,
  comments = '',
  allowWebhooks = true
) {
  if (!Number(bookingId)) throw new Error('Missing Beds24 booking ID');

  const result = await beds24Fetch('bookings', {
    method: 'POST',
    body: [{
      id: Number(bookingId),
      status: String(status || '').toLowerCase(),
      comments: String(comments || '').slice(0, 1000),
      actions: { allowWebhooks: Boolean(allowWebhooks) }
    }]
  });

  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : true;

  if (failed) {
    throw new Error(`Beds24 rejected booking status update: ${JSON.stringify(result)}`);
  }

  return { bookingId: Number(bookingId), status, result };
}

export async function recordBeds24Payment(
  bookingId,
  amount,
  description = 'PayFast payment received',
  status = 'complete'
) {
  const booking = await getBeds24BookingById(bookingId);
  const existing = Array.isArray(booking.invoiceItems) ? booking.invoiceItems : [];

  const duplicate = existing.find(item =>
    String(item.type || '').toLowerCase() === 'payment' &&
    String(item.description || '') === String(description || '')
  );

  if (duplicate) {
    return { bookingId:Number(bookingId), duplicate:true, invoiceItem:duplicate };
  }

  const result = await beds24Fetch('bookings', {
    method:'POST',
    body:[{
      id:Number(bookingId),
      invoiceItems:[{
        type:'payment',
        qty:1,
        amount:Number(amount || 0),
        description:String(description || 'PayFast payment received').slice(0,250),
        status:String(status || 'complete').slice(0,50)
      }]
    }]
  });

  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : true;

  if (failed) {
    throw new Error(`Beds24 rejected payment record: ${JSON.stringify(result)}`);
  }

  return { bookingId:Number(bookingId), duplicate:false, result };
}

export async function cancelBeds24DirectBooking(bookingId, allowWebhooks = true) {
  if (!Number(bookingId)) throw new Error('Missing Beds24 booking ID');

  const result = await beds24Fetch('bookings', {
    method: 'POST',
    body: [{
      id: Number(bookingId),
      status: 'cancelled',
      comments: 'BSTE direct booking cancelled',
      actions: { allowWebhooks: Boolean(allowWebhooks) }
    }]
  });

  const failed = Array.isArray(result)
    ? result.some(item => item?.success === false || (Array.isArray(item?.errors) && item.errors.length))
    : true;

  if (failed) {
    throw new Error(`Beds24 rejected direct-booking cancellation: ${JSON.stringify(result)}`);
  }

  return { bookingId: Number(bookingId), result };
}

export async function getBeds24Diagnostics(propertySlug) {
  const roomId = await getBeds24RoomId(propertySlug);
  return {
    configured: true,
    room_id: roomId,
    source: 'Beds24 API V2'
  };
}
