// /api/search.js — returns all available properties for given dates, with pricing (+ thumbnails)
import fs from 'fs';
import * as utils from './utils.js';

// ---------- CORS + small edge cache ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // lock to your domain later
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
}

// ✅ Make config loader support BOTH formats:
// 1) Array-only: [ {prop}, {prop} ]
// 2) Object: { currency: 'ZAR', properties: [ {prop}, ... ] }
function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);

  // If file is an array, wrap it into the expected shape.
  if (Array.isArray(parsed)) {
    return { currency: 'ZAR', properties: parsed };
  }

  // If file is an object, assume it's already in the expected shape.
  return parsed || { currency: 'ZAR', properties: [] };
}

// ---------- ICS loader with in-memory cache (5 min) ----------
const ICS_CACHE = globalThis.__BSTE_ICS_CACHE__ || (globalThis.__BSTE_ICS_CACHE__ = new Map());
const ICS_TTL_MS = 5 * 60 * 1000;

async function loadNodeIcal() {
  const mod = await import('node-ical').catch(() => null);
  const lib = mod?.default ?? mod;
  const hasAsync  = typeof lib?.async?.fromURL === 'function';
  const hasDirect = typeof lib?.fromURL === 'function';
  async function fromURLCompat(url, options = {}) {
    if (hasAsync)  return await lib.async.fromURL(url, options);
    if (hasDirect) return await new Promise((resolve, reject) => {
      lib.fromURL(url, options, (err, data) => (err ? reject(err) : resolve(data)));
    });
    throw new Error('node-ical: no fromURL found (async/direct)');
  }
  return { fromURLCompat };
}

async function fetchIcsCached(url, fromURLCompat) {
  const now = Date.now();
  const entry = ICS_CACHE.get(url);
  if (entry && (now - entry.t) < ICS_TTL_MS) return entry.data;
  const data = await fromURLCompat(url);
  ICS_CACHE.set(url, { t: now, data });
  return data;
}

async function loadFeedsForProperty(prop) {
  const urls = Object.values(prop.ical || {}).filter(Boolean);
  if (!urls.length) return { feeds_ok: 0, busyNights: new Set() };
  const { fromURLCompat } = await loadNodeIcal();

  const results = await Promise.all(urls.map(async (url) => {
    try {
      const data = await fetchIcsCached(url, fromURLCompat);
      const events = Object.values(data || {}).filter(e => e && e.type === 'VEVENT');
      return { ok: true, events };
    } catch {
      return { ok: false, events: [] };
    }
  }));

  let feeds_ok = 0;
  const busy = new Set();
  for (const r of results) {
    if (!r.ok) continue;
    feeds_ok++;
    for (const ev of r.events) {
      for (const n of (utils.nightsBetween?.(ev.start, ev.end) || [])) busy.add(n);
    }
  }
  return { feeds_ok, busyNights: busy };
}

// ---------- Pricing ----------
function monthFromDate(d) { return (new Date(d)).getMonth() + 1; }
function priceAndMinStay(prop, check_in, check_out, currency='ZAR') {
  const nights = utils.stayNights(check_in, check_out);
  if (nights <= 0) return { ok:false, error:'Invalid date range' };

  const seasons = (prop.seasons || []).map(s => ({
    name: s.season_name,
    months: utils.parseMonthsSpec(s.months || ''),
    rate: Number(s.nightly_rate_zar || 0),
    minStay: Number(s.min_stay_nights || 1),
    cleaning: Number(s.cleaning_fee_zar || 0),
  }));

  const dates = utils.dateRangeList(check_in, nights);
  let total = 0, maxMinStay = 1;
  for (const d of dates) {
    const m = monthFromDate(d);
    const s = seasons.find(S => S.months.includes(m));
    if (!s) return { ok:false, error:`No season rule covers ${utils.isoDate(d)} (month ${m})` };
    total += s.rate;
    if (s.minStay > maxMinStay) maxMinStay = s.minStay;
  }
  const cleaningFees = seasons.map(s => s.cleaning).filter(c => c>0);
  const cleaning = cleaningFees.length ? Math.max(...cleaningFees) : 0;
  return { ok:true, currency, nights, minStayRequired:maxMinStay, minStayOk:nights>=maxMinStay, total: total + cleaning };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    const src = req.method === 'GET' ? (req.query || {}) :
                req.method === 'POST' ? (req.body || {}) : null;
    if (!src) return res.status(405).json({ error:'Method not allowed' });

    const { check_in, check_out, guests = '2', limit = '999' } = src;
    if (!check_in || !check_out) return res.status(400).json({ error:'Missing check_in/check_out' });
    if (typeof utils.nightsBetween !== 'function') return res.status(500).json({ error:'utils.js missing nightsBetween()' });

    const reqNights = utils.nightsBetween(check_in, check_out);
    if (!reqNights.length) return res.status(400).json({ error:'Invalid date range' });

    const cfg = getConfig();
    const allProps = (cfg.properties || []);
    const currency = cfg.currency || 'ZAR';
    const t0 = Date.now();

    const results = await Promise.all(allProps.map(async (p) => {
      const { feeds_ok, busyNights } = await loadFeedsForProperty(p);
      if (feeds_ok === 0) return { _skipped:true, reason:'feeds_failed', property_slug:p.property_slug };

      const conflict = reqNights.some(n => busyNights.has(n));
      if (conflict) return null;

      const priced = priceAndMinStay(p, check_in, check_out, currency);
      if (!priced.ok || !priced.minStayOk) return null;

      return {
        property_slug: p.property_slug,
        display_name: p.display_name || p.property_slug,
        property_page_url: p.property_page_url || '#',
        thumbnail_url: p.thumbnail_url || null,
        nights: priced.nights,
        total_price_zar: priced.total,
        currency: priced.currency
      };
    }));

    const available = results.filter(Boolean).filter(r => !r._skipped)
      .sort((a,b)=> a.total_price_zar - b.total_price_zar)
      .slice(0, Number(limit));

    const failedFeeds = results.filter(r => r && r._skipped && r.reason==='feeds_failed')
                               .map(r => r.property_slug);

    return res.status(200).json({
      check_in, check_out, guests: Number(guests),
      results: available,
      diagnostics: {
        properties_total: allProps.length,
        available_count: available.length,
        failed_feeds: failedFeeds,
        ms: Date.now() - t0
      }
    });
  } catch (err) {
    return res.status(500).json({ error:'Server error in search', detail:String(err) });
  }
}
