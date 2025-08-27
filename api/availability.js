import fs from 'fs';
import { overlaps } from './utils.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // TEMP while testing; we’ll lock this down later
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
  const hasAsync = typeof lib?.async?.fromURL === 'function';
  const hasDirect = typeof lib?.fromURL === 'function';
  async function fromURLCompat(url, options = {}) {
    if (hasAsync) return await lib.async.fromURL(url, options);
    if (hasDirect) {
      return await new Promise((resolve, reject) => {
        lib.fromURL(url, options, (err, data) => (err ? reject(err) : resolve(data)));
      });
    }
    throw new Error('node-ical: no fromURL found (async/direct)');
  }
  return { fromURLCompat };
}

async function loadFeed(url) {
  try {
    const { fromURLCompat } = await loadNodeIcal();
    const data = await fromURLCompat(url);
    const events = Object.values(data || {})
      .filter(e => e && e.type === 'VEVENT')
      .map(e => ({ start: new Date(e.start), end: new Date(e.end) }));
    return { url, ok: true, events };
  } catch (e) {
    return { url, ok: false, events: [], error: String(e) };
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
    if (!urls.length) return res.status(400).json({ error: 'No iCal URLs configured for this property' });

    const loaded = await Promise.all(urls.map(loadFeed));
    const okCount = loaded.filter(f => f.ok).length;
    if (okCount === 0) {
      return res.status(503).json({ error: 'All calendar feeds failed to load', feeds: loaded.map(f => ({ url: f.url, ok: f.ok, error: f.error })) });
    }

    let busy = [];
    for (const f of loaded) if (f.ok) busy = busy.concat(f.events);

    const start = new Date(check_in);
    const end = new Date(check_out);
    const conflict = busy.some(ev => overlaps(start, end, ev.start, ev.end));

    return res.status(200).json({
      available: !conflict,
      diagnostics: { feeds_ok: okCount, feeds_total: loaded.length, events_merged: busy.length }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Server error in availability', detail: String(err) });
  }
}
