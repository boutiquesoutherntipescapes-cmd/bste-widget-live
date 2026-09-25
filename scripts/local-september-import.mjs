import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { applyApprovedHistorical } from '../lib/beds24-historical-backfill.js';
import { assertLocalPreview } from './local-september-preview.mjs';
import { getImportSelection, selectApproved, selectionDisplay, HandoffError, HANDOFF_MESSAGES } from './september-import-selection.mjs';
export async function authorizeImport(req){
 assertLocalPreview(req);const result=await requireStaff(req,'sync.run');
 if(result.staff.role!=='administrator'||!['finance.write','finance.read','finance.cutover'].every(p=>result.staff.permissions.includes(p)))throw new StaffAuthError(403,'MFA administrator required');
 return result;
}
// Only the existing historical approval/apply RPCs can write. No Beds24 call exists here.
export function controlledImportRequest(path,token,options={}){
 const method=options.method||'GET';
 if(method==='GET'&&!options.service&&options.body===undefined&&(path.startsWith('ops_bookings?')||path.startsWith('ops_stay_opening_positions?')))return operationsRequest(path,token,{method:'GET'});
 if(method==='POST'&&path==='rpc/ops_stage_historical_batch'&&!options.service){
  if(!Array.isArray(options.body?.approved_items)||options.body.approved_items.length<1||options.body.approved_items.length>3||options.body.approved_items.some(i=>i.settle!==false))throw Error('Settlement forbidden');
  return operationsRequest(path,token,options);
 }
 if(method==='POST'&&path==='rpc/ops_apply_historical_batch'&&options.service===true&&Object.keys(options.body||{}).join() ==='batch_id')return operationsRequest(path,token,options);
 throw Error('Import action forbidden');
}
async function bookings(request,token){
 const rows=[];for(let offset=0;offset<=2000;offset+=200){const page=await request(`ops_bookings?select=*&order=id&limit=200&offset=${offset}`,token);if(!Array.isArray(page))throw Error('Invalid booking response');rows.push(...page);if(rows.length>2000)throw Error('Booking limit');if(page.length<200)return rows;}throw Error('Incomplete bookings');
}
async function verifyOpenings(entries,rows,request,token,account){
 let count=0;for(const e of entries){const s=e.item.snapshot;const b=rows.find(b=>b.source_environment==='production'&&b.source_account===account&&b.beds24_booking_id===s.beds24_booking_id);
  if(!b)throw Error('Imported identity missing');
  for(const f of ['property_slug','beds24_property_id','beds24_room_id','arrival','departure','source_status','source_channel'])if(b[f]!==s[f])throw Error('Source changed; stop and review');
  const history=await request(`ops_stay_opening_positions?booking_id=eq.${encodeURIComponent(b.id)}&order=created_at.desc,id.desc&limit=1`,token);const o=history?.[0];
  if(!o||!o.opening_period||o.state!=='open'||o.owner_settlement_state!=='outstanding'||o.cleaner_settlement_state!=='outstanding'||Number(o.owner_settled_cents)!==0||Number(o.cleaner_settled_cents)!==0)throw Error('Opening position needs administrator review; not overwritten');count++;
 }return count;
}
export async function runControlledImport(selection,token,{request=controlledImportRequest,apply=applyApprovedHistorical}={}){
 const {account,ref}=operationsConfig();if(selection.preview.account!==account)throw Error('Account changed');
 const entries=selectApproved(selection.preview);
 if(entries.some((e,i)=>e.item.snapshot.beds24_booking_id!==selection.ids[i]))throw Error('Preview identities changed');
 const before=await bookings(request,token);
 const existing=entries.filter(e=>before.some(b=>b.source_environment==='production'&&b.source_account===account&&b.beds24_booking_id===e.item.snapshot.beds24_booking_id));
 await verifyOpenings(existing,before,request,token,account);
 const missing=entries.filter(e=>!existing.includes(e));
 if(missing.some(e=>e.expected_id!==null))throw Error('Previously stored booking missing');
 let counters={newly_created_opening_count:0,preserved_opening_count:existing.length,settlement_count:0};
 if(missing.length){
  const key=process.env.BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw Error('Staging importer credential unavailable');
  if(!key.startsWith('sb_secret_')){let claims;try{claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url'));}catch{throw Error('Invalid importer credential');}if(claims.role!=='service_role'||claims.ref!==ref)throw Error('Wrong importer project');}
  const applied=await apply(selection.preview,{digest:selection.preview.digest,confirmed_by_bond:true,reason:'Bond approved three September completed opening-period stays; owner and cleaner outstanding; funds recorded separately.',import_ids:missing.map(e=>e.item.snapshot.beds24_booking_id),settle_ids:[]},{staffToken:token,request});
  if(!applied||applied.booking_count!==missing.length||!Number.isInteger(applied.newly_created_opening_count)||!Number.isInteger(applied.preserved_opening_count)||applied.newly_created_opening_count<0||applied.preserved_opening_count<0||applied.newly_created_opening_count+applied.preserved_opening_count!==missing.length||applied.settlement_count!==0)throw Error('Opening result counters unconfirmed; inspect staging before retrying');
  counters={newly_created_opening_count:applied.newly_created_opening_count,preserved_opening_count:existing.length+applied.preserved_opening_count,settlement_count:applied.settlement_count};
 }
 const after=await bookings(request,token);
 if(after.length!==before.length+missing.length)throw Error('Unexpected booking count; review before any retry');
 for(const row of before)if(JSON.stringify(after.find(b=>b.id===row.id))!==JSON.stringify(row))throw Error('Existing booking changed; review before any retry');
 const openingCount=await verifyOpenings(entries,after,request,token,account);
 return {...counters,imported_count:missing.length,already_existing_count:existing.length,opening_period_count:openingCount,total_bookings:after.length,exceptions:[],owner_obligation:'outstanding',cleaner_obligation:'outstanding',funds_received_recorded:false,normal_sync_changed:false};
}
export function createLocalImportHandler({run=runControlledImport,selection=getImportSelection}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');
  let phase='request';
  try{
   assertLocalPreview(req);if(req.method!=='POST'){res.setHeader('Allow','POST');throw new StaffAuthError(405,'POST required');}
   assertStaffOrigin(req);if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json')throw new StaffAuthError(415,'JSON required');
   const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||!['show','import'].includes(body.action)||Object.keys(body).some(k=>!['action','confirmed'].includes(k))||body.action==='import'&&body.confirmed!==true)throw new StaffAuthError(400,'Explicit confirmation required');
   phase='authentication';const {staff,token}=await authorizeImport(req);phase='selection';const saved=selection(staff.user_id,token);
   if(body.action==='show')return res.status(200).json({candidates:selectionDisplay(saved)});
   if(saved.running)throw new StaffAuthError(409,'Import already running');
   if(saved.result)return res.status(200).json({...saved.result,imported_count:0,already_existing_count:3,newly_created_opening_count:0,preserved_opening_count:3,settlement_count:0,replayed:true});
   phase='import';saved.running=true;try{const result=await run(saved,token);saved.result=result;return res.status(200).json(result);}finally{saved.running=false;}
  }catch(e){
   const code=e instanceof HandoffError?e.code:phase==='authentication'?(e instanceof StaffAuthError&&e.status===401?'AUTHENTICATION_REQUIRED':e instanceof StaffAuthError&&e.status===403?'PERMISSION_DENIED':'AUTHENTICATION_UNAVAILABLE'):phase==='import'?'IMPORT_UNCONFIRMED':phase==='request'?'REQUEST_REJECTED':'HANDOFF_UNAVAILABLE';
   const messages={AUTHENTICATION_REQUIRED:'Sign in again with MFA; the session is missing, expired or invalid.',PERMISSION_DENIED:'An active MFA Administrator with all required import permissions is required.',AUTHENTICATION_UNAVAILABLE:'Session verification is unavailable. No automatic retry.',REQUEST_REJECTED:'Request rejected by local staging, method, origin or confirmation safeguards.',HANDOFF_UNAVAILABLE:'Selection lookup/display failed. Import remains blocked.',IMPORT_UNCONFIRMED:'Import result could not be confirmed. Inspect staging before retrying.'};
   return res.status(e instanceof StaffAuthError?e.status:409).json({code,error:HANDOFF_MESSAGES[code]||messages[code]});
  }
 };
}
export default createLocalImportHandler();
