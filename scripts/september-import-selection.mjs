import { createHash } from 'node:crypto';
import { PROPERTIES } from '../lib/operations-model.js';
import { maskBookingId } from './september-preview-report.mjs';
// Validation only: preserve provider values in every snapshot/raw/import payload.
// Case-insensitivity is existing behavior. Whitespace is deliberately NOT trimmed.
export function canonicalApprovedChannel(raw) {
 if(typeof raw!=='string')return null;
 switch(raw.toLowerCase()) {
  case 'airbnb': return 'airbnb';
  case 'booking':
  case 'booking.com': return 'booking.com';
  default: return null;
 }
}
export const APPROVED_STAYS=Object.freeze([
 {property:'legacy-suiderstrand',arrival:'2026-09-05',departure:'2026-09-13',channel:'airbnb',nights:8},
 {property:'kalay-ridge-villa-struisbaai',arrival:'2026-09-08',departure:'2026-09-11',channel:'airbnb',nights:3},
 {property:'the-pearl-beach-villa-agulhas',arrival:'2026-09-06',departure:'2026-09-13',channel:'booking.com',nights:7}
]);
export const HANDOFF_MESSAGES=Object.freeze({
 NO_SELECTION:'No preview selection exists in this server process. Run an authorized protected preview.',
 SELECTION_EXPIRED:'The 25-minute selection window expired. A fresh protected preview is required.',
 SESSION_CHANGED:'The authenticated session differs from the preview session. Run a fresh preview in this session.',
 PREVIEW_CONFLICT:'Candidate selection rejected: preview contains duplicate or conflicting records.',
 APPROVED_STAY_MISSING_OR_AMBIGUOUS:'Candidate selection rejected: an approved stay is missing or has multiple matches.',
 CANDIDATE_STATUS_REJECTED:'Candidate selection rejected: guest classification or raw status is not approved.',
 CHANNEL_MISMATCH:'Candidate selection rejected: a source channel does not exactly match the approved channel.',
 SOURCE_IDENTITY_MISMATCH:'Candidate selection rejected: source environment, account or property/room mapping differs.',
 INVALID_BOOKING_ID:'Candidate selection rejected: a booking identity is invalid.',
 DUPLICATE_BOOKING_ID:'Candidate selection rejected: booking identities are not unique.',
 SELECTION_REJECTED:'Candidate selection could not be safely stored. Import remains blocked.'
});
export class HandoffError extends Error {
 constructor(code){super(HANDOFF_MESSAGES[code]||HANDOFF_MESSAGES.SELECTION_REJECTED);this.code=Object.hasOwn(HANDOFF_MESSAGES,code)?code:'SELECTION_REJECTED';}
}
const sessions=new Map();
const key=(user,token)=>createHash('sha256').update(user+'\0'+token).digest('hex');
const userKey=user=>createHash('sha256').update(user).digest('hex');
export function selectApproved(preview) {
 if(!preview?.entries||preview.duplicates.length||preview.localConflicts.length)throw new HandoffError('PREVIEW_CONFLICT');
 const entries=APPROVED_STAYS.map(stay=>{
  const p=PROPERTIES.find(p=>p.slug===stay.property);
  const matches=preview.entries.filter(e=>{const s=e.item.snapshot;return s.property_slug===stay.property&&s.arrival===stay.arrival&&s.departure===stay.departure;});
  if(matches.length!==1)throw new HandoffError('APPROVED_STAY_MISSING_OR_AMBIGUOUS');
  const e=matches[0],s=e.item.snapshot;
  if(e.masked.classification!=='guest_candidate'||!['new','confirmed'].includes(String(s.source_status).toLowerCase()))throw new HandoffError('CANDIDATE_STATUS_REJECTED');
  if(canonicalApprovedChannel(s.source_channel)!==stay.channel)throw new HandoffError('CHANNEL_MISMATCH');
  if(s.source_environment!=='production'||s.source_account!==preview.account||s.beds24_property_id!==p.propertyId||s.beds24_room_id!==p.roomId)throw new HandoffError('SOURCE_IDENTITY_MISMATCH');
  if(!Number.isSafeInteger(s.beds24_booking_id)||s.beds24_booking_id<=0)throw new HandoffError('INVALID_BOOKING_ID');
  return e;
 });
 if(new Set(entries.map(e=>e.item.snapshot.beds24_booking_id)).size!==3)throw new HandoffError('DUPLICATE_BOOKING_ID');
 return entries;
}
function expire(k,value,now){
 if(now-value.created>25*60000){
  // Keep only a bounded diagnostic tombstone; expired guest payloads are discarded.
  const tombstone={created:value.created,userKey:value.userKey,expired:true};sessions.set(k,tombstone);return tombstone;
 }return value;
}
export function rememberImportPreview(user,token,preview,now=Date.now()) {
 for(const [k,v] of sessions)expire(k,v,now);
 const k=key(user,token);sessions.delete(k);
 if(sessions.size>=16)sessions.delete(sessions.keys().next().value);
 const metadata={created:now,userKey:userKey(user)};
 try {
  const entries=selectApproved(preview);
  sessions.set(k,{...metadata,preview:structuredClone(preview),ids:entries.map(e=>e.item.snapshot.beds24_booking_id),running:false,result:null});
  return {import_ready:true};
 }catch(error){
  const code=error instanceof HandoffError?error.code:'SELECTION_REJECTED';
  sessions.set(k,{...metadata,rejection:code});
  return {import_ready:false,reason_code:code,reason:HANDOFF_MESSAGES[code]};
 }
}
export function getImportSelection(user,token,now=Date.now()) {
 const k=key(user,token);let value=sessions.get(k);
 if(!value)throw new HandoffError([...sessions.values()].some(v=>v.userKey===userKey(user))?'SESSION_CHANGED':'NO_SELECTION');
 value=expire(k,value,now);
 if(value.expired)throw new HandoffError('SELECTION_EXPIRED');
 if(value.rejection)throw new HandoffError(value.rejection);
 return value;
}
export function selectionDisplay(selection){return selectApproved(selection.preview).map((e,i)=>({booking_id:maskBookingId(e.item.snapshot.beds24_booking_id),property:PROPERTIES.find(p=>p.slug===APPROVED_STAYS[i].property).name,arrival:e.item.snapshot.arrival,departure:e.item.snapshot.departure,nights:APPROVED_STAYS[i].nights,channel:e.item.snapshot.source_channel,raw_status:e.item.snapshot.source_status}));}
