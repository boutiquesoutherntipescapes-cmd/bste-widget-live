// /api/direct-booking-test.js
// Preview-only smoke test for BSTE direct booking creation in Beds24.
// Creates a short dummy direct booking with personal + financial fields,
// applies one prep night before/after, verifies it, then cancels/cleans up.

import {
  findBeds24AvailableBufferedStay,
  createBeds24DirectBooking,
  cancelBeds24DirectBooking,
  setBeds24Blackout,
  clearBeds24Blackout
} from '../lib/beds24.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function isPreview() {
  return String(process.env.VERCEL_ENV || '').toLowerCase() === 'preview';
}

function addDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!isPreview()) {
    return res.status(403).json({
      ok: false,
      error: 'Direct booking smoke test is available on Preview deployments only.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const propertySlug = 'legacy-suiderstrand';
  const testPrice = 2468;
  let bookingId = null;
  let testStay = null;
  let beforeApplied = false;
  let afterApplied = false;

  try {
    testStay = await findBeds24AvailableBufferedStay(
      propertySlug,
      addDays(180),
      addDays(240),
      2,
      1
    );

    const reference = `BSTE-DIRECT-PREVIEW-${Date.now()}`;

    const created = await createBeds24DirectBooking({
      propertySlug,
      arrival: testStay.arrival,
      departure: testStay.departure,
      adults: 2,
      children: 0,
      firstName: 'BSTE',
      lastName: 'Preview Test',
      email: 'preview-test@example.com',
      country: 'South Africa',
      country2: 'ZA',
      price: testPrice,
      reference,
      comments: 'Automated BSTE Preview direct-booking test. No guest notification.',
      notifyGuest: false,
      notifyHost: false,
      allowWebhooks: false
    });

    bookingId = created.booking.id;

    await setBeds24Blackout(
      propertySlug,
      testStay.prepBeforeStart,
      testStay.prepBeforeEnd
    );
    beforeApplied = true;

    await setBeds24Blackout(
      propertySlug,
      testStay.prepAfterStart,
      testStay.prepAfterEnd
    );
    afterApplied = true;

    const personalOk =
      String(created.booking.firstName || '') === 'BSTE' &&
      String(created.booking.lastName || '') === 'Preview Test';

    const financialOk =
      Number(created.booking.price || 0) === testPrice ||
      (Array.isArray(created.booking.invoiceItems) && created.booking.invoiceItems.length > 0);

    const verify = {
      personal_scope: personalOk,
      financial_scope: financialOk,
      booking_id: Number(bookingId),
      room_id: Number(created.roomId)
    };

    // Cleanup the test booking first, then remove prep blackouts.
    await cancelBeds24DirectBooking(bookingId, false);

    await clearBeds24Blackout(
      propertySlug,
      testStay.prepBeforeStart,
      testStay.prepBeforeEnd
    );
    beforeApplied = false;

    await clearBeds24Blackout(
      propertySlug,
      testStay.prepAfterStart,
      testStay.prepAfterEnd
    );
    afterApplied = false;

    if (!personalOk || !financialOk) {
      return res.status(500).json({
        ok: false,
        error: 'Beds24 booking creation worked, but the new personal/financial scopes did not verify.',
        verify,
        cleanup_complete: true,
        test_dates: testStay
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Direct booking test passed. Guest details, booking value and prep buffers all worked, then the test booking was cancelled and cleaned up.',
      verify,
      test_dates: testStay,
      cleanup_complete: true
    });

  } catch (err) {
    const cleanup = {
      booking_cancelled: false,
      prep_before_cleared: !beforeApplied,
      prep_after_cleared: !afterApplied
    };

    if (bookingId) {
      try {
        await cancelBeds24DirectBooking(bookingId, false);
        cleanup.booking_cancelled = true;
      } catch {}
    }

    if (testStay && beforeApplied) {
      try {
        await clearBeds24Blackout(
          propertySlug,
          testStay.prepBeforeStart,
          testStay.prepBeforeEnd
        );
        cleanup.prep_before_cleared = true;
      } catch {}
    }

    if (testStay && afterApplied) {
      try {
        await clearBeds24Blackout(
          propertySlug,
          testStay.prepAfterStart,
          testStay.prepAfterEnd
        );
        cleanup.prep_after_cleared = true;
      } catch {}
    }

    return res.status(500).json({
      ok: false,
      error: 'Beds24 direct booking preview test failed.',
      detail: String(err),
      cleanup,
      cleanup_required: !(
        (bookingId ? cleanup.booking_cancelled : true) &&
        cleanup.prep_before_cleared &&
        cleanup.prep_after_cleared
      ),
      test_dates: testStay
    });
  }
}
