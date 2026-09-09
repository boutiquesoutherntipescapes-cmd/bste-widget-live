import fs from 'fs';
import {
  parseMonthsSpec,
  stayNights,
  dateRangeList,
  isoDate,
  seasonForDate
} from '../api/utils.js';

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed)
    ? { currency: 'ZAR', properties: parsed }
    : (parsed || { currency: 'ZAR', properties: [] });
}

export function getPropertyConfig(propertySlug) {
  const cfg = getConfig();
  return (cfg.properties || []).find(p => p.property_slug === propertySlug) || null;
}

export function addDays(dateString, days) {
  const d = new Date(String(dateString) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

export function buildBookingQuote(propertySlug, checkIn, checkOut) {
  const cfg = getConfig();
  const prop = (cfg.properties || []).find(p => p.property_slug === propertySlug);
  if (!prop) throw new Error('Unknown property');

  const nights = stayNights(checkIn, checkOut);
  if (nights <= 0) throw new Error('Invalid date range');

  const seasons = (prop.seasons || []).map(s => ({
    name: s.season_name,
    months: parseMonthsSpec(s.months || ''),
    rate: Number(s.nightly_rate_zar || 0),
    minStay: Number(s.min_stay_nights || 1),
    cleaning: Number(s.cleaning_fee_zar || 0)
  }));

  const dates = dateRangeList(checkIn, nights);
  let subtotal = 0;
  let maxMinStay = 1;
  const breakdown = [];

  for (const d of dates) {
    const season = seasonForDate(d, seasons);
    if (!season) throw new Error(`No season rule covers ${isoDate(d)}`);

    subtotal += season.rate;
    maxMinStay = Math.max(maxMinStay, season.minStay);

    breakdown.push({
      date: isoDate(d),
      season: season.easterOverride ? 'Shoulder Season (Easter Weekend)' : season.name,
      nightly_rate_zar: season.rate
    });
  }

  const cleaning = Math.max(0, ...(seasons.map(s => s.cleaning).filter(Boolean)));

  return {
    property: prop,
    currency: cfg.currency || 'ZAR',
    nights,
    minStayRequired: maxMinStay,
    minStayOk: nights >= maxMinStay,
    subtotalNightly: subtotal,
    cleaningFee: cleaning,
    total: subtotal + cleaning,
    breakdown
  };
}
