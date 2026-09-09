import {
  getBeds24BookingById,
  updateBeds24DirectBookingStatus,
  recordBeds24Payment
} from '../lib/beds24.js';
import {
  getPayfastConfig,
  generatePayfastSignature,
  validatePayfastServer,
  validatePayfastSource
} from '../lib/payfast.js';

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  const text = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : String(req.body || '');

  return Object.fromEntries(new URLSearchParams(text).entries());
}

function amountMatches(expected, actual) {
  return Math.abs(Number(expected || 0) - Number(actual || 0)) <= 0.01;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

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

    const status = String(data.payment_status || '').toUpperCase();
    if (status !== 'COMPLETE') {
      // A non-complete ITN must never confirm the reservation.
      return res.status(200).send('OK');
    }

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
        pfPaymentId
          ? `PayFast payment verified · ${pfPaymentId}`
          : 'PayFast payment verified',
        true
      );
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('PayFast ITN error', String(err));
    return res.status(500).send('ITN processing failed');
  }
}
