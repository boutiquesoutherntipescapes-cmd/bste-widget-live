// Historical discovery is separate from current/future sync. No writes during preview.
import { createHash } from 'node:crypto';
import { PROPERTIES } from './operations-model.js';
import { mapBooking } from './beds24-operations-import.js';
import { operationsConfig, operationsRequest } from './operations-store.js';
export const HISTORICAL_SCOPE=Object.freeze({from:'2026-09-01',through:'2026-09-23',environment:'production'});
export const cutoffEligible=departure=>typeof departure==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(departure)&&
 Number.isFinite(Date.parse(departure+'T00:00:00Z'))&&new Date(departure+'T00:00:00Z').toISOString().slice(0,10)===departure&&departure<='2026-09-23';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const safeLabel=value=>String(value??'').replace(/[^\s@]+@[^\s@]+/g,'[redacted]').replace(/\+?[\d ()-]{7,}/g,'[redacted]').slice(0,80);
const safeDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:null;
const nonGuest=raw=>raw.isBlocked===true||raw.ownerStay===true||[raw.type,raw.bookingType,raw.booking_type,raw.subType].some(v=>typeof v==='string'&&/^(owner(?:[ _-]stay)?|block(?:ed)?|maintenance|non[ _-]guest)$/i.test(v));
const category=status=>({new:'guest_candidate',confirmed:'guest_candidate',request:'request',inquiry:'inquiry',cancelled:'cancelled',black:'block'})[String(status).toLowerCase()]||'unusual_status';
export async function collectHistorical({token,account,now=new Date(),fetcher=fetch}) {
 if(!token||!account)throw new Error('Historical discovery configuration missing');
 const items=[],exceptions=[],seen=new Map(),duplicates=[];
 for(const property of PROPERTIES)for(let page=1;page<=100;page++) {
  const url=new URL('https://beds24.com/api/v2/bookings');url.searchParams.set('roomId',String(property.roomId));
  // Conservative overlap; exact inclusive scope is enforced below. No status filter:
  // exceptions must be visible, not silently hidden. Provider filter semantics need live verification.
  url.searchParams.set('departureFrom','2026-08-31');url.searchParams.set('departureTo','2026-09-24');
  url.searchParams.set('includeInvoiceItems','true');url.searchParams.set('page',String(page));
  let data;try{const r=await fetcher(url.toString(),{method:'GET',headers:{token,accept:'application/json','Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw new Error();data=await r.json();}catch{throw new Error('Historical Beds24 read failed; no writes performed');}
  if(!Array.isArray(data?.data)||typeof data?.pages?.nextPageExists!=='boolean')throw new Error('Incomplete historical pagination; no writes performed');
  for(const raw of data.data) {
   if(typeof raw.departure!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw.departure))throw new Error('Historical source has invalid dates');
   if(raw.departure<HISTORICAL_SCOPE.from||raw.departure>HISTORICAL_SCOPE.through)continue;
   const masked={booking_id:Number.isSafeInteger(Number(raw.id))?Number(raw.id):null,property:property.slug,arrival:safeDate(raw.arrival),departure:raw.departure,
    raw_status:safeLabel(raw.status),channel:safeLabel(raw.channel||raw.referer||raw.apiSource),classification:nonGuest(raw)?'non_guest':category(raw.status)};
   const key=String(raw.id),fingerprint=hash(raw);
   if(seen.has(key)){duplicates.push({...masked,condition:seen.get(key)===fingerprint?'identical_duplicate':'conflicting_duplicate'});continue;}
   seen.set(key,fingerprint);
   if(seen.size>2000)throw new Error('Historical discovery exceeds safety limit');
   try{const item=mapBooking(raw,property,now.toISOString(),account);items.push({item,masked});}
   catch{exceptions.push({...masked,condition:'invalid_or_unsupported_source'});}
  }
  if(!data.pages.nextPageExists)break;if(page===100)throw new Error('Historical pagination exceeds safety limit');
 }
 return{items,exceptions,duplicates};
}
export function makeHistoricalPreview(discovery,stored,account) {
 const byId=new Map();const localConflicts=[];
 for(const b of stored){if(b.source_environment!=='production'||b.source_account!==account)throw new Error('Wrong stored source identity');
  const key=String(b.beds24_booking_id);if(byId.has(key))localConflicts.push({booking_id:b.beds24_booking_id,condition:'duplicate_local_identity'});byId.set(key,b);}
 const entries=discovery.items.map(({item,masked})=>{
  const old=byId.get(String(item.snapshot.beds24_booking_id));const changed=[];
  if(old){for(const [k,v] of Object.entries(item.snapshot))if(!['source_modified_at','source_observed_at'].includes(k)&&canonical(old[k]??null)!==canonical(v??null))changed.push(k);
   for(const k of ['source_price','source_currency','source_deposit','source_invoice_items']) {
    const before=old.ops_booking_financial_snapshots?.[k]??null,after=item.financial[k]??null;
    if(k==='source_price'&&before!=null&&after!=null?Number(before)!==Number(after):canonical(before)!==canonical(after))changed.push(k);
   }
  }
  return{item,expected_id:old?.id??null,expected_last_synced_at:old?.last_synced_at??null,
   masked:{...masked,storage:old?'already_stored':'missing_locally',changed_fields:changed,condition:changed.length?'changed_source':old?'unchanged':'new_local_record'}};
 });
 const returned=new Set(entries.map(e=>String(e.item.snapshot.beds24_booking_id)));
 const localOnly=stored.filter(b=>b.departure>=HISTORICAL_SCOPE.from&&b.departure<=HISTORICAL_SCOPE.through&&!returned.has(String(b.beds24_booking_id))).map(b=>({booking_id:b.beds24_booking_id,property:b.property_slug,arrival:b.arrival,departure:b.departure,raw_status:b.source_status,condition:'stored_not_returned_no_deletion'}));
 const payload={scope:HISTORICAL_SCOPE,account,entries,exceptions:discovery.exceptions,duplicates:discovery.duplicates,localConflicts,localOnly};
 const digest=hash(payload);
 return {...payload,digest,report:{scope:HISTORICAL_SCOPE,account,digest,records:entries.map(e=>e.masked),exceptions:discovery.exceptions,duplicates:discovery.duplicates,localConflicts,localOnly,
  can_apply:!localConflicts.length&&!discovery.duplicates.some(d=>d.condition==='conflicting_duplicate'),
  notice:'Preview only: no staging writes. Guest candidates are not automatically confirmed or settled.'}};
}
export async function previewHistorical({staffToken,token,request=operationsRequest,fetcher=fetch,now=new Date()}={}) {
 const {account}=operationsConfig();if(!staffToken||!token)throw new Error('Read-only token and MFA staff access token required');
 const access=await request('rpc/ops_staff_access',staffToken);
 if(!access?.active||access.role!=='administrator'||!access.mfa_satisfied||!access.permissions?.includes('sync.run')||!access.permissions?.includes('finance.read'))throw new Error('MFA administrator access required');
 const stored=[];
 for(let offset=0;offset<=2000;offset+=200){const rows=await request(`ops_bookings?source_environment=eq.production&source_account=eq.${encodeURIComponent(account)}&select=*,ops_booking_financial_snapshots(*)&order=id&limit=200&offset=${offset}`,staffToken);
  if(!Array.isArray(rows))throw new Error('Invalid staging snapshot');stored.push(...rows);if(stored.length>2000)throw new Error('Stored booking safety limit exceeded');if(rows.length<200)break;}
 const discovery=await collectHistorical({token,account,now,fetcher});return makeHistoricalPreview(discovery,stored,account);
}
// Deliberate separate write API, never invoked by the preview CLI. Caller must obtain
// fresh preview and explicit per-ID approval. RPC stages exact immutable payload;
// importer applies only that staged payload, not caller-supplied replacement data.
export async function applyApprovedHistorical(preview,approval,{staffToken,request=operationsRequest}={}) {
 const {account}=operationsConfig();
 if(account!==preview.account||hash({scope:preview.scope,account:preview.account,entries:preview.entries,exceptions:preview.exceptions,duplicates:preview.duplicates,localConflicts:preview.localConflicts,localOnly:preview.localOnly})!==preview.digest)throw new Error('Preview identity or content changed');
 if(preview.localConflicts.length||preview.duplicates.some(d=>d.condition==='conflicting_duplicate')||approval?.digest!==preview.digest||approval?.confirmed_by_bond!==true||!approval?.reason?.trim()||!Array.isArray(approval.import_ids)||!Array.isArray(approval.settle_ids))throw new Error('Explicit Bond-approved preview selection required');
 if(new Set(approval.import_ids).size!==approval.import_ids.length||new Set(approval.settle_ids).size!==approval.settle_ids.length)throw new Error('Duplicate approval selection');
 const entries=approval.import_ids.map(id=>{const e=preview.entries.find(e=>e.item.snapshot.beds24_booking_id===id);if(!e)throw new Error('Selection outside preview');return e;});
 if(!entries.length)throw new Error('No bookings selected');
 for(const id of approval.settle_ids){const e=entries.find(e=>e.item.snapshot.beds24_booking_id===id);if(e?.masked.classification!=='guest_candidate')throw new Error('Exceptional status cannot be batch-settled');}
 const batch=await request('rpc/ops_stage_historical_batch',staffToken,{method:'POST',body:{account_key:account,preview_digest:preview.digest,approved_items:entries.map(e=>({...e.item,expected_id:e.expected_id,expected_last_synced_at:e.expected_last_synced_at,settle:approval.settle_ids.includes(e.item.snapshot.beds24_booking_id)})),approval_reason:approval.reason,bond_confirmed:true}});
 return request('rpc/ops_apply_historical_batch',null,{method:'POST',service:true,body:{batch_id:batch}});
}
