// Deliberately independent of lib/beds24.js: no refresh flow, inventory or write API.
import { PROPERTIES, sastDate } from './operations-model.js';
export class ImportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const ENDPOINT = 'https://beds24.com/api/v2/bookings';
const STATUSES = ['new', 'confirmed', 'request', 'cancelled', 'black', 'inquiry'];
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
      || new Date(value + 'T00:00:00Z').toISOString().slice(0,10) !== value) throw new ImportError('invalid_source_dates');
  return value;
}
function text(value) { return value == null ? null : String(value); }
function count(value) {
  if (value == null || value === '') return null;
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new ImportError('invalid_guest_count'); return n;
}
export function mapBooking(raw, property, observedAt, account) {
  if (!Number.isSafeInteger(Number(raw.id)) || Number(raw.id) <= 0
    || Number(raw.roomId) !== property.roomId || Number(raw.propertyId) !== property.propertyId) {
    throw new ImportError('unmapped_source_booking');
  }
  const arrival = date(raw.arrival), departure = date(raw.departure);
  if (departure <= arrival || !STATUSES.includes(String(raw.status).toLowerCase())) throw new ImportError('invalid_source_booking');
  // Do not invent a provider revision or its timezone. Observations are ordered
  // by request start. A revision adapter can be enabled after live semantics verification.
  const snapshot = { source_environment: 'production', source_account: account,
    beds24_booking_id: Number(raw.id), property_slug: property.slug,
    beds24_property_id: property.propertyId, beds24_room_id: property.roomId,
    arrival, departure, source_status: raw.status, source_channel: text(raw.channel || raw.referer || raw.apiSource),
    guest_name: [raw.firstName, raw.lastName].filter(Boolean).join(' ') || text(raw.guestName),
    guest_email: text(raw.email), guest_mobile: text(raw.mobile || raw.phone),
    adults: count(raw.numAdult), children: count(raw.numChild), source_modified_at: null,
    source_observed_at: observedAt };
  let price = null;
  if (raw.price != null && raw.price !== '') {
    if (!/^-?\d+(\.\d+)?$/.test(String(raw.price))) throw new ImportError('invalid_source_price');
    price = String(raw.price);
  }
  return { snapshot, financial: { source_price: price, source_currency: text(raw.currency),
    source_deposit: raw.deposit ?? null, source_invoice_items: raw.invoiceItems ?? null,
    source_modified_at: null, source_observed_at: observedAt }, raw };
}
export async function collectBookings({ token, account, now = new Date(), fetcher = fetch }) {
  if (!token || !account) throw new ImportError('import_not_configured');
  const today = sastDate(now), observedAt = now.toISOString();
  // A one-day overlap avoids dependence on inclusive/exclusive departure filtering.
  const from = new Date(new Date(today + 'T00:00:00Z').getTime() - 86400_000).toISOString().slice(0,10);
  const items = new Map(); const counts = Object.fromEntries(PROPERTIES.map(p => [p.slug, 0]));
  for (const property of PROPERTIES) {
    for (let page=1; page<=100; page++) {
      const url = new URL(ENDPOINT);
      url.searchParams.set('roomId', String(property.roomId));
      url.searchParams.set('departureFrom', from);
      url.searchParams.set('includeInvoiceItems', 'true');
      STATUSES.forEach(s => url.searchParams.append('status', s));
      url.searchParams.set('page', String(page));
      let response, data;
      try {
        response = await fetcher(url.toString(), { method: 'GET', headers: { token, accept: 'application/json', 'Cache-Control': 'no-cache' },
          redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error();
        data = await response.json();
      } catch { throw new ImportError('beds24_read_failed'); }
      if (!Array.isArray(data?.data) || typeof data?.pages?.nextPageExists !== 'boolean') throw new ImportError('invalid_beds24_response');
      for (const raw of data.data) {
        const item = mapBooking(raw, property, observedAt, account);
        if (item.snapshot.departure < today) continue;
        const key = String(item.snapshot.beds24_booking_id);
        if (items.has(key)) {
          if (JSON.stringify(items.get(key)) !== JSON.stringify(item)) throw new ImportError('conflicting_duplicate_booking');
          continue;
        }
        items.set(key, item); counts[property.slug]++;
        if (items.size > 2000) throw new ImportError('booking_limit_exceeded');
      }
      if (!data.pages.nextPageExists) break;
      if (page === 100) throw new ImportError('pagination_limit_exceeded');
    }
  }
  return { items: [...items.values()], counts, observedAt };
}
