import fs from 'fs';
import { overlaps } from './utils.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*'); // TEMP while testing; we’ll lock this down later
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

// ✅ Support BOTH config formats:
// 1) Array-only: [ {prop}, {prop} ]
// 2) Object: { properties: [ {prop}, ... ] }
function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);

  if (Array.isArray(parsed)) {
    return { properties: parsed };
  }

  return parsed || { properties: [] };
}

function cleanSupabaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/g, '');
}

function getSupabase() {
  const url = cleanSupabaseUrl(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return { url, key };
}

async function supabaseFetch(path) {
  const supabase = getSupabase();

  if (!supabase) {
    return [];
  }

  const response = await fetch(`${supabase.url}/rest/v1/${path}`, {
    headers: {
      apikey: supabase.key,
      Authorization: `Bearer ${supabase.key}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    return [];
  }

  const text = await response.text();

  if (!text) {
    return [];
  }

  return JSON.parse(text);
}

async function loadOwnerBlocks(propertySlug) {
  const rows = await supabaseFetch(
    `owner_blocks?select=id,start_date,end_date,block_type,note&property_slug=eq.${encodeURIComponent(propertySlug)}&order=start_date.asc`
  );

  return (rows || []).map(row => ({
    id: row.id,
    start: new Date(row.start_date + 'T00:00:00Z'),
    end: new Date(row.end_date + 'T00:00:00Z'),
    block_type: row.block_type || 'owner_block',
    note: row.note || ''
  }));
}

// version-agnostic node-ical loader
async function loadNodeIcal() {
  const mod = await import('node-ical').catch(() => null);
  const lib = mod?.default ?? mod;
  const hasAsync = typeof lib?.async?.fromURL === 'function';
  const hasDirect = typeof lib?.fromURL === 'function';

  async function fromURLCompat(url, options = {}) {
    if (hasAsync) {
      return await lib.async.fromURL(url, options);
    }

    if (hasDirect) {
      return await new Promise((resolve, reject) => {
        lib.fromURL(url, options, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
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
      .map(e => ({
        start: new Date(e.start),
        end: new Date(e.end),
        source: 'ical'
      }));

    return {
      url,
      ok: true,
      events
    };

  } catch (e) {
    return {
      url,
      ok: false,
      events: [],
      error: String(e)
    };
  }
}

export default async function handler(req, res) {
  try {
    cors(res);

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    if (req.method !== 'GET') {
      return res.status(405).json({
        error: 'Method not allowed'
      });
    }

    const { property_slug, check_in, check_out } = req.query || {};

    if (!property_slug || !check_in || !check_out) {
      return res.status(400).json({
        error: 'Missing property_slug, check_in, check_out'
      });
    }

    const cfg = getConfig();

    const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);

    if (!prop) {
      return res.status(404).json({
        error: 'Unknown property'
      });
    }

    const urls = Object.values(prop.ical || {}).filter(Boolean);

    if (!urls.length) {
      return res.status(400).json({
        error: 'No iCal URLs configured for this property'
      });
    }

    const loaded = await Promise.all(urls.map(loadFeed));

    const okCount = loaded.filter(f => f.ok).length;

    if (okCount === 0) {
      return res.status(503).json({
        error: 'All calendar feeds failed to load',
        feeds: loaded.map(f => ({
          url: f.url,
          ok: f.ok,
          error: f.error
        }))
      });
    }

    let busy = [];

    for (const f of loaded) {
      if (f.ok) {
        busy = busy.concat(f.events);
      }
    }

    const ownerBlocks = await loadOwnerBlocks(property_slug);

    busy = busy.concat(ownerBlocks.map(block => ({
      start: block.start,
      end: block.end,
      source: 'owner_block',
      id: block.id
    })));

    const start = new Date(check_in + 'T00:00:00Z');
    const end = new Date(check_out + 'T00:00:00Z');

    const conflict = busy.some(ev => overlaps(start, end, ev.start, ev.end));

    const ownerBlockConflict = ownerBlocks.some(block => overlaps(start, end, block.start, block.end));

    return res.status(200).json({
      available: !conflict,
      diagnostics: {
        feeds_ok: okCount,
        feeds_total: loaded.length,
        events_merged: busy.length,
        owner_blocks: ownerBlocks.length,
        owner_block_conflict: ownerBlockConflict
      }
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Server error in availability',
      detail: String(err)
    });
  }
}
