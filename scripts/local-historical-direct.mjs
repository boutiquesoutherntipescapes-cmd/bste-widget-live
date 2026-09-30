import {createHash} from 'node:crypto';
import {StaffAuthError,requireStaff,assertStaffOrigin} from '../lib/staff-auth.js';
import {operationsRequest} from '../lib/operations-store.js';
import {assertLocalPreview} from './local-september-preview.mjs';
export const DIRECT_REFERENCE='BSTE-HIST-202609-KAL-01';
export const DIRECT_CANDIDATE=Object.freeze({property:'Kalaya Ridge Villa',property_slug:'kalay-ridge-villa-struisbaai',guest_name:'Charl Baard',arrival:'2026-09-08',departure:'2026-09-12',nights:4,adults:5,booked_on:'2026-07-27',source:'direct / BSTE website',note:'NAMPO direct booking',reference:DIRECT_REFERENCE});
const path='ops_bookings?property_slug=eq.kalay-ridge-villa-struisbaai&arrival=lt.2026-09-12&departure=gt.2026-09-08&select=id,source_kind,source_environment,source_account,beds24_booking_id,beds24_property_id,beds24_room_id,manual_reference,manual_booked_on,manual_note,manual_created_by,property_slug,guest_name,arrival,departure,adults,source_channel,source_status&order=id&limit=201';
const fail=()=>{throw new StaffAuthError(409,'Stored records conflict or changed. Inspect the historical records before proceeding.');};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function authorizeHistoricalDirect(req){
 assertLocalPreview(req);const a=await requireStaff(req,'finance.write');
 if(a.staff.role!=='administrator'||!['finance.read','finance.cutover','operations.write'].every(p=>a.staff.permissions.includes(p)))throw new StaffAuthError(403,'MFA administrator required');return a;
}
export function directRequest(url,token,options={}){
 if(options.service||!((url===path&&(options.method||'GET')==='GET'&&options.body===undefined)||(url==='rpc/ops_create_charl_historical_direct'&&options.method==='POST'&&Object.keys(options.body||{}).sort().join(',')==='expected_overlap_ids,overlaps_reviewed')))throw new StaffAuthError(403,'Unsupported historical direct request');
 return operationsRequest(url,token,options);
}
export async function readDirectState(token,request=directRequest){
 const rows=await request(path,token);if(!Array.isArray(rows)||rows.length>200)fail();
 const found=rows.filter(b=>b.source_kind==='manual_direct'&&b.manual_reference===DIRECT_REFERENCE);
 if(found.length>1)fail();
 const existing=found[0];
 if(existing&&(existing.source_environment!=='production'||existing.source_account!=='bste-historical-direct'||existing.beds24_booking_id!==null
  ||existing.property_slug!==DIRECT_CANDIDATE.property_slug||existing.beds24_property_id!==352005||existing.beds24_room_id!==726060
  ||existing.guest_name!=='Charl Baard'||existing.adults!==5||existing.arrival!==DIRECT_CANDIDATE.arrival||existing.departure!==DIRECT_CANDIDATE.departure
  ||existing.manual_booked_on!==DIRECT_CANDIDATE.booked_on||existing.manual_note!==DIRECT_CANDIDATE.note||!existing.manual_created_by
  ||existing.source_status!=='confirmed'||existing.source_channel!==DIRECT_CANDIDATE.source))fail();
 if(rows.some(b=>b.id!==existing?.id&&b.arrival===DIRECT_CANDIDATE.arrival&&b.departure===DIRECT_CANDIDATE.departure&&String(b.guest_name||'').trim().toLowerCase()==='charl baard'))fail();
 return {rows,existing,overlaps:rows.filter(b=>b.id!==existing?.id)};
}
function display(s){return {candidate:DIRECT_CANDIDATE,already_exists:!!s.existing,overlap_count:s.overlaps.length,overlaps:s.overlaps.map((b,i)=>({record:i+1,arrival:b.arrival,departure:b.departure,source:b.source_kind==='manual_direct'?'Historical direct':'Beds24',status:b.source_status})),notice:'Historical finance record only. No inventory, opening position, payment or communication changes. Identity documents must never be entered.'};}
export function createHistoricalDirectHandler({request=directRequest,now=Date.now}={}){
 const previews=new Map();let busy=false,uncertain=false;
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');
  try{
   assertLocalPreview(req);if(req.method!=='POST')throw new StaffAuthError(405,'POST only');assertStaffOrigin(req);
   if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json')throw new StaffAuthError(415,'JSON only');
   const body=req.body;if(!body||!['preview','create'].includes(body.action)||Object.keys(body).some(k=>!['action','confirmed','overlaps_reviewed'].includes(k)))throw new StaffAuthError(400,'Unsupported request fields');
   const {staff,token}=await authorizeHistoricalDirect(req);
   if(uncertain)throw new StaffAuthError(409,'Outcome uncertain. Inspect staging before retrying or restarting.');
   if(busy)throw new StaffAuthError(409,'Request already running');busy=true;
   try{
    const key=hash([staff.user_id,token]),state=await readDirectState(token,request);
    if(body.action==='preview'){if(previews.size>=16)previews.clear();previews.set(key,{fingerprint:hash(state.rows),at:now()});return res.status(200).json(display(state));}
    if(body.confirmed!==true)throw new StaffAuthError(400,'Explicit confirmation required');
    const p=previews.get(key);if(!p||now()-p.at>25*60000||p.fingerprint!==hash(state.rows))fail();
    if(state.existing)return res.status(200).json({...display(state),saved:true,created:false});
    if(state.overlaps.length&&body.overlaps_reviewed!==true)throw new StaffAuthError(409,'Review and acknowledge the existing overlapping stays first');
    previews.delete(key);
    try{
     const id=await request('rpc/ops_create_charl_historical_direct',token,{method:'POST',body:{expected_overlap_ids:state.overlaps.map(b=>b.id).sort(),overlaps_reviewed:body.overlaps_reviewed===true}});
     const after=await readDirectState(token,request);
     if(!after.existing||after.existing.id!==id||hash(after.overlaps)!==hash(state.overlaps))fail();
     previews.set(key,{fingerprint:hash(after.rows),at:now()});
     return res.status(200).json({...display(after),saved:true,created:true});
    }catch{uncertain=true;throw new StaffAuthError(409,'Creation outcome unconfirmed. Inspect staging before retrying or restarting.');}
   }finally{busy=false;}
  }catch(e){return res.status(e instanceof StaffAuthError?e.status:409).json({error:e instanceof StaffAuthError?e.message:'Historical direct request blocked. Inspect staging.'});}
 };
}
export default createHistoricalDirectHandler();
