// /api/search.js — returns all live-available properties for given dates.
// Beds24 is the source of truth for inventory; every direct stay also protects
// the configured preparation buffer before arrival and after checkout.
import fs from 'fs';
import * as utils from './utils.js';
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
  if (Array.isArray(parsed)) return { currency: 'ZAR', properties: parsed };
  return parsed || { currency: 'ZAR', properties: [] };
}

function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function priceAndMinStay(prop, checkIn, checkOut, currency = 'ZAR') {
  const nights = utils.stayNights(checkIn, checkOut);
  if (nights <= 0) return { ok:false, error:'Invalid date range' };

  const seasons = (prop.seasons || []).map(s => ({
    name: s.season_name,
    months: utils.parseMonthsSpec(s.months || ''),
    rate: Number(s.nightly_rate_zar || 0),
    minStay: Number(s.min_stay_nights || 1),
    cleaning: Number(s.cleaning_fee_zar || 0)
  }));

  const dates = utils.dateRangeList(checkIn, nights);
  let subtotal = 0;
  let maxMinStay = 1;

  for (const d of dates) {
    const season = utils.seasonForDate(d, seasons);
    if (!season) return { ok:false, error:`No season rule covers ${utils.isoDate(d)}` };
    subtotal += season.rate;
    maxMinStay = Math.max(maxMinStay, season.minStay);
  }

  const cleaning = Math.max(0, ...(seasons.map(s => s.cleaning).filter(Boolean)));

  return {
    ok:true,
    currency,
    nights,
    minStayRequired:maxMinStay,
    minStayOk:nights >= maxMinStay,
    total:subtotal + cleaning
  };
}

export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    const src = req.method === 'GET'
      ? (req.query || {})
      : req.method === 'POST'
        ? (req.body || {})
        : null;

    if (!src) return res.status(405).json({ error:'Method not allowed' });

    const { check_in, check_out, guests='2', limit='999' } = src;
    if (!check_in || !check_out) return res.status(400).json({ error:'Missing check_in/check_out' });

    const reqNights = utils.nightsBetween(check_in, check_out);
    if (!reqNights.length) return res.status(400).json({ error:'Invalid date range' });

    const cfg = getConfig();
    const allProps = cfg.properties || [];
    const currency = cfg.currency || 'ZAR';
    const t0 = Date.now();

    const results = await Promise.all(allProps.map(async (p) => {
      try {
        const prepBufferNights = Math.max(0, Number(p.prep_buffer_nights ?? 1));
        const protectedStart = addDays(check_in, -prepBufferNights);
        const protectedEnd = addDays(check_out, prepBufferNights);

        const live = await checkBeds24Availability(
          p.property_slug,
          protectedStart,
          protectedEnd
        );

        if (!live.available) return null;

        const priced = priceAndMinStay(p, check_in, check_out, currency);
        if (!priced.ok || !priced.minStayOk) return null;

        return {
          property_slug:p.property_slug,
          display_name:p.display_name || p.property_slug,
          property_page_url:p.property_page_url || '#',
          thumbnail_url:p.thumbnail_url || null,
          nights:priced.nights,
          total_price_zar:priced.total,
          currency:priced.currency,
          prep_buffer_nights:prepBufferNights
        };
      } catch (err) {
        return {
          _skipped:true,
          reason:'beds24_failed',
          property_slug:p.property_slug,
          detail:String(err)
        };
      }
    }));

    const available = results
      .filter(Boolean)
      .filter(r => !r._skipped)
      .sort((a,b) => a.total_price_zar - b.total_price_zar)
      .slice(0, Number(limit));

    const failed = results
      .filter(r => r && r._skipped)
      .map(r => ({ property_slug:r.property_slug, detail:r.detail }));

    return res.status(200).json({
      check_in,
      check_out,
      guests:Number(guests),
      results:available,
      diagnostics:{
        provider:'Beds24',
        properties_total:allProps.length,
        available_count:available.length,
        failed,
        ms:Date.now() - t0
      }
    });
  } catch (err) {
    return res.status(500).json({ error:'Server error in search', detail:String(err) });
  }
}
