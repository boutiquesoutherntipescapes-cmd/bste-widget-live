import fs from 'fs';

async function getNodeIcal() {
  try { return await import('node-ical'); }
  catch (e) { return null; }
}

function getConfig() {
  const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
  return JSON.parse(raw.toString());
}

function inRange(ev, from, to) {
  // overlap test
  return (from < ev.end) && (ev.start < to);
}

export default async function handler(req, res) {
  try {
    const { property_slug, from, to } = req.query || {};
    if (!property_slug) return res.status(400).json({ error: 'Missing property_slug' });

    const cfg = getConfig();
    const prop = (cfg.properties || []).find(p => p.property_slug === property_slug);
    if (!prop) return res.status(404).json({ error: 'Unknown property' });

    const ical = await getNodeIcal();
    const urls = Object.values(prop.ical || {}).filter(Boolean);
    if (!urls.length) return res.status(400).json({ error: 'No iCal URLs configured for this property' });

    const fromD = from ? new Date(from) : new Date();
    const toD   = to   ? new Date(to)   : new Date(new Date().setMonth(new Date().getMonth()+6));

    const results = [];
    for (const url of urls) {
      try {
        const data = await ical.async.fromURL(url);
        const events = Object.values(data || {}).filter(e => e && e.type === 'VEVENT')
          .map(e => ({ start: new Date(e.start), end: new Date(e.end), summary: e.summary || '' }))
          .filter(e => inRange(e, fromD, toD))
          .sort((a,b) => a.start - b.start)
          .slice(0, 30);
        results.push({ url, ok: true, count: events.length, sample: events.map(e => ({
          start: e.start.toISOString().slice(0,10),
          end:   e.end.toISOString().slice(0,10),
          summary: e.summary
        }))});
      } catch (e) {
        results.push({ url, ok: false, error: String(e) });
      }
    }

    res.status(200).json({ property_slug, window: { from: fromD.toISOString(), to: toD.toISOString() }, feeds: results });
  } catch (e) {
    res.status(500).json({ error: 'debug-icals error', detail: String(e) });
  }
}
