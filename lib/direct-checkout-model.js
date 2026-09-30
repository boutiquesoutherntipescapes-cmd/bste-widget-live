// Pure server rules only: no provider, database or browser-price inputs.
export const RESERVATION_TRANSITIONS = Object.freeze({"quoted": ["preparing", "expired", "cancelled"], "preparing": ["held", "quoted", "cancelling"], "held": ["confirmed", "cancelling"], "confirmed": ["cancelling"], "cancelling": ["cancelled", "expired"], "cancelled": [], "expired": []});
export function canTransition(from,to){return Object.hasOwn(RESERVATION_TRANSITIONS,from)&&(from===to||RESERVATION_TRANSITIONS[from].includes(to));}
function dateNumber(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error('Calendar date required');
 const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)throw Error('Invalid calendar date');return +d;
}
export function paymentSchedule(totalCents,arrival,asOfDate){
 if(!Number.isSafeInteger(totalCents)||totalCents<=0)throw Error('Positive integer cents required');
 const days=(dateNumber(arrival)-dateNumber(asOfDate))/86400000;if(days<0)throw Error('Arrival is in the past');
 const dueNowCents=days>7?Math.ceil(totalCents/2):totalCents;
 const balanceDueDate=new Date(dateNumber(arrival)-7*86400000).toISOString().slice(0,10);
 return {totalCents,dueNowCents,balanceCents:totalCents-dueNowCents,balanceDueDate,balanceDeadline:balanceDueDate+'T23:59:00+02:00',scheduleDate:asOfDate,purpose:days>7?'deposit':'full'};
}
export function sastCalendarDate(now=new Date()){
 if(!(now instanceof Date)||!Number.isFinite(+now))throw Error('Invalid timestamp');
 return new Date(+now+2*3600000).toISOString().slice(0,10);
}
export function holdConfig(env=process.env){
 const raw=env.BSTE_CHECKOUT_HOLD_MINUTES??'30';
 if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>1440)throw Error('Invalid BSTE_CHECKOUT_HOLD_MINUTES');
 return {holdMinutes:Number(raw)};
}
// Call only after inventory protection has been verified, never on browser refresh.
export function holdExpiresAt(protectedAt,config=holdConfig()){
 if(!(protectedAt instanceof Date)&&(typeof protectedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(protectedAt)))throw Error('Confirmed protection timestamp required');
 if(typeof protectedAt==='string')dateNumber(protectedAt.slice(0,10));
 const t=new Date(protectedAt);if(!Number.isFinite(+t)||!Number.isInteger(config.holdMinutes)||config.holdMinutes<1||config.holdMinutes>1440)throw Error('Invalid hold');
 return new Date(+t+config.holdMinutes*60000).toISOString();
}

// Pure projection of persisted, server-verified facts. No browser authority.
// Callers must supply the selected checkout scope and the matching attempt rows.
// Safe error codes can be audited without logging receipts or guest data.
function projectionError(code){const error=new Error(code);error.code=code;error.reviewRequired=true;throw error;}
export function paymentProjection(checkout,attempts=[],events=[]){
 if(!checkout||!Number.isSafeInteger(checkout.total_cents)||checkout.total_cents<=0)throw Error('Invalid checkout total');
 const {id,environment,provider,merchant_scope:merchant}=checkout;
 if(typeof id!=='string'||!id||!['sandbox','production'].includes(environment)||provider!=='payfast'||typeof merchant!=='string'||!merchant.trim())projectionError('PAYMENT_SCOPE_MISMATCH');
 const sameScope=x=>x&&x.environment===environment&&x.provider===provider&&x.merchant_scope===merchant;
 const byId=new Map();
 for(const a of attempts){
  if(!sameScope(a)||a.checkout_id!==id||typeof a.id!=='string'||!a.id||byId.has(a.id))projectionError('PAYMENT_SCOPE_MISMATCH');
  byId.set(a.id,a);
 }
 let received=0,review=false;const seen=new Map();
 for(const e of events){
  const attempt=byId.get(e?.attempt_id);
  if(!sameScope(e)||!attempt||(e.checkout_id!==undefined&&e.checkout_id!==id))projectionError('PAYMENT_SCOPE_MISMATCH');
  if(!['accepted','rejected','uncertain'].includes(e.verification_result))projectionError('PAYMENT_FACT_INVALID');
  if(e.verification_result==='uncertain')review=true;
  if(e.verification_result!=='accepted')continue;
  if(e.provider_status!=='complete'||e.currency!=='ZAR'||!Number.isSafeInteger(e.amount_cents)||e.amount_cents<=0
   ||typeof e.provider_transaction_id!=='string'||!e.provider_transaction_id.trim()
   ||e.amount_cents!==attempt.expected_cents||e.currency!==attempt.currency)projectionError('PAYMENT_FACT_INVALID');
  const key=e.provider_transaction_id;
  const fingerprint=JSON.stringify([e.attempt_id,e.amount_cents,e.currency,e.provider_status]);
  if(seen.has(key)){if(seen.get(key)!==fingerprint)projectionError('PAYMENT_FACT_CONFLICT');continue;}
  seen.set(key,fingerprint);received+=e.amount_cents;
  if(!Number.isSafeInteger(received))projectionError('PAYMENT_FACT_INVALID');
 }
 return {receivedCents:received,state:received===0?'awaiting_payment':received<checkout.total_cents?'partially_paid':'fully_paid',reviewRequired:review||received>checkout.total_cents};
}
