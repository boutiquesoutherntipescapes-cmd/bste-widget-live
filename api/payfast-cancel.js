import {
  getBeds24BookingById,
  cancelBeds24DirectBooking,
  clearBeds24Blackout
} from '../lib/beds24.js';
import { verifyCheckoutState } from '../lib/payfast.js';
import { getPropertyConfig, addDays } from '../lib/booking-pricing.js';

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
  if(req.method !== 'POST') return res.status(405).json({ok:false,error:'Method not allowed'});

  try {
    const src=req.body || {};
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
      await clearBeds24Blackout(
        payload.propertySlug,
        addDays(payload.arrival,-prep),
        payload.arrival
      );
      await clearBeds24Blackout(
        payload.propertySlug,
        payload.departure,
        addDays(payload.departure,prep)
      );
    }

    return res.status(200).json({ok:true,cancelled:true,booking_id:payload.bookingId});
  } catch(err) {
    return res.status(500).json({ok:false,error:'Could not release payment hold',detail:String(err)});
  }
}
