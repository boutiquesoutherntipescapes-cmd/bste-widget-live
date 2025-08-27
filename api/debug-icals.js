import fs from 'fs';

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

// Load node-ical and normalize the API shape
async function loadNodeIcal() {
  try {
    const mod = await import('node-ical');
    const lib = mod?.default ?? mod; // handle CJS/ESM
    const hasAsync = typeof lib?.async?.fromURL === 'function';
    const hasDirect = typeof lib?.fromURL === 'function';
    async function fromURLCompat(url, options = {}) {
      if (hasAsync) return await lib.async.fromURL(url, options);
      if (hasDirect) {
        // wrap callback API into a Promise
        return await new Promise((resolve, reject) => {
          lib.fromURL(url, options, (err, data) => (err ? reject(err) : resolve(data)));
        });
      }
      throw new Error('node-ical: no fromURL found (async/direct)');
    }
    return { fromURLCompat };
  } catch (e) {
    return { fromURLCompat: async () => { throw new Error('node-ical import failed'); } };
  }
}

function inRange(ev, from, to) { return (from < ev.end) && (ev.start < to); }

export default async function handler(req, res) {
  try {
    const { property_slug, from, to } = req.query || {};
    if (!property_slug) return res.status(400).json({ error: 'Missing property_slug' });

    const cfg = getConfig();
    const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);
    if (!prop) return res.status(404).json({ error: 'Unknown property' });

    const urls = Object.values(prop.ical || {}).filter(Boolean);
    if (!urls.length) return res.status(400).json({ error: 'No iCal URLs configured for this property' });

    const fromD = from ? new Date(from) : new Date();
    const toD   = to   ? new Date(to)   : new Date(new Date().setMonth(new Date().getMonth()+6));

    const { fromURLCompat } = await loadNodeIcal();
    const feeds = [];
    for (const url of urls) {
      try {
        const data = await fromURLCompat(url);
        const events = Object.values(data || {})
          .filter(e => e && e.type === 'VEVENT')
          .map(e => ({ start: new Date(e.start), end: new Date(e.end), summary: e.summary || '' }))
          .filter(e => inRange(e, fromD, toD))
          .sort((a,b) => a.start - b.start)
          .slice(0, 50);
        feeds.push({ url, ok: true, count: events.length, sample: events.map(e => ({
          start: e.start.toISOString().slice(0,10),
          end:   e.end.toISOString().slice(0,10),
          summary: e.summary
        }))});
      } catch (e) {
        feeds.push({ url, ok: false, error: String(e) });
      }
    }

    res.status(200).json({ property_slug, window: { from: fromD.toISOString(), to: toD.toISOString() }, feeds });
  } catch (e) {
    res.status(500).json({ error: 'debug-icals error', detail: String(e) });
  }
}
