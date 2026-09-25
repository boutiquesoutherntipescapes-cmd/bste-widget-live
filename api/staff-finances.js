import { createHash } from 'node:crypto';
import { StaffAuthError, requireStaff, assertStaffOrigin } from '../lib/staff-auth.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { draftStay, validateReceipt } from '../lib/stay-finances.js';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
async function storage(path,token,{method='GET',bytes,type}={}) {
 const cfg=operationsConfig();
 const r=await fetch(`${cfg.url}/storage/v1/object/${path}`,{method,redirect:'error',signal:AbortSignal.timeout(30000),
  headers:{apikey:cfg.key,Authorization:`Bearer ${token}`,...(type?{'Content-Type':type}:{}),'x-upsert':'false'},body:bytes});
 if(!r.ok)throw new StaffAuthError(503,'Private receipt storage rejected the request; no existing receipt was replaced');
 return r;
}
export function createFinanceHandler({authorize=requireStaff,request=operationsRequest,objects=storage}={}) {
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Cookie');
  try {
   operationsConfig();
   if(req.method!=='POST')throw new StaffAuthError(405,'Use POST');
   assertStaffOrigin(req);
   if(!String(req.headers?.['content-type']||'').startsWith('application/json'))throw new StaffAuthError(415,'JSON required');
   const {action,input={}}=req.body||{};
   const writes=['rate','review','expense','opening','upload'];
   if(![...writes,'list','detail','download'].includes(action))throw new StaffAuthError(400,'Unsupported finance action');
   const {staff,token}=await authorize(req,writes.includes(action)?'finance.write':'finance.read');
   if(action==='list') {
    const month=input.month;
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))throw new StaffAuthError(400,'Choose a checkout month');
    const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
    const rows=await request(`ops_bookings?departure=gte.${month}-01&departure=lt.${next.toISOString().slice(0,10)}&order=departure,id&limit=201`,token);
    if(rows.length>200)throw new StaffAuthError(409,'More than 200 stays; narrow the reporting scope before reconciliation');
    const rates=await request('ops_owner_rate_periods?order=starts_on,created_at&limit=501',token);
    if(rates.length>500)throw new StaffAuthError(409,'Rate history exceeds this release capacity; no incomplete calculation will be shown');
    return res.status(200).json({staff,bookings:rows,rates});
   }
   if(action==='detail') {
    if(!uuid(input.booking_id))throw new StaffAuthError(400,'Booking required');
    const q=`booking_id=eq.${input.booking_id}`;
    const [bookings,reviews,expenses,openings,source,history]=await Promise.all([
     request(`ops_bookings?id=eq.${input.booking_id}`,token),request(`ops_stay_financial_reviews?${q}&order=created_at.desc,id.desc&limit=201`,token),
     request(`ops_stay_expenses?${q}&order=created_at.desc,id.desc&limit=201`,token),request(`ops_stay_opening_positions?${q}&order=created_at.desc,id.desc&limit=201`,token),
     request(`ops_booking_financial_snapshots?${q}`,token),request('rpc/ops_finance_history',token,{method:'POST',body:{target_booking:input.booking_id}})]);
    if([reviews,expenses,openings].some(rows=>rows.length>200))throw new StaffAuthError(409,'Stay history exceeds this release capacity; no partial totals will be shown');
    if(!bookings[0])throw new StaffAuthError(404,'Booking not found');
    const attachments=expenses.length?await request(`ops_expense_attachments?expense_id=in.(${expenses.map(e=>e.id).join(',')})&limit=201`,token):[];
    if(attachments.length>200)throw new StaffAuthError(409,'Receipt history exceeds this release capacity');
    const draft=draftStay(reviews[0],expenses,openings[0],bookings[0],new Date(Date.now()+7200000).toISOString().slice(0,10));
    if(reviews[0]&&['source_price','source_currency','source_invoice_items'].some(k=>JSON.stringify(reviews[0].source_basis.financial?.[k])!==JSON.stringify(source[0]?.[k]))) {
      draft.missing.push('Imported financial source changed since review');if(draft.eligibility!=='historical_settled')draft.eligibility='needs_review';
    }
    return res.status(200).json({booking:bookings[0],reviews,expenses,openings,source:source[0]||null,attachments,history,draft});
   }
   if(action==='upload') {
    if(!uuid(input.expense_id)||!uuid(input.request_key)||typeof input.base64!=='string'||input.base64.length>2796208)throw new StaffAuthError(400,'Expense, request key and receipt required');
    const bytes=Buffer.from(input.base64,'base64');
    try{validateReceipt(bytes,input.media_type);}catch(e){throw new StaffAuthError(400,e.message);}
    const digest=createHash('sha256').update(bytes).digest('hex');
    const id=await request('rpc/ops_finance_write',token,{method:'POST',body:{action_name:'attachment',input:{expense_id:input.expense_id,request_key:input.request_key,
     original_name:input.original_name,media_type:input.media_type,size_bytes:bytes.length,sha256:digest}}});
    const [a]=await request(`ops_expense_attachments?id=eq.${id}`,token);
    if(!a||a.sha256!==digest)throw new StaffAuthError(409,'Receipt retry does not match saved evidence');
    // Retry-safe: if the object already exists and matches, acknowledge it.
    let existing;try{existing=await objects(`authenticated/ops-stay-receipts/${a.object_key}`,token);}catch{}
    if(existing) {const b=Buffer.from(await existing.arrayBuffer());if(createHash('sha256').update(b).digest('hex')!==digest)throw new StaffAuthError(409,'Receipt mismatch');}
    else await objects(`ops-stay-receipts/${a.object_key}`,token,{method:'POST',bytes,type:input.media_type});
    return res.status(200).json({saved:true,id});
   }
   if(action==='download') {
    if(!uuid(input.id))throw new StaffAuthError(400,'Receipt required');
    const [a]=await request(`ops_expense_attachments?id=eq.${input.id}`,token);if(!a)throw new StaffAuthError(404,'Receipt not found');
    const r=await objects(`authenticated/ops-stay-receipts/${a.object_key}`,token);
    const bytes=Buffer.from(await r.arrayBuffer());validateReceipt(bytes,a.media_type);
    if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw new StaffAuthError(409,'Receipt integrity check failed');
    return res.status(200).json({base64:bytes.toString('base64'),name:a.original_name,media_type:a.media_type});
   }
   const id=await request('rpc/ops_finance_write',token,{method:'POST',body:{action_name:action,input}});
   return res.status(200).json({saved:true,id});
  }catch(e){return res.status(e instanceof StaffAuthError?e.status:500).json({error:e instanceof StaffAuthError?e.message:'Finance request failed; reload before retrying'});}
 };
}
export default createFinanceHandler();
