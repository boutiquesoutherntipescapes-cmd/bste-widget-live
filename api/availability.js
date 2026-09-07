import fs from 'fs';
import { checkBeds24Availability } from '../lib/beds24.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? { properties: parsed } : (parsed || { properties: [] });
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { property_slug, check_in, check_out } = req.query || {};
    if (!property_slug || !check_in || !check_out) {
      return res.status(400).json({ error: 'Missing property_slug, check_in, check_out' });
    }

    if (!isValidDate(check_in) || !isValidDate(check_out) || check_out <= check_in) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    const cfg = getConfig();
    const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);
    if (!prop) return res.status(404).json({ error: 'Unknown property' });

    const prepBufferNights = Math.max(0, Number(prop.prep_buffer_nights ?? 1));
    const protectedStart = addDays(check_in, -prepBufferNights);
    const protectedEnd = addDays(check_out, prepBufferNights);

    const availability = await checkBeds24Availability(
      property_slug,
      protectedStart,
      protectedEnd
    );

    return res.status(200).json({
      available: availability.available,
      property_slug,
      check_in,
      check_out,
      prep_buffer_nights: prepBufferNights,
      protected_start: protectedStart,
      protected_end: protectedEnd,
      unavailable_dates: availability.unavailableDates || [],
      diagnostics: {
        provider: 'Beds24',
        room_id: availability.roomId
      }
    });

  } catch (err) {
    return res.status(503).json({
      error: 'Could not verify live availability',
      detail: String(err)
    });
  }
}
