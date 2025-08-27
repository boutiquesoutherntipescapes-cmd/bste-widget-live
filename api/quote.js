import fs from 'fs';
import { parseMonthsSpec, stayNights, dateRangeList, isoDate } from './utils.js';

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

function monthFromDate(d) {
  return (new Date(d)).getMonth()+1;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const { property_slug, check_in, check_out } = req.body || {};
  if (!property_slug || !check_in || !check_out) {
    return res.status(400).json({error:'Missing property_slug, check_in, check_out'});
  }

  const cfg = getConfig();
  const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);
  if (!prop) return res.status(404).json({error:'Unknown property'});

  const nights = stayNights(check_in, check_out);
  if (nights <= 0) return res.status(400).json({error:'Invalid date range'});

  const seasons = (prop.seasons || []).map(s => ({
    name: s.season_name,
    months: parseMonthsSpec(s.months || ''),
    rate: Number(s.nightly_rate_zar || 0),
    minStay: Number(s.min_stay_nights || 1),
    cleaning: Number(s.cleaning_fee_zar || 0)
  }));

  const dates = dateRangeList(check_in, nights);
  let total = 0;
  let maxMinStay = 1;
  const breakdown = [];

  for (const d of dates) {
    const m = monthFromDate(d);
    const s = seasons.find(S => S.months.includes(m));
    if (!s) return res.status(400).json({error:`No season rule covers ${isoDate(d)} (month ${m})`});
    total += s.rate;
    if (s.minStay > maxMinStay) maxMinStay = s.minStay;
    breakdown.push({ date: isoDate(d), season: s.name, nightly_rate_zar: s.rate });
  }

  const cleaningFees = seasons.map(s => s.cleaning).filter(c => c>0);
  const cleaning = cleaningFees.length ? Math.max(...cleaningFees) : 0;

  const minStayOk = nights >= maxMinStay;

  return res.status(200).json({
    currency: cfg.currency || 'ZAR',
    nights,
    min_stay_required: maxMinStay,
    min_stay_ok: minStayOk,
    subtotal_nightly: total,
    cleaning_fee_zar: cleaning,
    total_price_zar: total + cleaning,
    breakdown
  });
}
