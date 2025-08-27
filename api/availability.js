import fs from 'fs';
import { overlaps } from './utils.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // TEMP while testing
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

async function getNodeIcal() {
  try {
    const mod = await import('node-ical'); // dynamic import
    return mod;
  } catch (e) {
    console.error('node-ical import failed:', e);
    return null;
  }
}

async function loadIcs(url) {
  if (!url) return [];
  const ical = await getNodeIcal();
  if (!ical) return [];
  try {
    const data = await ical.async.fromURL(url); // async API
    const events = Object.values(data || {}).filter(e => e && e.type === 'VEVENT');
    return events.map(e => ({ start: new Date(e.start), end: new Date(e.end) }));
  } catch (e) {
    console.error('ICS fetch/parse error for', url, e);
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
    const conflict = busy.some(ev => (start < ev.end) && (ev.start < end));
    return res.status(200).json({ available: !conflict });
  } catch (err) {
    console.error('Availability fatal error:', err);
    return res.status(500).json({ error: 'Server error in availability', detail: String(err) });
  }
}
