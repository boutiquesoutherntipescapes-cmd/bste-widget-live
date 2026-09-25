import test from 'node:test';
import assert from 'node:assert/strict';
import {draftStay,validateReceipt} from '../lib/stay-finances.js';
import {createFinanceHandler} from '../api/staff-finances.js';
import {StaffAuthError} from '../lib/staff-auth.js';
import fs from 'node:fs';
const booking={arrival:'2026-09-25',departure:'2026-09-28',property_slug:'legacy-suiderstrand',source_status:'new'};
const review={status:'reviewed',expenses_complete:true,accommodation_cents:2000000,cleaning_charge_cents:100000,channel_fees_cents:300000,cleaner_cost_cents:80000,
 funds_received_cents:0,rate_nights:[{rate_cents:400000},{rate_cents:600000},{rate_cents:600000}],source_basis:{booking},checkout_month:'2026-09-01'};
const expense={id:'e1',category:'stocking',status:'approved',payer:'bste',allocation:'owner',amount_cents:50000,owner_amount_cents:50000,bste_amount_cents:0};
test('mixed-season owner entitlement ignores platform fees; recovery is not BSTE income',()=>{
 const x=draftStay(review,[expense],null,booking,'2026-09-29');
 assert.equal(x.owner_gross_cents,1600000);assert.equal(x.owner_payout_cents,1550000);
 assert.equal(x.accommodation_contribution_cents,100000);assert.equal(x.cleaning_contribution_cents,20000);
 assert.equal(x.stay_contribution_cents,120000);assert.equal(x.eligibility,'awaiting_funds');
});
test('funds and checkout gates are independent, checkout month is not prorated',()=>{
 const r={...review,funds_received_cents:1800000};
 assert.equal(draftStay(r,[],null,booking,'2026-09-26').eligibility,'awaiting_checkout');
 assert.equal(draftStay(r,[],null,booking,'2026-09-29').eligibility,'draft_ready');
 assert.equal(draftStay(r,[],null,booking).checkout_month,'2026-09-01');
});
test('unresolved and unapproved expenses cannot silently reduce owner payout',()=>{
 const x=draftStay(review,[{...expense,status:'draft',allocation:'needs_review',owner_amount_cents:0}],null,booking);
 assert.equal(x.owner_payout_cents,1600000);assert.equal(x.eligibility,'needs_review');
});
test('expense correction replaces old amount, void does not count',()=>{
 const next={...expense,id:'e2',previous_id:'e1',owner_amount_cents:60000};
 assert.equal(draftStay(review,[expense,next]).owner_payout_cents,1540000);
 assert.equal(draftStay(review,[expense,{...next,is_void:true}]).owner_payout_cents,1600000);
});
test('owner-paid and guest-recoverable allocations require cash review',()=>{
 assert.equal(draftStay(review,[{...expense,payer:'owner'}]).eligibility,'needs_review');
 assert.equal(draftStay(review,[{...expense,allocation:'guest',owner_amount_cents:0,guest_amount_cents:50000}]).eligibility,'needs_review');
});
test('historical settlement excludes new payables without deleting financial picture',()=>{
 const x=draftStay(review,[expense],{state:'fully_settled_historical'},booking);
 assert.equal(x.exclude_from_new_payables,true);assert.equal(x.cleaner_monthly_candidate_cents,0);assert.equal(x.eligibility,'historical_settled');
 assert.equal(x.owner_payout_cents,1550000);
});
test('source changes cannot silently reapprove an old financial revision',()=>{
 const x=draftStay(review,[],null,{...booking,departure:'2026-10-01'});
 assert.ok(x.missing.includes('Booking changed since review'));assert.equal(review.checkout_month,'2026-09-01');
});
test('BSTE additional expenses are shown separately from agreed cleaning/accommodation contribution',()=>{
 const x=draftStay(review,[{...expense,allocation:'bste',owner_amount_cents:0,bste_amount_cents:50000}]);
 assert.equal(x.stay_contribution_cents,120000);assert.equal(x.contribution_after_other_costs_cents,70000);
});
test('receipt type, magic bytes and size are checked',()=>{
 for(const [bytes,type] of [[Buffer.from('%PDF-1.7\n'),'application/pdf'],[Buffer.from([255,216,255,0]),'image/jpeg'],[Buffer.from([137,80,78,71,13,10,26,10]),'image/png']])assert.doesNotThrow(()=>validateReceipt(bytes,type));
 assert.throws(()=>validateReceipt(Buffer.from('<html>'),'application/pdf'));
 assert.throws(()=>validateReceipt(Buffer.alloc(2097153),'image/jpeg'));
 assert.throws(()=>validateReceipt(Buffer.from('<svg>'),'image/svg+xml'));
});
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',
 BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'test',BSTE_STAFF_ORIGIN:'https://localhost:3443'});
const response=()=>({setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
const req=(action,input={})=>({method:'POST',headers:{origin:'https://localhost:3443','content-type':'application/json'},body:{action,input}});
test('anonymous, Operations and AAL1 denial happens before financial storage access',async()=>{
 for(const status of [401,403])for(const action of ['list','detail','upload','download','expense','opening','rate','review']){
  let touched=false;const h=createFinanceHandler({authorize:async()=>{throw new StaffAuthError(status,'Denied');},request:async()=>{touched=true;},objects:async()=>{touched=true;}});
  const res=response();await h(req(action),res);assert.equal(res.code,status);assert.equal(touched,false);
 }
});
test('finance writes use staff JWT and the audited RPC, never importer credentials',async()=>{
 const calls=[];const h=createFinanceHandler({authorize:async(r,p)=>{assert.equal(p,'finance.write');return{staff:{},token:'staff-jwt'};},request:async(...args)=>{calls.push(args);return 'id';}});
 const res=response();await h(req('expense',{request_key:'fixture'}),res);assert.equal(res.code,200);
 assert.equal(calls[0][0],'rpc/ops_finance_write');assert.equal(calls[0][1],'staff-jwt');assert.equal(calls[0][2].service,undefined);
});
test('cross-origin request is denied before authentication',async()=>{
 let touched=false;const h=createFinanceHandler({authorize:async()=>{touched=true;}});const r=req('list');r.headers.origin='https://evil.invalid';
 const res=response();await h(r,res);assert.equal(res.code,403);assert.equal(touched,false);
});
test('completed-month listing uses checkout dates and never reads Beds24',async()=>{
 const calls=[];const h=createFinanceHandler({authorize:async()=>({staff:{},token:'t'}),request:async(path)=>{calls.push(path);return [];}});
 const res=response();await h(req('list',{month:'2026-09'}),res);assert.equal(res.code,200);
 assert.match(calls[0],/departure=gte.2026-09-01&departure=lt.2026-10-01/);
 assert.ok(calls.every(p=>!p.includes('beds24.com')));
});
test('no finalize, payout, bank or communication actions exist',async()=>{
 const h=createFinanceHandler({authorize:async()=>{throw new Error('Must not authenticate unsupported actions');}});
 for(const action of ['payout','finalize','send','payfast']){const res=response();await h(req(action),res);assert.equal(res.code,400);}
});
test('migration statically locks financial tables, RPCs and private receipt bucket',()=>{
 const sql=fs.readFileSync(new URL('../supabase/migrations/202609230001_stay_finances.sql',import.meta.url),'utf8');
 assert.match(sql,/ops_can\('finance.write'\)/);assert.match(sql,/ops_can\('expenses.approve'\)/);
 assert.match(sql,/ops_can\('finance.cutover'\)/);assert.match(sql,/ops_can\('finance.read'\)/);
 assert.match(sql,/ops-stay-receipts','ops-stay-receipts',false/);
 assert.match(sql,/Stale financial revision/);assert.match(sql,/different content or actor/);
 assert.match(sql,/create trigger immutable_expense/);assert.match(sql,/commit;\s*$/);
});
test('private upload stores verified metadata, user token and retry-safe immutable bytes',async()=>{
 const bytes=Buffer.from('%PDF-1.7\nfixture'),{createHash}=await import('node:crypto');const digest=createHash('sha256').update(bytes).digest('hex');
 const id='97000000-0000-0000-0000-000000000001',calls=[];
 const h=createFinanceHandler({authorize:async()=>({staff:{},token:'user-jwt'}),request:async(path,token,opts)=>{
  assert.equal(token,'user-jwt');calls.push(path);
  if(path==='rpc/ops_finance_write'){assert.equal(opts.body.input.sha256,digest);return id;}
  return [{object_key:'booking/object',sha256:digest}];
 },objects:async(path,token,opts)=>{assert.equal(token,'user-jwt');calls.push(opts?.method||'GET');if(!opts)throw new Error('Missing object');assert.deepEqual(opts.bytes,bytes);return new Response('{}');}});
 const res=response();await h(req('upload',{expense_id:id,request_key:id,original_name:'receipt.pdf',media_type:'application/pdf',base64:bytes.toString('base64')}),res);
 assert.equal(res.code,200);assert.deepEqual(calls.slice(-2),['GET','POST']);
});
test('receipt download cannot serve content with a different hash',async()=>{
 const h=createFinanceHandler({authorize:async()=>({staff:{},token:'t'}),request:async()=>[{object_key:'x',media_type:'application/pdf',sha256:'wrong',original_name:'x.pdf'}],objects:async()=>new Response('%PDF-1.7\n')});
 const res=response();await h(req('download',{id:'97000000-0000-0000-0000-000000000001'}),res);assert.equal(res.code,409);
});

test('historical opening position excludes payables even without a financial review',()=>{
 const x=draftStay(null,[],{state:'fully_settled_historical'});
 assert.equal(x.exclude_from_new_payables,true);assert.equal(x.cleaner_monthly_candidate_cents,0);
 assert.equal(x.eligibility,'historical_settled');
});

for(const [property,arrival,departure] of [['legacy-suiderstrand','2026-09-05','2026-09-13'],['kalay-ridge-villa-struisbaai','2026-09-08','2026-09-11'],['the-pearl-beach-villa-agulhas','2026-09-06','2026-09-13']])test(`September opening stay remains unpaid and reconcilable: ${property}`,()=>{
 const b={arrival,departure,property_slug:property,source_status:'confirmed'};
 // Synthetic amounts test arithmetic only, not actual September financial amounts.
 const f={...review,source_basis:{booking:b},funds_received_cents:1800000};
 const o={state:'open',opening_period:true,owner_settlement_state:'outstanding',cleaner_settlement_state:'outstanding',owner_settled_cents:0,cleaner_settled_cents:0};
 const laundry={...expense,id:'laundry',category:'laundry',owner_amount_cents:20000,amount_cents:20000};
 const before=structuredClone({f,o});const d=draftStay(f,[expense,laundry],o,b,'2026-09-24');
 assert.equal(d.completed,true);assert.equal(d.opening_period,true);assert.equal(d.funds_status,'received_reviewed_amount');
 assert.equal(d.owner_settlement_state,'outstanding');assert.equal(d.cleaner_settlement_state,'outstanding');assert.equal(d.settlement_state,'outstanding');
 assert.equal(d.monthly_reconciliation_eligible,true);assert.equal(d.checkout_month,'2026-09-01');assert.equal(d.exclude_from_new_payables,false);
 assert.equal(d.owner_outstanding_cents,1530000);assert.equal(d.cleaner_monthly_candidate_cents,80000);assert.equal(d.owner_payout_eligible,true);
 assert.equal(draftStay({...f,expenses_complete:false},[],o,b,'2026-09-24').owner_payout_eligible,false);
 for(const [type,bytes] of [['image/jpeg',Buffer.from([255,216,255])],['image/png',Buffer.from([137,80,78,71,13,10,26,10])],['application/pdf',Buffer.from('%PDF-')]])validateReceipt(bytes,type);
 assert.deepEqual({f,o},before);assert.equal(draftStay(f,[expense,laundry],o,b,'2026-09-24').owner_settlement_state,'outstanding');
});
test('cutover alone never settles or excludes payables; partial opening payments subtract only prior paid amounts',()=>{
 const b={...booking,departure:'2026-09-23'},f={...review,source_basis:{booking:b},funds_received_cents:1800000};
 assert.equal(draftStay(f,[],null,b,'2026-09-24').exclude_from_new_payables,false);
 const o={state:'open',opening_period:true,owner_settlement_state:'partially_settled',owner_settled_cents:500000,cleaner_settlement_state:'outstanding',cleaner_settled_cents:0};
 const d=draftStay(f,[],o,b,'2026-09-24');assert.equal(d.owner_outstanding_cents,1100000);assert.equal(d.cleaner_outstanding_cents,80000);assert.equal(d.settlement_state,'partially_settled');
 const full=draftStay(f,[],{...o,state:'fully_settled_historical',owner_settlement_state:'fully_settled',cleaner_settlement_state:'fully_settled'},b,'2026-09-24');
 assert.equal(full.owner_outstanding_cents,0);assert.equal(full.cleaner_outstanding_cents,0);assert.equal(full.owner_payout_eligible,false);
 const reopened=draftStay(f,[],{state:'open',opening_period:true},b,'2026-09-24');assert.equal(reopened.owner_payout_eligible,true);
});
test('unapplied opening schema separates period, settlement and funds with administrator attestations',()=>{
 const sql=fs.readFileSync(new URL('../supabase/migrations/202609230001_stay_finances.sql',import.meta.url),'utf8');
 for(const field of ['opening_period boolean','owner_settlement_state text','cleaner_settlement_state text','owner_settled_cents bigint','cleaner_settled_cents bigint','expenses_complete boolean'])assert.ok(sql.includes(field));
 assert.match(sql,/administrator only/);assert.match(sql,/Opening-period eligibility requires checkout on or before/);
 assert.match(sql,/owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding'\) or confirmed_by_bond/);
 const backfill=fs.readFileSync(new URL('../supabase/migrations/202609230002_september_backfill.sql',import.meta.url),'utf8');
 assert.match(backfill,/then 'fully_settled_historical' else 'open'/);assert.match(backfill,/then 'fully_settled' else 'outstanding'/);
});
