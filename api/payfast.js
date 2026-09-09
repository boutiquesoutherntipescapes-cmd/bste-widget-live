import {
  checkBeds24Availability,
  createBeds24DirectBooking,
  cancelBeds24DirectBooking,
  findBeds24DirectBookingByReference,
  setBeds24Blackout,
  clearBeds24Blackout,
  getBeds24BookingById,
  updateBeds24DirectBookingStatus,
  recordBeds24Payment
} from '../lib/beds24.js';
import {
  buildBookingQuote,
  getPropertyConfig,
  addDays
} from '../lib/booking-pricing.js';
import {
  getPayfastConfig,
  buildPayfastFields,
  signCheckoutState,
  verifyCheckoutState,
  generatePayfastSignature,
  validatePayfastServer,
  validatePayfastSource
} from '../lib/payfast.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const text = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : String(req.body || '');
  return Object.fromEntries(new URLSearchParams(text).entries());
}

function checkoutPayload(src) {
  return {
    bookingId:Number(src.booking_id || 0),
    propertySlug:String(src.property || ''),
    arrival:String(src.arrival || ''),
    departure:String(src.departure || ''),
    reference:String(src.reference || '')
  };
}

function amountMatches(expected, actual) {
  return Math.abs(Number(expected || 0) - Number(actual || 0)) <= 0.01;
}

async function startPayment(req, res) {
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
    const checkoutId = cleanText(body.checkout_id, 80).replace(/[^a-zA-Z0-9_-]/g, '');

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
      propertySlug, reference, arrival, departure
    );

    if (existing && ['request','confirmed','new'].includes(String(existing.status || '').toLowerCase())) {
      const config = getPayfastConfig();
      const statePayload = {
        bookingId:Number(existing.id), propertySlug, arrival, departure, reference
      };
      const state = signCheckoutState(statePayload);
      const fields = buildPayfastFields({
        config,
        baseUrl:baseUrlFromRequest(req),
        bookingId:Number(existing.id),
        reference,
        amount:quote.total,
        itemName:quote.property.display_name,
        itemDescription:`${quote.nights} night BSTE direct booking`,
        firstName,lastName,email,mobile,propertySlug,arrival,departure,adults,children,state
      });

      return res.status(200).json({
        ok:true,reused:true,mode:config.mode,
        booking_id:Number(existing.id),reference,amount_zar:quote.total,
        action:config.processUrl,fields
      });
    }

    const availability = await checkBeds24Availability(
      propertySlug, protectedStart, protectedEnd
    );

    if (!availability.available) {
      return res.status(409).json({
        ok:false,
        error:'These dates are no longer available when the BSTE preparation buffer is included.',
        unavailable_dates:availability.unavailableDates
      });
    }

    const created = await createBeds24DirectBooking({
      propertySlug,arrival,departure,adults,children,
      firstName,lastName,email,mobile,country,
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
      bookingId:Number(created.booking.id), propertySlug, arrival, departure, reference
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
      firstName,lastName,email,mobile,propertySlug,arrival,departure,adults,children,state
    });

    return res.status(200).json({
      ok:true,reused:false,mode:config.mode,
      booking_id:Number(created.booking.id),reference,amount_zar:quote.total,
      prep_buffer_nights:prepBufferNights,
      action:config.processUrl,fields
    });
  } catch (err) {
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
          await clearBeds24Blackout(propertySlug, addDays(arrival,-prep), arrival).catch(() => null);
        }
        if (prep > 0 && prepAfterApplied) {
          await clearBeds24Blackout(propertySlug, departure, addDays(departure,prep)).catch(() => null);
        }
      }
    } catch {}

    return res.status(500).json({
      ok:false,error:'Could not start secure payment.',detail:String(err)
    });
  }
}

async function processItn(req, res) {
  try {
    const data = parseBody(req);
    const config = getPayfastConfig();
    const bookingId = Number(data.m_payment_id || 0);

    if (!bookingId) return res.status(400).send('Invalid booking reference');
    if (String(data.merchant_id || '') !== String(config.merchantId)) {
      return res.status(400).send('Merchant mismatch');
    }

    const postedSignature = String(data.signature || '');
    const unsigned = { ...data };
    delete unsigned.signature;
    const expectedSignature = generatePayfastSignature(unsigned, config.passphrase);

    if (!postedSignature || postedSignature !== expectedSignature) {
      return res.status(400).send('Invalid signature');
    }

    const [validSource, validServer] = await Promise.all([
      validatePayfastSource(req, config),
      validatePayfastServer(data, config)
    ]);

    if (!validSource) return res.status(403).send('Invalid PayFast source');
    if (!validServer) return res.status(400).send('PayFast validation failed');

    const booking = await getBeds24BookingById(bookingId);
    if (String(booking.custom1 || '') !== 'BSTE_DIRECT_BOOKING') {
      return res.status(400).send('Booking is not a BSTE direct checkout');
    }
    if (!amountMatches(booking.price, data.amount_gross)) {
      return res.status(400).send('Amount mismatch');
    }

    const paymentStatus = String(data.payment_status || '').toUpperCase();
    if (paymentStatus !== 'COMPLETE') return res.status(200).send('OK');

    const pfPaymentId = String(data.pf_payment_id || '').trim();
    const paymentDescription = pfPaymentId
      ? `PayFast payment ${pfPaymentId}`
      : `PayFast payment for booking ${bookingId}`;

    await recordBeds24Payment(
      bookingId,
      Number(data.amount_gross || 0),
      paymentDescription,
      'complete'
    );

    if (String(booking.status || '').toLowerCase() !== 'confirmed') {
      await updateBeds24DirectBookingStatus(
        bookingId,
        'confirmed',
        pfPaymentId ? `PayFast payment verified · ${pfPaymentId}` : 'PayFast payment verified',
        true
      );
    }

    const propertySlug = String(data.custom_str1 || '').trim();
    const arrival = String(data.custom_str2 || booking.arrival || '').trim();
    const departure = String(data.custom_str3 || booking.departure || '').trim();
    const prop = getPropertyConfig(propertySlug);
    const prep = Math.max(0, Number(prop?.prep_buffer_nights ?? 1));

    if (propertySlug && arrival && departure && prep > 0) {
      await setBeds24Blackout(propertySlug, addDays(arrival,-prep), arrival);
      await setBeds24Blackout(propertySlug, departure, addDays(departure,prep));
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('PayFast ITN error', String(err));
    return res.status(500).send('ITN processing failed');
  }
}

async function paymentStatus(req, res) {
  try {
    const src=req.query || {};
    const payload=checkoutPayload(src);
    if(!payload.bookingId || !verifyCheckoutState(payload, src.state)) {
      return res.status(403).json({ok:false,error:'Invalid checkout state'});
    }

    const booking=await getBeds24BookingById(payload.bookingId);
    if(
      String(booking.custom1 || '') !== 'BSTE_DIRECT_BOOKING' ||
      String(booking.custom2 || '') !== payload.reference
    ){
      return res.status(403).json({ok:false,error:'Booking reference mismatch'});
    }

    const status=String(booking.status || '').toLowerCase();
    return res.status(200).json({
      ok:true,
      booking_id:Number(booking.id),
      status,
      confirmed:status === 'confirmed' || status === 'new',
      pending:status === 'request',
      cancelled:status === 'cancelled',
      amount_zar:Number(booking.price || 0)
    });
  } catch(err) {
    return res.status(500).json({ok:false,error:'Could not check payment status',detail:String(err)});
  }
}

async function cancelPayment(req, res) {
  try {
    const src=req.body || {};
    const payload=checkoutPayload(src);

    if(!payload.bookingId || !verifyCheckoutState(payload, src.state)) {
      return res.status(403).json({ok:false,error:'Invalid checkout state'});
    }

    const booking=await getBeds24BookingById(payload.bookingId);
    if(
      String(booking.custom1 || '') !== 'BSTE_DIRECT_BOOKING' ||
      String(booking.custom2 || '') !== payload.reference
    ){
      return res.status(403).json({ok:false,error:'Booking reference mismatch'});
    }

    const current=String(booking.status || '').toLowerCase();
    if(current === 'confirmed' || current === 'new') {
      return res.status(200).json({ok:true,already_confirmed:true,booking_id:payload.bookingId});
    }
    if(current === 'cancelled') {
      return res.status(200).json({ok:true,already_cancelled:true,booking_id:payload.bookingId});
    }
    if(current !== 'request') {
      return res.status(409).json({ok:false,error:'Booking is not in a cancellable payment-pending state'});
    }

    await cancelBeds24DirectBooking(payload.bookingId, true);

    const prop=getPropertyConfig(payload.propertySlug);
    const prep=Math.max(0,Number(prop?.prep_buffer_nights ?? 1));
    if(prep > 0) {
      await clearBeds24Blackout(payload.propertySlug, addDays(payload.arrival,-prep), payload.arrival);
      await clearBeds24Blackout(payload.propertySlug, payload.departure, addDays(payload.departure,prep));
    }

    return res.status(200).json({ok:true,cancelled:true,booking_id:payload.bookingId});
  } catch(err) {
    return res.status(500).json({ok:false,error:'Could not release payment hold',detail:String(err)});
  }
}

export default async function handler(req,res) {
  cors(res);
  if(req.method === 'OPTIONS') return res.status(204).end();

  const action=String(req.query?.action || '').toLowerCase();

  if(action === 'start' && req.method === 'POST') return startPayment(req,res);
  if(action === 'itn' && req.method === 'POST') return processItn(req,res);
  if(action === 'status' && req.method === 'GET') return paymentStatus(req,res);
  if(action === 'cancel' && req.method === 'POST') return cancelPayment(req,res);

  return res.status(404).json({ok:false,error:'Unknown PayFast action'});
}
