import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { previewHistorical } from '../lib/beds24-historical-backfill.js';
import { rememberImportPreview } from './september-import-selection.mjs';
import { browserPreviewReport } from './september-preview-report.mjs';
export function assertLocalPreview(req) {
 operationsConfig();
 if(process.env.BSTE_STAFF_ENV!=='staging'||process.env.VERCEL_ENV||process.env.VERCEL||process.env.BSTE_STAFF_ORIGIN!=='https://localhost:3443'
  ||req.headers?.host!=='localhost:3443'||req.socket?.encrypted!==true||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))throw new StaffAuthError(403,'Local staging only');
}
export async function authorizePreview(req) {
 assertLocalPreview(req);
 // Existing verification checks provider identity, active session and database AAL2.
 const result=await requireStaff(req,'sync.run');
 if(result.staff.role!=='administrator'||!result.staff.permissions.includes('finance.read'))throw new StaffAuthError(403,'MFA administrator required');
 return result;
}
export function readOnlyPreviewRequest(path,token,options={}) {
 if((options.method||'GET')!=='GET'||options.body!==undefined||options.service||!(path==='rpc/ops_staff_access'||path.startsWith('ops_bookings?')))throw new StaffAuthError(403,'Preview permits reads only');
 return operationsRequest(path,token,{method:'GET'});
}
export async function readOnlyBeds24(url,options) {
 const u=new URL(url);
 if(u.origin!=='https://beds24.com'||u.pathname!=='/api/v2/bookings'||options?.method!=='GET'||options.body!==undefined||options.redirect!=='error')throw new StaffAuthError(403,'Preview permits Beds24 reads only');
 return fetch(url,options);
}
export function createLocalPreviewHandler({preview=previewHistorical}={}) {
 let running=false;
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');res.setHeader('X-Frame-Options','DENY');
  try {
   assertLocalPreview(req);
   if(req.method!=='POST'){res.setHeader('Allow','POST');throw new StaffAuthError(405,'POST required');}
   assertStaffOrigin(req);
   if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json')throw new StaffAuthError(415,'JSON required');
   if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new StaffAuthError(400,'Preview takes no parameters');
   const {staff,token}=await authorizePreview(req);
   if(!process.env.BEDS24_LONG_LIFE_TOKEN)throw new StaffAuthError(503,'Read-only Beds24 credential unavailable');
   if(running)throw new StaffAuthError(409,'A preview is already running');
   running=true;
   try {
    const result=await preview({staffToken:token,token:process.env.BEDS24_LONG_LIFE_TOKEN,request:readOnlyPreviewRequest,fetcher:readOnlyBeds24});
    const handoff=rememberImportPreview(staff.user_id,token,result);
    return res.status(200).json({...browserPreviewReport(result),...handoff});
   } finally {running=false;}
  } catch(error) {
   // Fixed errors only: never serialize provider payloads, credentials or arbitrary messages.
   const status=error instanceof StaffAuthError?error.status:503;
   return res.status(status).json({error:status===401||status===403?'A valid local MFA administrator session is required. Sign in again if expired.':'Preview unavailable or request rejected. No import was performed. No automatic retry.'});
  }
 };
}
export default createLocalPreviewHandler();
