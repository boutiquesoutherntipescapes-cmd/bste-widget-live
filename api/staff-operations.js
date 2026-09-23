import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { loadDashboard, refreshBookings } from '../lib/operations-service.js';
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
    const { action, booking_id, status, reason }=req.body||{};
    const permission = {sync:'sync.run',operational:'operations.write',payment:'finance.write'}[action];
    if (!permission) throw new StaffAuthError(400,'Unknown operations action');
    const {staff,token}=await authorize(req,permission);
    if (action==='sync') return res.status(200).json(await refresh(token,{request}));
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
