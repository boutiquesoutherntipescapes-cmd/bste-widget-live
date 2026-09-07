// /api/dashboard-data.js
// Preview-only operations feed for the BSTE management dashboard.
// Beds24 is the source of truth for live reservations.

import fs from 'fs';
import { loadBeds24DashboardBookings } from '../lib/beds24.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? { properties: parsed } : (parsed || { properties: [] });
}

function isPreview() {
  return String(process.env.VERCEL_ENV || '').toLowerCase() === 'preview';
}

function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isPreview()) {
    return res.status(403).json({
      ok: false,
      error: 'Dashboard preview data is available on Preview deployments only.'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const cfg = getConfig();
    const today = new Date().toISOString().slice(0, 10);
    const horizon = addDays(today, 365);

    const propertyResults = await Promise.all((cfg.properties || []).map(async prop => {
      try {
        const bookings = await loadBeds24DashboardBookings(prop.property_slug, {
          today,
          includePastDays: 7
        });

        return {
          property_slug: prop.property_slug,
          display_name: prop.display_name,
          thumbnail_url: prop.thumbnail_url || '',
          prep_buffer_nights: Number(prop.prep_buffer_nights ?? 1),
          connected: true,
          bookings: bookings.filter(b => String(b.arrival) <= horizon)
        };
      } catch (err) {
        return {
          property_slug: prop.property_slug,
          display_name: prop.display_name,
          thumbnail_url: prop.thumbnail_url || '',
          prep_buffer_nights: Number(prop.prep_buffer_nights ?? 1),
          connected: false,
          error: String(err),
          bookings: []
        };
      }
    }));

    const bookings = propertyResults.flatMap(p =>
      p.bookings.map(b => ({
        ...b,
        property_name: p.display_name
      }))
    ).sort((a,b) => String(a.arrival).localeCompare(String(b.arrival)));

    const future = bookings.filter(b => String(b.departure) >= today);
    const direct = future.filter(b =>
      String(b.channel || '').toLowerCase().includes('direct') ||
      String(b.custom1 || '') === 'BSTE_DIRECT_BOOKING'
    );

    const totalRevenue = future.reduce((sum,b) => sum + Number(b.price || 0), 0);
    const bookedNights = future.reduce((sum,b) => sum + Number(b.nights || 0), 0);
    const nextArrival = future.find(b => String(b.arrival) >= today) || null;

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      today,
      stats: {
        future_bookings: future.length,
        booked_nights: bookedNights,
        future_revenue_zar: totalRevenue,
        direct_bookings: direct.length,
        next_arrival: nextArrival
      },
      properties: propertyResults,
      bookings: future
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Could not load BSTE dashboard data.',
      detail: String(err)
    });
  }
}
