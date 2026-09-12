// Isolated Beds24 -> BSTE booking operations endpoint.
//
// This wrapper keeps the new booking-operations Google webhook separate from
// the existing owner-block Google workflow. It maps booking-specific Vercel
// environment variables only inside this serverless function, then delegates
// to the proven booking workflow handler.

export default async function handler(req, res) {
  const bookingGoogleUrl = String(process.env.BSTE_BOOKING_GOOGLE_WEBHOOK_URL || '').trim();
  const bookingSecret = String(process.env.BSTE_BOOKING_WEBHOOK_SECRET || '').trim();

  if (!bookingGoogleUrl || !bookingSecret) {
    return res.status(503).json({
      ok: false,
      error: 'BSTE booking workflow environment is not configured'
    });
  }

  const previousGoogleUrl = process.env.GOOGLE_WEBHOOK_URL;
  const previousWebhookSecret = process.env.BSTE_WEBHOOK_SECRET;

  // booking-workflow.js already prefers BSTE_BOOKING_WEBHOOK_SECRET for the
  // incoming Beds24 request. It still sends Google workflow calls through the
  // legacy variable names, so temporarily map the isolated booking values here.
  process.env.GOOGLE_WEBHOOK_URL = bookingGoogleUrl;
  process.env.BSTE_WEBHOOK_SECRET = bookingSecret;

  try {
    const workflow = await import('./booking-workflow.js');
    return await workflow.default(req, res);
  } finally {
    if (previousGoogleUrl === undefined) delete process.env.GOOGLE_WEBHOOK_URL;
    else process.env.GOOGLE_WEBHOOK_URL = previousGoogleUrl;

    if (previousWebhookSecret === undefined) delete process.env.BSTE_WEBHOOK_SECRET;
    else process.env.BSTE_WEBHOOK_SECRET = previousWebhookSecret;
  }
}
