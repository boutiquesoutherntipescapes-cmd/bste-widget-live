import * as ical from 'node-ical';   // <— use namespace import
import fs from 'fs';
import { overlaps } from './utils.js';

function cors(res) {
  // TEMP while testing — we’ll lock this to your domain later
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

async function loadIcs(url) {
  if (!url) return [];
  try {
    // node-ical v0.20+ async API
    const data = await ical.async.fromURL(url);
    const events = Object.values(data).filter(e => e.type === 'VEVENT');
    return events.map(e => ({ start: new Date(e.start), end: new Date(e.end), summary: e.summary || '' }));
  } catch (e) {
    // Swallow ICS fetch/parse errors so one bad feed doesn't crash
    return [];
  }
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

    const cfg = getConfig();
    const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);
    if (!prop) return res.status(404).json({ error: 'Unknown property' });

    const urls = Object.values(prop.ical || {}).filter(Boolean);
    let busy = [];
    for (const u of urls) busy = busy.concat(await loadIcs(u));

    const start = new Date(check_in);
    const end = new Date(check_out);
    const conflict = busy.some(ev => overlaps(start, end, ev.start, ev.end));
    return res.status(200).json({ available: !conflict });
  } catch (err) {
    return res.status(500).json({ error: 'Server error in availability', detail: String(err) });
  }
}
