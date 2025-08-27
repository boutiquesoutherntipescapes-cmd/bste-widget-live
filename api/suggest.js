import fs from 'fs';
import { parseMonthsSpec, stayNights, dateRangeList, isoDate, nightsBetween } from './utils.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // TEMP while testing – we’ll lock this later
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

// version-agnostic node-ical loader
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

async function loadFeedsForProperty(prop) {
  const urls = Object.values(prop.ical || {}).filter(Boolean);
  if (!urls.length) return { feeds_ok: 0, busyNights: new Set() };
  const { fromURLCompat } = await loadNodeIcal();
  let feeds_ok = 0;
  const busy = new Set();
  for (const url of urls) {
    try {
      const data = await fromURLCompat(url);
      const events = Object.values(data || {}).filter(e => e && e.type === 'VEVENT');
      for (const e of events) for (const n of nightsBetween(e.start, e.end)) busy.add(n);
      feeds_ok++;
    } catch (_) { /* ignore individual feed failure */ }
  }
  return { feeds_ok, busyNights: busy };
}

function monthFromDate(d) { return (new Date(d)).getMonth() + 1; }

function priceAndMinStay(prop, check_in, check_out, currency='ZAR') {
  const nights = stayNights(check_in, check_out);
  if (nights <= 0) return { ok:false, error:'Invalid date range' };
  const seasons = (prop.seasons || []).map(s => ({
    name: s.season_name,
    months: parseMonthsSpec(s.months || ''),
    rate: Number(s.nightly_rate_zar || 0),
    minStay: Number(s.min_stay_nights || 1),
    cleaning: Number(s.cleaning_fee_zar || 0),
  }));
  const dates = dateRangeList(check_in, nights);
  let total = 0, maxMinStay = 1;
  for (const d of dates) {
    const m = monthFromDate(d);
    const s = seasons.find(S => S.months.includes(m));
    if (!s) return { ok:false, error:`No season rule covers ${isoDate(d)} (month ${m})` };
    total += s.rate; if (s.minStay > maxMinStay) maxMinStay = s.minStay;
  }
  const cleaningFees = seasons.map(s => s.cleaning).filter(c => c>0);
  const cleaning = cleaningFees.length ? Math.max(...cleaningFees) : 0;
  return { ok:true, currency, nights, minStayRequired:maxMinStay, minStayOk:nights>=maxMinStay, total: total + cleaning };
}

export default async function handler(req, res) {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    // Accept BOTH GET (query params) and POST (JSON body)
    const src = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

    const {
      property_slug,
      check_in, check_out,
      radius_back_days = 7,
      radius_forward_days = 21,
      max_date_suggestions = 5,
      max_other_properties = 6
    } = src;

    if (!property_slug || !check_in || !check_out) {
      return res.status(400).json({ error: 'Missing property_slug, check_in, check_out' });
    }

    const cfg = getConfig();
    const allProps = (cfg.properties || []);
    const prop = allProps.find(p => p.property_slug === property_slug);
    if (!prop) return res.status(404).json({ error: 'Unknown property' });

    // Busy nights for the requested property
    const { feeds_ok: self_ok, busyNights: selfBusy } = await loadFeedsForProperty(prop);
    if (self_ok === 0) return res.status(503).json({ error: 'All calendar feeds failed for this property' });

    // Nearby dates (same length)
    const reqStart = new Date(check_in);
    const reqNights = stayNights(check_in, check_out);
    const startSearch = new Date(reqStart); startSearch.setDate(startSearch.getDate() - Number(radius_back_days));
    const endSearch   = new Date(reqStart); endSearch.setDate(endSearch.getDate() + Number(radius_forward_days));

    const dateSuggestions = [];
    for (let t = startSearch.getTime(); t <= endSearch.getTime(); t += 86400000) {
      const ci = new Date(t).toISOString().slice(0,10);
      const co = new Date(t + reqNights*86400000).toISOString().slice(0,10);
      const nightsArr = nightsBetween(ci, co);
      if (nightsArr.some(n => selfBusy.has(n))) continue;
      const priced = priceAndMinStay(prop, ci, co, cfg.currency || 'ZAR');
      if (!priced.ok || !priced.minStayOk) continue;
      const distanceDays = Math.abs(Math.round((new Date(ci) - reqStart) / 86400000));
      dateSuggestions.push({ check_in:ci, check_out:co, nights:priced.nights, total_price_zar:priced.total, currency:priced.currency, distance_days:distanceDays });
    }
    dateSuggestions.sort((a,b)=>(a.distance_days-b.distance_days)||(a.total_price_zar-b.total_price_zar));

    // Other properties for exact dates
    const otherProps = [];
    for (const p of allProps) {
      if (p.property_slug === property_slug) continue;
      const { feeds_ok, busyNights } = await loadFeedsForProperty(p);
      if (feeds_ok === 0) continue; // fail-closed
      const nightsArr = nightsBetween(check_in, check_out);
      if (nightsArr.some(n => busyNights.has(n))) continue;
      const priced = priceAndMinStay(p, check_in, check_out, cfg.currency || 'ZAR');
      if (!priced.ok || !priced.minStayOk) continue;
      otherProps.push({
        property_slug: p.property_slug,
        display_name: p.display_name || p.property_slug,
        property_page_url: p.property_page_url || '#',
        nights: priced.nights,
        total_price_zar: priced.total,
        currency: priced.currency
      });
    }
    otherProps.sort((a,b)=>a.total_price_zar-b.total_price_zar);

    return res.status(200).json({
      dates: dateSuggestions.slice(0, Number(max_date_suggestions)),
      other_properties: otherProps.slice(0, Number(max_other_properties))
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error in suggest', detail: String(err) });
  }
}
