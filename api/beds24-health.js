// /api/beds24-health.js
// Safe Preview-only Beds24 smoke test.
// GET  = confirm authentication + room mapping.
// POST = create and immediately cancel a harmless far-future black booking.
// This endpoint refuses all requests in Production.

import {
  getBeds24Diagnostics,
  createBeds24OwnerBlock,
  cancelBeds24OwnerBlock,
  findBeds24AvailableNight
} from '../lib/beds24.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function isPreview() {
  return String(process.env.VERCEL_ENV || '').toLowerCase() === 'preview';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isPreview()) {
    return res.status(403).json({
      ok: false,
      error: 'Beds24 smoke test is available on Preview deployments only.'
    });
  }

  try {
    if (req.method === 'GET') {
      const [legacy, kalaya] = await Promise.all([
        getBeds24Diagnostics('legacy-suiderstrand'),
        getBeds24Diagnostics('kalay-ridge-villa-struisbaai')
      ]);

      return res.status(200).json({
        ok: true,
        environment: 'preview',
        message: 'Beds24 authentication and room mapping are working.',
        properties: {
          legacy: { room_id: legacy.room_id },
          kalaya: { room_id: kalaya.room_id }
        }
      });
    }

    if (req.method === 'POST') {
      // Pick a genuinely available night inside the next year.
      // Beds24 can reject dates outside a property's sellable booking window.
      const blockId = `preview-smoke-${Date.now()}`;

      const addDays = (days) => {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };

      const testNight = await findBeds24AvailableNight(
        'legacy-suiderstrand',
        addDays(180),
        addDays(240)
      );

      const startDate = testNight.startDate;
      const endDate = testNight.endDate;

      const created = await createBeds24OwnerBlock({
        propertySlug: 'legacy-suiderstrand',
        blockId,
        startDate,
        endDate,
        ownerName: 'BSTE Preview Test',
        note: 'Automated preview smoke test; cancelled immediately.'
      });

      let cancelled = null;
      try {
        cancelled = await cancelBeds24OwnerBlock('legacy-suiderstrand', blockId);
      } catch (cancelErr) {
        return res.status(500).json({
          ok: false,
          error: 'Beds24 write worked, but automatic cleanup failed.',
          cleanup_required: true,
          room_id: created.roomId,
          test_dates: { start_date: startDate, end_date: endDate },
          detail: String(cancelErr)
        });
      }

      return res.status(200).json({
        ok: true,
        message: 'Beds24 read/write test passed. Temporary test block was created and cancelled.',
        room_id: created.roomId,
        test_dates: { start_date: startDate, end_date: endDate },
        cleanup: cancelled
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Beds24 preview smoke test failed.',
      detail: String(err)
    });
  }
}
