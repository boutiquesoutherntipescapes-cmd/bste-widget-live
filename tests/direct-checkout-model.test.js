import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paymentSchedule,holdConfig,holdExpiresAt,sastCalendarDate,canTransition} from '../lib/direct-checkout-model.js';
for(const [arrival,due] of [['2026-10-09',5001],['2026-10-08',10001],['2026-10-07',10001]])test('payment window '+arrival,()=>{const s=paymentSchedule(10001,arrival,'2026-10-01');assert.equal(s.dueNowCents,due);assert.equal(s.balanceCents+s.dueNowCents,10001);});
test('odd cents round deposit up and remain exact',()=>{assert.equal(paymentSchedule(101,'2026-10-09','2026-10-01').dueNowCents,51);assert.equal(paymentSchedule(Number.MAX_SAFE_INTEGER,'2026-10-09','2026-10-01').balanceCents,4503599627370495);});
test('SAST midnight and calendar deadline',()=>{assert.equal(sastCalendarDate(new Date('2026-09-30T22:01:00Z')),'2026-10-01');assert.equal(paymentSchedule(100,'2026-10-09','2026-10-01').balanceDeadline,'2026-10-02T23:59:00+02:00');});
test('invalid dates and non-integer browser money rejected',()=>{for(const n of ['100',NaN,-1,0,1.5])assert.throws(()=>paymentSchedule(n,'2026-10-09','2026-10-01'));assert.throws(()=>paymentSchedule(100,'2026-02-30','2026-02-01'));assert.throws(()=>paymentSchedule(100,'2026-09-01','2026-10-01'));});
test('configurable hold starts at protection and defaults to 30 minutes',()=>{assert.equal(holdExpiresAt('2026-10-01T10:00:00Z',holdConfig({})),'2026-10-01T10:30:00.000Z');assert.equal(holdConfig({BSTE_CHECKOUT_HOLD_MINUTES:'20'}).holdMinutes,20);for(const v of ['0','-1','abc','1.2','1441'])assert.throws(()=>holdConfig({BSTE_CHECKOUT_HOLD_MINUTES:v}));});
test('reservation transitions forbid resurrection and operational state confusion',()=>{assert.equal(canTransition('held','confirmed'),true);for(const pair of [['quoted','confirmed'],['expired','held'],['cancelled','confirmed'],['confirmed','in_house']])assert.equal(canTransition(...pair),false);});
const sql=fs.readFileSync(new URL('../supabase/migrations/202609260002_direct_checkout_foundation.sql',import.meta.url),'utf8');
for(const [label,pattern] of [['checkout',/unique\(environment,idempotency_key\)/],['attempt',/unique\(environment,provider,merchant_scope,initiation_key\)/],['event',/unique\(environment,provider,merchant_scope,event_key\)/],['transaction',/create unique index payment_transaction_once/],['action',/unique\(checkout_id,action\)/]])test(label+' database dedup constraint',()=>assert.match(sql,pattern));
test('composite foreign keys enforce sandbox isolation',()=>{assert.match(sql,/foreign key\(checkout_id,environment\)/);assert.match(sql,/foreign key\(attempt_id,environment,provider,merchant_scope\)/);assert.match(sql,/b.source_environment=new.environment/);});
for(const target of ['owner','cleaner'])test('payment recording cannot create '+target+' settlements',()=>{assert.doesNotMatch(sql,/insert into public\.ops_(?!events)|update public\.ops_|alter table public\.ops_/i);assert.doesNotMatch(sql,new RegExp('create.*'+target,'i'));});
test('no card credentials/raw payload fields, events immutable, no write grants',()=>{assert.doesNotMatch(sql,/^\s*(card_number|cvv|pan|passphrase|raw_payload|payload)\s+/mi);assert.match(sql,/Payment events are append-only/);assert.equal((sql.match(/enable row level security/g)||[]).length,4);assert.doesNotMatch(sql,/grant (insert|update|all|delete|execute)/i);});

const scope={id:'checkout-one',environment:'sandbox',provider:'payfast',merchant_scope:'fixture',total_cents:10001};
const attempt={id:'attempt-one',checkout_id:scope.id,environment:scope.environment,provider:scope.provider,merchant_scope:scope.merchant_scope,expected_cents:5001,currency:'ZAR'};
const fact={attempt_id:attempt.id,environment:scope.environment,provider:scope.provider,merchant_scope:scope.merchant_scope,provider_transaction_id:'one',verification_result:'accepted',provider_status:'complete',currency:'ZAR',amount_cents:5001};
test('same-scope projection, duplicate receipt and balance are exact',async()=>{
 const {paymentProjection}=await import('../lib/direct-checkout-model.js');
 assert.equal(paymentProjection(scope,[],[]).state,'awaiting_payment');
 assert.equal(paymentProjection(scope,[attempt],[fact]).state,'partially_paid');
 assert.equal(paymentProjection(scope,[attempt],[fact,fact]).receivedCents,5001);
 const balance={...attempt,id:'attempt-two',expected_cents:5000};
 assert.equal(paymentProjection(scope,[attempt,balance],[fact,{...fact,attempt_id:balance.id,provider_transaction_id:'two',amount_cents:5000}]).state,'fully_paid');
 assert.equal(paymentProjection(scope,[attempt],[{...fact,verification_result:'uncertain'}]).reviewRequired,true);
 assert.equal(paymentProjection(scope,[attempt],[{...fact,verification_result:'rejected'}]).receivedCents,0);
});
for(const [name,change] of [['production',{environment:'production'}],['another checkout',{checkout_id:'different'}],['unknown attempt',{attempt_id:'different'}],['wrong merchant',{merchant_scope:'different'}],['wrong provider',{provider:'different'}]])test('projection rejects '+name+' with auditable safe code',async()=>{
 const {paymentProjection}=await import('../lib/direct-checkout-model.js');
 assert.throws(()=>paymentProjection(scope,[attempt],[fact,{...fact,...change}]),e=>e.code==='PAYMENT_SCOPE_MISMATCH'&&e.reviewRequired===true);
});
test('R50 sandbox plus R50 production never pays a R100 checkout',async()=>{
 const {paymentProjection}=await import('../lib/direct-checkout-model.js');
 const a={...attempt,expected_cents:5000};const e={...fact,amount_cents:5000};
 assert.throws(()=>paymentProjection({...scope,total_cents:10000},[a],[e,{...e,environment:'production',provider_transaction_id:'second'}]),/PAYMENT_SCOPE_MISMATCH/);
 assert.throws(()=>paymentProjection(scope,[{...attempt,checkout_id:'other'}],[fact]),/PAYMENT_SCOPE_MISMATCH/);
});
test('conflicting same transaction allocations require review',async()=>{
 const {paymentProjection}=await import('../lib/direct-checkout-model.js');
 assert.throws(()=>paymentProjection(scope,[attempt,{...attempt,id:'other'}],[fact,{...fact,attempt_id:'other'}]),/PAYMENT_FACT_CONFLICT/);
});
for(const v of [null,undefined,'','invalid date',new Date(NaN),'2026-10-01'])test('missing/invalid protection timestamp rejected: '+String(v),()=>assert.throws(()=>holdExpiresAt(v)));
test('SQL hold gate is null safe and Phase 1A cannot trust Beds24 references',()=>{
 assert.match(sql,/protected_at is not null and hold_expires_at is not null and hold_expires_at>protected_at/);
 assert.match(sql,/direct_protection_disabled_phase1a check\(protection_verified=false\)/);
 assert.match(sql,/state not in \('held','confirmed'\) or \(protection_verified/);
 assert.match(sql,/inventory_scope text generated always/);
});
test('accepted facts cannot have nullable amount/currency and audit is reused',()=>{
 assert.match(sql,/amount_cents is not null/);assert.match(sql,/currency is not null/);assert.match(sql,/insert into public.ops_events/);
 assert.match(sql,/Attempt amount\/purpose does not match checkout/);
});

test('hold accepts a valid zoned timestamp/Date but not a normalized invalid calendar date',()=>{
 assert.equal(holdExpiresAt('2026-10-01T12:00:00+02:00',{holdMinutes:30}),'2026-10-01T10:30:00.000Z');
 assert.equal(holdExpiresAt(new Date('2026-10-01T10:00:00Z'),{holdMinutes:30}),'2026-10-01T10:30:00.000Z');
 assert.throws(()=>holdExpiresAt('2026-02-30T10:00:00Z'));
});
test('generated scope cannot cause false immutable-agreement failures in BEFORE trigger',()=>{
 assert.equal((sql.match(/array\['inventory_scope','state','review_required'/g)||[]).length,2);
 assert.match(sql,/Generated inventory_scope is recomputed AFTER BEFORE triggers/);
});
test('renamed migration is unique and old draft absent',()=>{
 assert.equal(fs.existsSync(new URL('../supabase/migrations/202609270001_direct_checkout_foundation.sql',import.meta.url)),false);
 assert.match(sql,/begin;/);assert.match(sql,/commit;\s*$/);
});
test('SQL suite uses random business keys, real role checks, both isolation directions and rollback proof',()=>{
 const s=fs.readFileSync(new URL('./direct-checkout-foundation-rls.sql',import.meta.url),'utf8');
 assert.doesNotMatch(s,/'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'/i);
 for(const marker of ['checkout idempotency','attempt initiation','event identity','accepted transaction','action idempotency',
 'sandbox attempt cannot link to production checkout','production attempt cannot link to sandbox checkout',
 'sandbox event cannot link to production attempt','production event cannot link to sandbox attempt',
 'accepted event update','accepted event delete','missing expiry','missing protection timestamp','zero duration','negative duration',
 'nonstaff aal2 SELECT','operations aal1 SELECT','finance aal1 SELECT','administrator aal1 SELECT','finance aal2 SELECT','administrator aal2 SELECT',
 'set local role anon','set local role service_role','payment_fixtures','post-rollback unchanged:',
 'checkouts_removed','attempts_removed','events_removed','actions_removed','audit_rows_rolled_back','auth_users_removed','auth_sessions_removed','staff_removed'])assert.ok(s.includes(marker),marker);
 assert.ok(s.indexOf('rollback to savepoint payment_fixtures')<s.indexOf('post-rollback unchanged:'));
 assert.match(s,/rollback;\s*$/);assert.doesNotMatch(s,/^commit;/mi);
});

test('cross-environment SQL probes use fresh unrelated unique keys to reach the FK',()=>{
 const s=fs.readFileSync(new URL('./direct-checkout-foundation-rls.sql',import.meta.url),'utf8');
 const probes=s.split('\n').filter(x=>x.includes('cannot link to'));
 assert.equal(probes.length,4);
 for(const line of probes){assert.match(line,/'23503'/);if(line.includes("insert_fixture('payment_attempts'"))assert.match(line,/'initiation_key',gen_random_uuid\(\)/);else {assert.match(line,/'event_key',gen_random_uuid\(\)::text/);assert.match(line,/'provider_transaction_id',gen_random_uuid\(\)::text/);}}
});
