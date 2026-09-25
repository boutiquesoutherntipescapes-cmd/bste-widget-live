import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { assertLocalPreview } from './local-september-preview.mjs';
import { selectApproved } from './september-import-selection.mjs';
import { PROPERTIES } from '../lib/operations-model.js';
export const REPAIR_REASON='Repair incomplete September historical backfill after validated schema/write-path correction';
const tables={ops_bookings:18,ops_historical_batches:2,ops_historical_results:2,ops_stay_opening_positions:4};
const fail=()=>{throw new StaffAuthError(409,'REPAIR_STATE_CONFLICT');};
export async function authorizeRepair(req) {
 assertLocalPreview(req);
 // requireStaff verifies the live Auth session and database-required AAL2 before returning.
 const access=await requireStaff(req,'sync.run');
 if(access.staff.role!=='administrator'||!['finance.read','finance.write','finance.cutover'].every(p=>access.staff.permissions.includes(p)))throw new StaffAuthError(403,'MFA administrator required');
 return access;
}
export function repairRequest(path,token,options={}) {
 const read=Object.entries(tables).some(([table,limit])=>path===`${table}?select=*&order=${table==='ops_historical_results'?'batch_id':'id'}.asc&limit=${limit}`);
 const write=path==='rpc/ops_repair_september_openings'&&options.method==='POST'&&options.body?.repair_reason===REPAIR_REASON
  &&/^[0-9a-f-]{36}$/.test(options.body?.target_batch||'')&&Object.keys(options.body).length===2;
 if(options.service||!(read&&(options.method||'GET')==='GET'&&options.body===undefined||write))throw new StaffAuthError(403,'Repair request not allowed');
 return operationsRequest(path,token,options);
}
export async function readRepairState(token,request=repairRequest) {
 const data={};
 for(const [table,limit] of Object.entries(tables)) {
  data[table]=await request(`${table}?select=*&order=${table==='ops_historical_results'?'batch_id':'id'}.asc&limit=${limit}`,token);
  if(!Array.isArray(data[table]))fail();
 }
 const {ops_bookings:bookings,ops_historical_batches:batches,ops_historical_results:results,ops_stay_opening_positions:openings}=data;
 if(bookings.length!==17||batches.length!==1||results.length!==1||![0,3].includes(openings.length))fail();
 const batch=batches[0],result=results[0];
 if(!/^[0-9a-f-]{36}$/.test(batch.id)||batch.source_account!==operationsConfig().account||batch.source_environment!=='production'
  ||batch.scope_from!=='2026-09-01'||batch.scope_through!=='2026-09-23'||batch.bond_confirmed!==true
  ||!Array.isArray(batch.approved_items)||batch.approved_items.length!==3||result.batch_id!==batch.id
  ||result.booking_count!==3||result.settlement_count!==0||result.retained_opening_count!==0
  ||result.newly_created_opening_count!==null||result.preserved_opening_count!==null)fail();
 const selected=selectApproved({account:batch.source_account,duplicates:[],localConflicts:[],entries:batch.approved_items.map(item=>({item,masked:{classification:'guest_candidate'}}))});
 const candidates=selected.map(({item})=>{
  const s=item.snapshot,raw=item.raw;
  if(item.settle!==false||(item.expected_id!=null&&item.expected_id!=='')||!raw||Array.isArray(raw)||typeof raw!=='object')fail();
  for(const field of ['isBlocked','ownerStay'])if(raw[field]!=null&&raw[field]!==false)fail();
  if(['type','bookingType','booking_type','subType'].some(k=>/^(owner([ _-]stay)?|block(ed)?|maintenance|non[ _-]guest)$/i.test(String(raw[k]||''))))fail();
  const matches=bookings.filter(b=>b.source_environment===s.source_environment&&b.source_account===s.source_account&&b.beds24_booking_id===s.beds24_booking_id);
  if(matches.length!==1)fail();
  const b=matches[0];
  if(!['property_slug','beds24_property_id','beds24_room_id','arrival','departure','source_status','source_channel'].every(k=>b[k]===s[k]))fail();
  const os=openings.filter(o=>o.booking_id===b.id);
  if(os.length>1||os.some(o=>o.previous_id!==null||o.opening_period!==true||o.state!=='open'||o.owner_settlement_state!=='outstanding'||o.cleaner_settlement_state!=='outstanding'||o.owner_settled_cents!==0||o.cleaner_settled_cents!==0))fail();
  return {booking:b,opening:os[0]||null};
 });
 if(openings.length&&candidates.some(c=>!c.opening))fail();
 return {data,batch,candidates,complete:openings.length===3};
}
function display(state) {
 return {batch_id:state.batch.id,complete:state.complete,counts:{bookings:17,batches:1,results:1,openings:state.complete?3:0},candidates:state.candidates.map(({booking:b,opening})=>({property:PROPERTIES.find(p=>p.slug===b.property_slug).name,arrival:b.arrival,departure:b.departure,channel:b.source_channel,current_opening:opening?'open / outstanding':'missing'})),intended:{opening_period:true,state:'open',owner_settlement_state:'outstanding',cleaner_settlement_state:'outstanding',owner_settled_cents:0,cleaner_settled_cents:0},reason:REPAIR_REASON};
}
export function createLocalRepairHandler({request=repairRequest,now=Date.now}={}) {
 const previews=new Map();let busy=false,uncertain=false;
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');
  try {
   assertLocalPreview(req);
   if(req.method!=='POST')throw new StaffAuthError(405,'POST required');
   assertStaffOrigin(req);
   if(String(req.headers['content-type']||'').split(';')[0].trim()!=='application/json')throw new StaffAuthError(415,'JSON required');
   const body=req.body;
   if(!body||!['preview','repair'].includes(body.action)||Object.keys(body).some(k=>!['action','confirmed'].includes(k))||body.action==='repair'&&body.confirmed!==true)throw new StaffAuthError(400,'Confirmation required');
   const {staff,token}=await authorizeRepair(req);
   if(uncertain)return res.status(409).json({error:'OUTCOME_UNCERTAIN: Stop and inspect staging before doing anything else. No automatic retry.'});
   if(busy)throw new StaffAuthError(409,'Busy');
   busy=true;
   try {
    const key=createHash('sha256').update(staff.user_id+'\0'+token).digest('hex');
    const state=await readRepairState(token,request);
    if(body.action==='preview') {
     if(previews.size>=16)previews.clear();
     previews.set(key,{state,at:now()});return res.status(200).json(display(state));
    }
    const saved=previews.get(key);
    if(!saved||now()-saved.at>25*60000||!isDeepStrictEqual(saved.state,state))fail();
    // Already verified complete: a repeated click/reload performs reads only.
    if(state.complete)return res.status(200).json({...display(state),success:true,newly_created_opening_count:0,preserved_opening_count:3,settlement_count:0});
    previews.delete(key);
    // Once dispatch starts, any error is uncertain, even a lost success response.
    try {
     const result=await request('rpc/ops_repair_september_openings',token,{method:'POST',body:{target_batch:state.batch.id,repair_reason:REPAIR_REASON}});
     if(result?.newly_created_opening_count!==3||result.preserved_opening_count!==0||result.settlement_count!==0)fail();
     const after=await readRepairState(token,request);
     if(!after.complete||!['ops_bookings','ops_historical_batches','ops_historical_results'].every(t=>isDeepStrictEqual(after.data[t],state.data[t])))fail();
     previews.set(key,{state:after,at:now()});
     return res.status(200).json({...display(after),success:true,newly_created_opening_count:3,preserved_opening_count:0,settlement_count:0});
    } catch {uncertain=true;return res.status(409).json({error:'OUTCOME_UNCERTAIN: Stop and inspect staging before doing anything else. No automatic retry.'});}
   } finally {busy=false;}
  } catch(error) {
   return res.status(error instanceof StaffAuthError?error.status:409).json({error:'REPAIR_BLOCKED: Authentication, preview or staging state could not be verified. Nothing retried.'});
  }
 };
}
export default createLocalRepairHandler();
