import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { loadDashboard, refreshBookings } from '../lib/operations-service.js';

function googleGuestTestConfig() {
  const url = String(process.env.BSTE_BOOKING_GOOGLE_WEBHOOK_URL || '').trim();
  const secret = String(process.env.BSTE_BOOKING_WEBHOOK_SECRET || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url) || !secret) {
    throw new StaffAuthError(503,'Google guest delivery test is not configured');
  }
  return { url, secret };
}

async function sendGuestCommunicationTest({ booking, communication }) {
  const { url, secret } = googleGuestTestConfig();
  const guestFirstName = String(booking.guest_name || 'Sample Guest').trim().split(/\s+/)[0] || 'Sample Guest';
  const guestCount = Math.max(0, Number(booking.adults || 0)) + Math.max(0, Number(booking.children || 0));
  let response;
  try {
    response = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        secret,
        action:'guest_delivery_test',
        test_only:true,
        communication:{
          id:communication.id,
          message_key:communication.message_key,
          route:communication.route,
          scheduled_at:communication.scheduled_at,
          automation_enabled:false
        },
        booking:{
          propertySlug:booking.property_slug,
          guestFirstName,
          guestCount,
          arrivalDate:booking.arrival,
          departureDate:booking.departure
        }
      }),
      redirect:'error',
      signal:AbortSignal.timeout(15000)
    });
  } catch {
    throw new StaffAuthError(503,'Google guest delivery test is temporarily unavailable');
  }
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok || !result?.ok || result?.test_only !== true
      || result?.recipient !== 'boutiquesoutherntipescapes@gmail.com'
      || result?.queue_mutated !== false || result?.live_guest_sending_enabled !== false) {
    throw new StaffAuthError(503,'Google guest delivery test failed safely');
  }
  return result;
}
export function createOperationsHandler({ authorize=requireStaff, request=operationsRequest, load=loadDashboard, refresh=refreshBookings }={}) {
 return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store'); res.setHeader('Vary','Cookie');
  res.setHeader('X-Frame-Options','DENY'); res.setHeader('X-Content-Type-Options','nosniff');
  try {
    operationsConfig(); // Check isolated destination before any authentication/data call.
    if (req.method==='GET') {
      const {staff,token}=await authorize(req);
      return res.status(200).json({staff,...await load(token,request)});
    }
    if (req.method!=='POST') { res.setHeader('Allow','GET, POST'); throw new StaffAuthError(405,'Method not allowed'); }
    assertStaffOrigin(req);
    if (!String(req.headers?.['content-type']||'').startsWith('application/json')) throw new StaffAuthError(415,'JSON required');
    const { action, booking_id, communication_id, status, reason }=req.body||{};
    const permission = {sync:'sync.run',operational:'operations.write',payment:'finance.write',enroll_communications:'operations.write',test_communication:'operations.write'}[action];
    if (!permission) throw new StaffAuthError(400,'Unknown operations action');
    const {staff,token}=await authorize(req,permission);
    if (action==='sync') return res.status(200).json(await refresh(token,{request}));
    if (action==='enroll_communications') {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(booking_id||'')) throw new StaffAuthError(400,'Booking is required');
      const result=await request('rpc/ops_preview_enroll_communications',token,{method:'POST',body:{target_booking:booking_id}});
      return res.status(200).json(result);
    }
    if (action==='test_communication') {
      const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(booking_id||'') || !uuid.test(communication_id||'')) throw new StaffAuthError(400,'Booking and communication are required');
      const [bookings,communications]=await Promise.all([
        request('ops_bookings?select=id,property_slug,arrival,departure,guest_name,adults,children,automation_enrolled_at&id=eq.'+encodeURIComponent(booking_id)+'&limit=1',token),
        request('ops_communications?select=id,booking_id,message_key,route,scheduled_at,status,automation_enabled&id=eq.'+encodeURIComponent(communication_id)+'&booking_id=eq.'+encodeURIComponent(booking_id)+'&limit=1',token)
      ]);
      const booking=Array.isArray(bookings)?bookings[0]:null;
      const communication=Array.isArray(communications)?communications[0]:null;
      if (!booking?.automation_enrolled_at || !communication) throw new StaffAuthError(409,'Persisted enrolled communication is unavailable');
      if (communication.status!=='scheduled' || communication.automation_enabled!==false || communication.route==='unresolved') throw new StaffAuthError(409,'Communication is not eligible for the safe test');
      return res.status(200).json(await sendGuestCommunicationTest({booking,communication}));
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(booking_id||'')
      || typeof reason!=='string' || !reason.trim() || reason.length>2000) throw new StaffAuthError(400,'Booking and a reason/evidence note are required');
    const valid = action==='operational' ? ['confirmed','review_required','checked_in','checked_out']
      : ['unknown','unpaid','part_paid','deposit_paid','paid','channel_managed'];
    if (!valid.includes(status)) throw new StaffAuthError(400,'Unsupported status');
    // RLS/user JWT stamps actual user and timestamp. No service role for staff changes.
    await request(action==='operational' ? 'ops_booking_overrides' : 'ops_payment_records',token,{method:'POST',body:
      action==='operational' ? {booking_id,operational_status:status,reason:reason.trim(),created_by:staff.user_id}
      : {booking_id,entry_kind:'review',review_status:status,note:reason.trim(),created_by:staff.user_id}});
    return res.status(200).json({saved:true});
  } catch(error) {
    return res.status(error instanceof StaffAuthError?error.status:500).json({error:error instanceof StaffAuthError?error.message:'Operations request failed'});
  }
 };
}
export default createOperationsHandler();
