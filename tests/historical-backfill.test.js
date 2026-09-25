import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectHistorical,makeHistoricalPreview,previewHistorical,applyApprovedHistorical,cutoffEligible} from '../lib/beds24-historical-backfill.js';
import {PROPERTIES} from '../lib/operations-model.js';
import {draftStay,validateReceipt} from '../lib/stay-finances.js';
import {main} from '../scripts/preview-september-backfill.mjs';
const now=new Date('2026-09-24T10:00:00Z');
const raw=(id=1,status='confirmed',departure='2026-09-23')=>({id,status,propertyId:351452,roomId:724919,arrival:'2026-09-20',departure,firstName:'Private',lastName:'Person',email:'private@example.org',mobile:'+27821234567',price:12000,deposit:6000,numAdult:2,channel:'Airbnb'});
const page=(data,next=false)=>new Response(JSON.stringify({data,pages:{nextPageExists:next}}));
const collect=async(rows)=>{const pages=[page(rows),page([]),page([])];return collectHistorical({token:'test-read-only',account:'bste-test',now,fetcher:async()=>pages.shift()});};
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'bste-test'});
for(const [date,eligible] of [['2026-09-22',true],['2026-09-23',true],['2026-09-24',false]])test(`historical cutoff ${date}: ${eligible}`,()=>assert.equal(cutoffEligible(date),eligible));
test('GET-only historical collection uses all three explicit rooms and exact departure scope',async()=>{
 const calls=[],pages=[page([raw(1,'new','2026-09-01'),raw(2,'confirmed','2026-09-23'),raw(3,'confirmed','2026-09-24')]),page([]),page([])];
 // First fixture must have valid arrival before September 1.
 const first=raw(1,'new','2026-09-01');first.arrival='2026-08-30';pages[0]=page([first,raw(2),raw(3,'confirmed','2026-09-24')]);
 const d=await collectHistorical({token:'test',account:'bste-test',now,fetcher:async(u,o)=>{calls.push([u,o]);return pages.shift();}});
 assert.deepEqual(d.items.map(e=>e.item.snapshot.beds24_booking_id),[1,2]);
 assert.deepEqual(calls.map(([u])=>Number(new URL(u).searchParams.get('roomId'))),PROPERTIES.map(p=>p.roomId));
 for(const [u,o] of calls){assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(new URL(u).pathname,'/api/v2/bookings');assert.equal(new URL(u).searchParams.has('status'),false);}
});
test('preview preserves and separates cancelled, block, request, inquiry and unusual status',async()=>{
 const d=await collect(['confirmed','cancelled','black','request','inquiry','unexpected'].map((s,i)=>raw(i+1,s)));
 const p=makeHistoricalPreview(d,[],'bste-test');
 assert.deepEqual(p.report.records.map(r=>r.classification),['guest_candidate','cancelled','block','request','inquiry']);
 assert.equal(p.report.exceptions[0].classification,'unusual_status');
 assert.equal(p.entries[3].item.snapshot.source_status,'request');assert.equal(p.entries[3].item.snapshot.operational_status,undefined);
});
test('preview distinguishes stored, missing and changed facts without leaking PII',async()=>{
 const d=await collect([raw(1),raw(2)]),old={...d.items[0].item.snapshot,id:'old-id',last_synced_at:'2026-09-23T00:00:00Z',guest_name:'Previous name',ops_booking_financial_snapshots:d.items[0].item.financial};
 const p=makeHistoricalPreview(d,[old],'bste-test');assert.equal(p.report.records[0].storage,'already_stored');assert.ok(p.report.records[0].changed_fields.includes('guest_name'));
 assert.equal(p.report.records[1].storage,'missing_locally');assert.doesNotMatch(JSON.stringify(p.report),/Private|Person|private@example|27821234567|Previous name/);
});
test('duplicate pages deduplicate identical entries and block conflicting source data',async()=>{
 const d=await collect([raw(1),raw(1),{...raw(1),price:999}]);assert.equal(d.items.length,1);
 assert.deepEqual(d.duplicates.map(x=>x.condition),['identical_duplicate','conflicting_duplicate']);
 const p=makeHistoricalPreview(d,[],'bste-test');assert.equal(p.report.can_apply,false);
 await assert.rejects(applyApprovedHistorical(p,{digest:p.digest,confirmed_by_bond:true,reason:'Bond approved',import_ids:[1],settle_ids:[1]},{request:async()=>{throw new Error('Must not write');}}),/Bond-approved preview selection/);
});
test('preview reads staging but never registers a batch or calls a write RPC',async()=>{
 const calls=[],pages=[page([raw()]),page([]),page([])];
 const p=await previewHistorical({staffToken:'staff',token:'test',now,fetcher:async()=>pages.shift(),request:async(path,token,options)=>{
  calls.push(path);assert.equal(options,undefined);return path==='rpc/ops_staff_access'?{active:true,role:'administrator',mfa_satisfied:true,permissions:['sync.run','finance.read']}:[];}});
 assert.equal(p.report.records.length,1);assert.ok(calls.every(p=>!p.includes('sync_runs')&&!p.includes('stage_historical')&&!p.includes('apply')));
});
test('CLI has no apply mode; help never reads services and preview prints only report',async()=>{
 let calls=0,printed;const preview=async()=>{calls++;return {entries:[{secret:'private'}],report:{notice:'masked'}};};
 await main(['--help'],{preview,print:()=>{}});assert.equal(calls,0);
 await assert.rejects(main(['--apply'],{preview}),/no apply mode/);assert.equal(calls,0);
 await main(['--preview'],{preview,env:{},print:s=>{printed=s;}});assert.equal(calls,1);assert.equal(printed,JSON.stringify({notice:'masked'},null,2));
});
test('apply requires fresh exact preview approval and never batch-settles exceptions',async()=>{
 const p=makeHistoricalPreview(await collect([raw(1),raw(2,'request')]),[],'bste-test');const base={digest:p.digest,confirmed_by_bond:true,reason:'Bond confirmed',import_ids:[1,2],settle_ids:[2]};
 let writes=0;const request=async()=>{writes++;};
 await assert.rejects(applyApprovedHistorical(p,base,{request}),/Exceptional/);assert.equal(writes,0);
 await assert.rejects(applyApprovedHistorical(p,{...base,digest:'wrong'},{request}),/Bond-approved preview selection/);assert.equal(writes,0);
});
test('approved path uses only historical RPCs and preserves original source account',async()=>{
 const p=makeHistoricalPreview(await collect([raw()]),[],'bste-test'),calls=[];
 await applyApprovedHistorical(p,{digest:p.digest,confirmed_by_bond:true,reason:'Bond reviewed',import_ids:[1],settle_ids:[1]},{staffToken:'staff',request:async(path,token,opts)=>{calls.push([path,token,opts]);return 'batch-id';}});
 assert.deepEqual(calls.map(c=>c[0]),['rpc/ops_stage_historical_batch','rpc/ops_apply_historical_batch']);
 assert.equal(calls[0][1],'staff');assert.equal(calls[1][2].service,true);
 const item=calls[0][2].body.approved_items[0];assert.equal(item.snapshot.source_account,'bste-test');assert.equal(item.snapshot.source_environment,'production');
 assert.equal(item.snapshot.automation_enrolled_at,undefined);assert.equal(item.financial.source_deposit,6000);assert.equal(item.snapshot.payment_status,undefined);
});
test('settled historical stay remains excluded after expenses and supported receipt attachments',()=>{
 const opening={state:'fully_settled_historical'},r={status:'reviewed',expenses_complete:true,accommodation_cents:1000000,cleaning_charge_cents:100000,channel_fees_cents:0,cleaner_cost_cents:80000,funds_received_cents:1100000,rate_nights:[{rate_cents:400000}],checkout_month:'2026-09-01'};
 const e={id:'expense',status:'approved',category:'stocking',owner_amount_cents:50000,bste_amount_cents:0,payer:'bste',allocation:'owner'};
 for(const bytes of [Buffer.from('%PDF-1.7'),Buffer.from([255,216,255]),Buffer.from([137,80,78,71,13,10,26,10])]) {
  validateReceipt(bytes,bytes[0]===37?'application/pdf':bytes[0]===255?'image/jpeg':'image/png');
  const d=draftStay(r,[e],opening,{departure:'2026-09-23'},'2026-09-24');assert.equal(d.eligibility,'historical_settled');assert.equal(d.cleaner_monthly_candidate_cents,0);assert.equal(d.exclude_from_new_payables,true);
 }
});
test('migration statically isolates normal sync and keeps existing decisions/staff finance records',()=>{
 const sql=fs.readFileSync(new URL('../supabase/migrations/202609230002_september_backfill.sql',import.meta.url),'utf8');
 assert.doesNotMatch(sql,/(insert into|update|delete from) public\.ops_(sync_runs|sync_members|communications|payment_records|stay_expenses|expense_attachments|stay_financial_reviews)/i);
 assert.match(sql,/if result.batch_id is not null then return/);assert.match(sql,/if exists\(select 1 from public.ops_stay_opening_positions where booking_id=booking\)/);
 assert.match(sql,/role='administrator'/);assert.match(sql,/finance.cutover/);assert.match(sql,/approved_session/);assert.match(sql,/Stored booking changed since preview/);
 const phase1=fs.readFileSync(new URL('../supabase/migrations/202609230001_stay_finances.sql',import.meta.url),'utf8');
 assert.match(phase1,/b.departure>'2026-09-23'::date/);assert.doesNotMatch(phase1,/b.departure>='2026-09-23'/);
});
test('explicit non-guest indicators are previewed and cannot be selected for settlement',async()=>{
 const p=makeHistoricalPreview(await collect([{...raw(),bookingType:'owner_stay'}]),[],'bste-test');
 assert.equal(p.report.records[0].classification,'non_guest');
 await assert.rejects(applyApprovedHistorical(p,{digest:p.digest,confirmed_by_bond:true,reason:'review',import_ids:[1],settle_ids:[1]},{request:async()=>{throw new Error('No writes');}}),/Exceptional/);
});
