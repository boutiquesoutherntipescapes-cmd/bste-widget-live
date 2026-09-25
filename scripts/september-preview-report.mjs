import { createHash } from 'node:crypto';
import { PROPERTIES } from '../lib/operations-model.js';
// Explicit output projection: never return source objects, auth, guest or financial values.
const fields = new Set(['source_environment','source_account','beds24_booking_id','property_slug','beds24_property_id','beds24_room_id','arrival','departure','source_status','source_channel','guest_name','guest_email','guest_mobile','adults','children','source_price','source_currency','source_deposit','source_invoice_items']);
const conditions=new Set(['identical_duplicate','conflicting_duplicate','duplicate_local_identity','invalid_or_unsupported_source','stored_not_returned_no_deletion','changed_source','unchanged','new_local_record']);
const statuses = new Set(['new','confirmed','request','inquiry','cancelled','black','blocked','declined','deleted']);
const channels = new Set(['airbnb','booking.com','booking','direct','bste','bste website','website','manual','beds24','vrbo','expedia','agoda']);
export function maskBookingId(id) {
 const s=String(id??'');
 if(!/^\d+$/.test(s))return 'unavailable';
 // A deterministic display tag distinguishes records sharing their last three digits.
 return '******'+(s.length>3?s.slice(-3):'')+'-'+createHash('sha256').update('bste-preview:'+s).digest('hex').slice(0,8);
}
const date=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s?s:null;
export function browserPreviewReport(preview) {
 const p=preview.report;
 const records=p.records||[], exceptions=p.exceptions||[], duplicates=p.duplicates||[], conflicts=p.localConflicts||[], localOnly=p.localOnly||[];
 const problemIds=new Set([...exceptions,...duplicates,...conflicts,...localOnly].map(r=>String(r.booking_id)));
 const row=r=>{
  const arrival=date(r.arrival),departure=date(r.departure),nights=arrival&&departure?(Date.parse(departure)-Date.parse(arrival))/86400000:null;
  const raw=String(r.raw_status??''),channel=String(r.channel??'');
  const labelsRedacted=!statuses.has(raw.toLowerCase())||(channel!==''&&!channels.has(channel.toLowerCase()));
  const guest=r.classification==='guest_candidate'&&!problemIds.has(String(r.booking_id))&&nights>0&&departure>='2026-09-01'&&departure<='2026-09-23'&&!labelsRedacted;
  return {booking_id:maskBookingId(r.booking_id),property:PROPERTIES.find(p=>p.slug===r.property)?.name||'Unmapped property',arrival,departure,nights:nights>0?nights:null,
   raw_status:statuses.has(raw.toLowerCase())?raw:'Unrecognized status (redacted)',channel:channels.has(channel.toLowerCase())?channel:channel?'Other source (redacted)':'Not supplied',
   already_stored:r.storage==='already_stored'?true:r.storage==='missing_locally'?false:null,
   opening_period_eligible:guest,requires_review:!guest||Boolean(r.changed_fields?.length),
   condition:conditions.has(r.condition)?r.condition:'',changed_fields:(r.changed_fields||[]).filter(f=>fields.has(f)),labels_redacted:labelsRedacted};
 };
 const all=[...records,...exceptions], unique=[...new Map(all.map(r=>[String(r.booking_id),r])).values()];
 const rows=records.map(row),special={cancelled:[],requests_inquiries:[],blocks:[],non_guest:[],unusual_status:[],conflicts_duplicates:[...duplicates,...conflicts].map(row),stored_not_returned:localOnly.map(row)};
 const candidates=[];
 for(const r of all){const item=row(r);if(r.classification==='guest_candidate'&&!exceptions.includes(r))candidates.push(item);
  else special[({cancelled:'cancelled',request:'requests_inquiries',inquiry:'requests_inquiries',block:'blocks',non_guest:'non_guest'})[r.classification]||'unusual_status'].push(item);}
 const reviewIds=new Set([...all.filter(r=>row(r).requires_review),...duplicates,...conflicts,...localOnly].map(r=>String(r.booking_id)));
 return {scope:'Checkout 1–23 September 2026 inclusive',total_records:all.length+duplicates.length,unique_records:unique.length,
  by_property:PROPERTIES.map(p=>({property:p.name,count:[...all,...duplicates].filter(r=>r.property===p.slug).length})),
  already_stored:rows.filter(r=>r.already_stored===true).length,missing_records:rows.filter(r=>r.already_stored===false).length,
  missing_guest_candidates:candidates.filter(r=>r.already_stored===false&&r.opening_period_eligible).length,records_requiring_review:reviewIds.size,
  candidates,exceptional:special,differences:rows.filter(r=>r.changed_fields.length),
  notice:'Read only. Eligibility means eligible to classify as opening-period, not fully settled; owner/cleaner payments and channel receipts require separate evidence. Changed fields are listed without private before/after values. Unrecognized free-text labels are redacted for privacy. Missing counts cover validated source records; invalid records require review.',
  application_writes:0,normal_sync_changed:false};
}
