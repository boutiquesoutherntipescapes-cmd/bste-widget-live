import fs from 'fs';

export default function handler(req, res) {
  try {
    const raw = fs.readFileSync(new URL('../config/properties.json', import.meta.url));
    const cfg = JSON.parse(raw.toString());
    const props = (cfg.properties || []).map(p => ({
      slug: p.property_slug,
      seasons: (p.seasons || []).length,
      icals: Object.values(p.ical || {}).filter(Boolean).length
    }));
    res.status(200).json({ ok: true, timezone: cfg.timezone, currency: cfg.currency, properties: props });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
