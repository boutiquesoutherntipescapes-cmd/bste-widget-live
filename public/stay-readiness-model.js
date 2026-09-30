// Pure presentation: no providers, financial fields or database writes.
export const CHECKPOINTS = Object.freeze([
 {key:'pre_arrival',label:'Pre-arrival readiness',anchor:'arrival',offset:-3,hour:8,items:['Pre-clean completed','Fresh linen/towels ready','Stocking/welcome items completed','Property inspection completed','No maintenance issue requiring attention']},
 {key:'final_arrival',label:'Final arrival check',anchor:'arrival',offset:-1,hour:8,items:['Property ready for guest','Welcome provisions ready','Access/alarm checked','No unresolved issue']},
 {key:'arrival_day',label:'Arrival-day readiness',anchor:'arrival',offset:0,hour:8,items:['Property ready for check-in']},
 {key:'departure',label:'Departure check',anchor:'departure',offset:0,hour:8,items:['Guest checkout confirmed','No damage/problem requiring action','Cleaning proceeding as planned']},
 {key:'post_clean',label:'Post-clean check',anchor:'departure',offset:0,hour:16,items:['Cleaning completed','Laundry handled as applicable','Replenishment/stocking expenses noted for separate finance entry','No maintenance issue requiring attention']}
]);
export const sastDay = date => new Date(new Date(date).getTime()+7200000).toISOString().slice(0,10);
export function addDays(day, count) {return new Date(Date.parse(day+'T00:00:00Z')+count*86400000).toISOString().slice(0,10);}
export function checkpointDue(booking, definition) {return `${addDays(booking[definition.anchor],definition.offset)}T${String(definition.hour).padStart(2,'0')}:00:00+02:00`;}
export function effectiveStatus(checkpoint,now=new Date()) {
 if(!['pending','deferred'].includes(checkpoint.status))return checkpoint.status;
 const due=Date.parse(checkpoint.status==='deferred'?checkpoint.deferred_until:checkpoint.due_at);
 if(due>+now)return checkpoint.status;
 return due===+now?'due':'overdue';
}
// SQL supplies the authoritative eligibility flag on every real read. This
// conservative mirror supports fixtures/offline presentation; SQL parity tests
// cover every raw-status / override combination.
export function eligibility(b) {
 const raw=String(b.source_status||'').toLowerCase();
 const blocked=['cancelled','canceled','black','blocked'].includes(raw);
 const review=b.operational_status==='review_required';
 const eligible=!blocked&&!review&&(['new','confirmed'].includes(raw)||['confirmed','checked_in','checked_out'].includes(b.operational_status));
 return {blocked,review,eligible:eligible&&b.readiness_eligible!==false};
}
export function contactReadiness(b) {
 const raw=String(b.source_channel||'').trim().toLowerCase();
 const ota=b.source_kind!=='manual_direct'?new Map([['airbnb','Airbnb'],['booking','Booking.com'],['booking.com','Booking.com']]).get(raw)||null:null;
 const email=!!b.guest_email, mobile=!!b.guest_mobile;
 return {email,mobile,ota,route:ota?`${ota} channel route (delivery not tested)`:email?'Email':mobile?'Mobile (WhatsApp not verified)':null,unreachable:!ota&&!email&&!mobile,ghl:'Not known / not connected'};
}
export function validCleaningTimestamp(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))return false;
 const day=value.slice(0,10);return new Date(day+'T00:00:00Z').toISOString().slice(0,10)===day;
}
export function readinessView(booking,checkpoints=[],assignment=null,now=new Date()) {
 const today=sastDay(now),gate=eligibility(booking);
 const items=checkpoints.map(c=>({...c,effective_status:effectiveStatus(c,now)}));
 const contact=contactReadiness(booking),attention=[];
 if(!gate.eligible)attention.push(gate.blocked?'Booking cancelled/blocked — no response actions':'Source requires operational review');
 if(!gate.blocked){
  if(!assignment||assignment.state==='unassigned')attention.push('Cleaner not assigned');
  if(assignment?.schedule_review)attention.push('Cleaning arrangement requires review after stay changes');
  if(contact.unreachable)attention.push('No communication route');
  if(!items.length)attention.push('Checklist not initialized');
  for(const c of items){if(c.schedule_review)attention.push(`${c.label}: dates changed — review required`);
   if(c.issue_open||c.effective_status==='needs_attention')attention.push(`${c.label}: issue flagged`);
   if(['due','overdue'].includes(c.effective_status))attention.push(`${c.label}: ${c.effective_status} / incomplete`);}
  if(booking.arrival===today&&!items.some(c=>c.checkpoint_key==='arrival_day'&&c.status==='complete'&&!c.schedule_review&&!c.issue_open))attention.push('Arrival today not marked ready');
 }
 const readiness=items.filter(c=>['pre_arrival','final_arrival','arrival_day'].includes(c.checkpoint_key)&&c.status!=='not_applicable');
 const ready=gate.eligible&&readiness.length>0&&readiness.every(c=>c.status==='complete'&&!c.schedule_review&&!c.issue_open)&&attention.length===0;
 const outstanding=!!assignment?.schedule_review||items.some(c=>c.issue_open||c.schedule_review||['needs_attention','deferred','due','overdue'].includes(c.effective_status)||(c.checkpoint_key==='post_clean'&&c.status==='pending'&&booking.departure<today));
 return {checkpoints:items,assignment,contact,attention,ready,eligible:gate.eligible,cancelled:gate.blocked,outstanding,
 next:items.filter(c=>!['complete','not_applicable'].includes(c.effective_status)||c.schedule_review||c.issue_open).sort((a,b)=>Date.parse(a.deferred_until||a.due_at)-Date.parse(b.deferred_until||b.due_at))[0]||null};
}
export function visibleStay(booking,view,horizon,today){
 return view.outstanding||((booking.arrival<=horizon||view.checkpoints.some(c=>!['complete','not_applicable'].includes(c.effective_status)&&sastDay(c.deferred_until||c.due_at)<=horizon))&&booking.departure>=today);
}
export function promptPreview(booking,checkpoint,propertyName){
 return {subject:`ACTION: ${propertyName} arrival ${booking.arrival} — ${checkpoint.label}`,
 body:[propertyName,`Guest: ${booking.guest_name||'Not supplied'}`,`Arrival: ${booking.arrival}`,`Departure: ${booking.departure}`,`Checkpoint: ${checkpoint.label}`,`Readiness: ${checkpoint.effective_status||checkpoint.status}`,
 ...(checkpoint.items||[]).map(i=>i.label+'?'), 'YES = all listed checks ready/clear; NO = at least one issue; REMIND TOMORROW = defer, not ready.',
 'PREVIEW ONLY — no email sent.'].join('\n')};
}
// Future adapter contract: transport must independently verify sender authenticity.
// This parser never writes or authorizes a response, and is not exposed as an endpoint.
export function normalizeInternalReply(input,{environment='staging'}={}){
 const text=v=>typeof v==='string'&&v.trim().length>0&&v.length<=200;
 if(!input||environment!=='staging'||input.environment!==environment||input.verified_sender!==true||!['authorized_staff_id','message_id','checkpoint_reference','correlation_id','provider'].every(k=>text(input[k])))throw new Error('Environment, verified sender and exact message/checkpoint references required');
 const action=new Map([['yes','yes'],['no','no'],['remind me tomorrow','tomorrow']]).get(typeof input.text==='string'?input.text.trim().toLowerCase():'');
 if(!action)throw new Error('Reply requires manual review');
 return {environment,provider:input.provider,action,staff_id:input.authorized_staff_id,message_id:input.message_id,checkpoint_reference:input.checkpoint_reference,correlation_id:input.correlation_id};
}
