import { getBeds24BookingById } from '../lib/beds24.js';
import { verifyCheckoutState } from '../lib/payfast.js';

function payloadFrom(src) {
  return {
    bookingId:Number(src.booking_id || 0),
    propertySlug:String(src.property || ''),
    arrival:String(src.arrival || ''),
    departure:String(src.departure || ''),
    reference:String(src.reference || '')
  };
}

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method !== 'GET') return res.status(405).json({ok:false,error:'Method not allowed'});

  try {
    const src=req.query || {};
    const payload=payloadFrom(src);
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
