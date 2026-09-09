import {
  checkBeds24Availability,
  createBeds24DirectBooking,
  cancelBeds24DirectBooking,
  findBeds24DirectBookingByReference,
  setBeds24Blackout,
  clearBeds24Blackout
} from '../lib/beds24.js';
import { buildBookingQuote, addDays } from '../lib/booking-pricing.js';
import {
  getPayfastConfig,
  buildPayfastFields,
  signCheckoutState
} from '../lib/payfast.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function baseUrlFromRequest(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  if (!host) throw new Error('Could not determine checkout host');
  return `${proto}://${host}`;
}

function cleanText(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  let createdBooking = null;
  let prepBeforeApplied = false;
  let prepAfterApplied = false;

  try {
    const body = req.body || {};
    const propertySlug = cleanText(body.property_slug, 120);
    const arrival = cleanText(body.check_in, 10);
    const departure = cleanText(body.check_out, 10);
    const firstName = cleanText(body.first_name, 100);
    const lastName = cleanText(body.last_name, 100);
    const email = cleanText(body.email, 100);
    const mobile = cleanText(body.mobile, 100);
    const country = cleanText(body.country, 100);
    const adults = Math.max(1, Number(body.adults || 1));
    const children = Math.max(0, Number(body.children || 0));
    const specialRequests = cleanText(body.special_requests, 700);
    const checkoutId = cleanText(body.checkout_id, 80)
      .replace(/[^a-zA-Z0-9_-]/g, '');

    if (!propertySlug || !validDate(arrival) || !validDate(departure)) {
      return res.status(400).json({ ok:false, error:'Missing or invalid property dates' });
    }

    if (!firstName || !lastName || !email || !email.includes('@')) {
      return res.status(400).json({ ok:false, error:'Guest name and valid email are required' });
    }

    if (!checkoutId) {
      return res.status(400).json({ ok:false, error:'Missing checkout session ID' });
    }

    const quote = buildBookingQuote(propertySlug, arrival, departure);
    if (!quote.minStayOk) {
      return res.status(409).json({
        ok:false,
        error:`This stay requires at least ${quote.minStayRequired} nights.`
      });
    }

    const prepBufferNights = Math.max(0, Number(quote.property?.prep_buffer_nights ?? 1));
    const protectedStart = addDays(arrival, -prepBufferNights);
    const protectedEnd = addDays(departure, prepBufferNights);
    const reference = `BSTE-PF-${checkoutId}`;

    const existing = await findBeds24DirectBookingByReference(
      propertySlug,
      reference,
      arrival,
      departure
    );

    if (existing && ['request','confirmed','new'].includes(String(existing.status || '').toLowerCase())) {
      const config = getPayfastConfig();
      const statePayload = {
        bookingId: Number(existing.id),
        propertySlug,
        arrival,
        departure,
        reference
      };
      const state = signCheckoutState(statePayload);
      const fields = buildPayfastFields({
        config,
        baseUrl: baseUrlFromRequest(req),
        bookingId: Number(existing.id),
        reference,
        amount: quote.total,
        itemName: quote.property.display_name,
        itemDescription: `${quote.nights} night BSTE direct booking`,
        firstName,
        lastName,
        email,
        mobile,
        propertySlug,
        arrival,
        departure,
        adults,
        children,
        state
      });

      return res.status(200).json({
        ok:true,
        reused:true,
        mode:config.mode,
        booking_id:Number(existing.id),
        reference,
        amount_zar:quote.total,
        action:config.processUrl,
        fields
      });
    }

    const availability = await checkBeds24Availability(
      propertySlug,
      protectedStart,
      protectedEnd
    );

    if (!availability.available) {
      return res.status(409).json({
        ok:false,
        error:'These dates are no longer available when the BSTE preparation buffer is included.',
        unavailable_dates:availability.unavailableDates
      });
    }

    const created = await createBeds24DirectBooking({
      propertySlug,
      arrival,
      departure,
      adults,
      children,
      firstName,
      lastName,
      email,
      mobile,
      country,
      price:quote.total,
      reference,
      comments:[
        'BSTE direct checkout awaiting PayFast payment',
        `Accommodation: R${quote.subtotalNightly.toFixed(2)}`,
        `Cleaning: R${quote.cleaningFee.toFixed(2)}`,
        specialRequests ? `Guest request: ${specialRequests}` : ''
      ].filter(Boolean).join(' · '),
      notifyGuest:false,
      notifyHost:false,
      allowWebhooks:true,
      status:'request'
    });

    createdBooking = created.booking;

    if (prepBufferNights > 0) {
      await setBeds24Blackout(propertySlug, protectedStart, arrival);
      prepBeforeApplied = true;

      await setBeds24Blackout(propertySlug, departure, protectedEnd);
      prepAfterApplied = true;
    }

    const config = getPayfastConfig();
    const statePayload = {
      bookingId:Number(created.booking.id),
      propertySlug,
      arrival,
      departure,
      reference
    };
    const state = signCheckoutState(statePayload);
    const fields = buildPayfastFields({
      config,
      baseUrl:baseUrlFromRequest(req),
      bookingId:Number(created.booking.id),
      reference,
      amount:quote.total,
      itemName:quote.property.display_name,
      itemDescription:`${quote.nights} night BSTE direct booking`,
      firstName,
      lastName,
      email,
      mobile,
      propertySlug,
      arrival,
      departure,
      adults,
      children,
      state
    });

    return res.status(200).json({
      ok:true,
      reused:false,
      mode:config.mode,
      booking_id:Number(created.booking.id),
      reference,
      amount_zar:quote.total,
      prep_buffer_nights:prepBufferNights,
      action:config.processUrl,
      fields
    });
  } catch (err) {
    // Never leave a newly-created unpaid request or its prep blackouts behind
    // when checkout initialization fails before the guest reaches PayFast.
    if (createdBooking?.id) {
      await cancelBeds24DirectBooking(createdBooking.id, false).catch(() => null);
    }

    try {
      const body = req.body || {};
      const propertySlug = cleanText(body.property_slug, 120);
      const arrival = cleanText(body.check_in, 10);
      const departure = cleanText(body.check_out, 10);
      if (propertySlug && validDate(arrival) && validDate(departure)) {
        const quote = buildBookingQuote(propertySlug, arrival, departure);
        const prep = Math.max(0, Number(quote.property?.prep_buffer_nights ?? 1));
        if (prep > 0 && prepBeforeApplied) {
          await clearBeds24Blackout(propertySlug, addDays(arrival, -prep), arrival).catch(() => null);
        }
        if (prep > 0 && prepAfterApplied) {
          await clearBeds24Blackout(propertySlug, departure, addDays(departure, prep)).catch(() => null);
        }
      }
    } catch {}

    return res.status(500).json({
      ok:false,
      error:'Could not start secure payment.',
      detail:String(err)
    });
  }
}
