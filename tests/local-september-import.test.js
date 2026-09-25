import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createLocalImportHandler,runControlledImport,controlledImportRequest } from '../scripts/local-september-import.mjs';
import { selectApproved,rememberImportPreview,getImportSelection,selectionDisplay } from '../scripts/september-import-selection.mjs';
import { collectHistorical,makeHistoricalPreview } from '../lib/beds24-historical-backfill.js';
const url='https://abcdefghijklmnopqrst.supabase.co';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:url,BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'test-account',BSTE_STAFF_ORIGIN:'https://localhost:3443',BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test'});delete process.env.VERCEL;delete process.env.VERCEL_ENV;
const rows=[{id:99100111,propertyId:351452,roomId:724919,arrival:'2026-09-05',departure:'2026-09-13',status:'confirmed',channel:'Airbnb'},
{id:99100222,propertyId:352005,roomId:726060,arrival:'2026-09-08',departure:'2026-09-11',status:'new',channel:'Airbnb'},
{id:99100333,propertyId:352276,roomId:726696,arrival:'2026-09-06',departure:'2026-09-13',status:'confirmed',channel:'Booking.com'}];
async function fixture(){const d=await collectHistorical({token:'mock-read-only',account:'test-account',fetcher:async(u,o)=>{assert.equal(o.method,'GET');return Response.json({data:rows.filter(r=>r.roomId===Number(new URL(u).searchParams.get('roomId'))).map(r=>({...r,firstName:'PrivateGuest',email:'secret@example.org',deposit:9000,price:10000})),pages:{nextPageExists:false}});}});return makeHistoricalPreview(d,[],'test-account');}
const request=(body={action:'import',confirmed:true})=>({method:'POST',headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json',cookie:'__Host-bste_staff=test-jwt'},socket:{encrypted:true,remoteAddress:'127.0.0.1'},body});
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(body){this.body=body;return this;}});
function auth(t,overrides={},expired=false){t.mock.method(globalThis,'fetch',async(u)=>{if(new URL(u).pathname==='/auth/v1/user')return Response.json({id:'bond'},{status:expired?401:200});assert.equal(new URL(u).pathname,'/rest/v1/rpc/ops_staff_access');return Response.json({active:true,user_id:'bond',role:'administrator',mfa_required:true,mfa_satisfied:true,permissions:['sync.run','finance.write','finance.read','finance.cutover'],...overrides});});}
for(const [name,overrides,expired,change] of [
 ['anonymous',{},false,r=>{delete r.headers.cookie;}],['expired',{},true,()=>{}],['AAL1',{mfa_satisfied:false},false,()=>{}],['inactive',{active:false},false,()=>{}],['Finance',{role:'finance'},false,()=>{}],['Operations',{role:'operations'},false,()=>{}],['missing finance write',{permissions:['sync.run','finance.read']},false,()=>{}],['wrong Origin',{},false,r=>{r.headers.origin='https://evil.invalid';}],['GET',{},false,r=>{r.method='GET';}],['unconfirmed',{},false,r=>{r.body.confirmed=false;}],['arbitrary IDs',{},false,r=>{r.body.import_ids=[999];}],['settlement injection',{},false,r=>{r.body.settle_ids=[99100111];}],['remote request',{},false,r=>{r.socket.remoteAddress='192.0.2.1';}]
])test('controlled import rejects '+name,async t=>{auth(t,overrides,expired);let ran=false;const h=createLocalImportHandler({run:async()=>{ran=true;},selection:()=>{throw Error('Must not reach selection');}});const q=request();change(q);const res=response();await h(q,res);assert.ok(res.code>=400);assert.equal(ran,false);});
test('preview identities are server-held and isolated by user/session, expire, and reject ambiguous/substituted candidates',async()=>{
 const p=await fixture();rememberImportPreview('bond','token-a',p,100);const s=getImportSelection('bond','token-a',101);assert.equal(s.ids.length,3);p.entries[0].item.snapshot.beds24_booking_id=42;assert.equal(s.ids[0],99100111);
 assert.throws(()=>getImportSelection('leah','token-a',101));assert.throws(()=>getImportSelection('bond','token-b',101));assert.throws(()=>getImportSelection('bond','token-a',26*60000));
 for(const mutate of [p=>p.entries.pop(),p=>p.entries.push(p.entries[0]),p=>p.entries[0].masked.classification='request',p=>p.entries[0].item.snapshot.source_channel='Other',p=>p.entries[0].item.snapshot.roomId=999,p=>p.entries[0].item.snapshot.beds24_room_id=999]){
  const bad=await fixture();mutate(bad);if(bad.entries[0].item.snapshot.roomId===999)continue;assert.throws(()=>selectApproved(bad));
 }
 assert.doesNotMatch(JSON.stringify(selectionDisplay(s)),/99100111|99100222|99100333|PrivateGuest|secret@example/);
});
test('three missing stays import via exact historical RPCs, preserve source and sync, and rerun without writes',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('External network forbidden'));
 const p=await fixture();const saved={preview:p,ids:selectApproved(p).map(e=>e.item.snapshot.beds24_booking_id)};
 const current=Array.from({length:14},(_,i)=>({id:'current-'+i,source_environment:'production',source_account:'test-account',beds24_booking_id:800000+i}));
 const original=structuredClone(current);const normalSync={id:'existing-sync',count:14};const calls=[],openings=new Map();let staged;
 const mock=async(path,token,o={})=>{
  calls.push({path,method:o.method||'GET'});
  if(path.startsWith('ops_bookings?'))return structuredClone(current);
  if(path.startsWith('ops_stay_opening_positions?'))return openings.get(new URL('https://test/'+path).searchParams.get('booking_id').slice(3))||[];
  if(path==='rpc/ops_stage_historical_batch'){
   assert.equal(o.method,'POST');assert.equal(o.body.approved_items.length,3);assert.ok(o.body.approved_items.every(i=>i.settle===false));staged=o.body.approved_items;return 'mock-batch';
  }
  if(path==='rpc/ops_apply_historical_batch'){
   assert.equal(o.service,true);for(const item of staged){const s=item.snapshot;const id='historical-'+s.beds24_booking_id;assert.equal(s.funds_received,undefined);assert.equal(item.financial.funds_received_cents,undefined);current.push({...s,id});openings.set(id,[{opening_period:true,state:'open',owner_settlement_state:'outstanding',cleaner_settlement_state:'outstanding',owner_settled_cents:0,cleaner_settled_cents:0}]);}return {booking_count:3,newly_created_opening_count:3,preserved_opening_count:0,settlement_count:0};
  }assert.fail('Forbidden path '+path);
 };
 const first=await runControlledImport(saved,'test-jwt',{request:mock});assert.equal(first.imported_count,3);assert.equal(first.newly_created_opening_count,3);assert.equal(first.preserved_opening_count,0);assert.equal(first.settlement_count,0);assert.equal(first.total_bookings,17);assert.equal(first.opening_period_count,3);assert.equal(first.funds_received_recorded,false);assert.deepEqual(current.slice(0,14),original);assert.deepEqual(normalSync,{id:'existing-sync',count:14});
 const writeCount=calls.filter(c=>c.method==='POST').length;const second=await runControlledImport(saved,'test-jwt',{request:mock});assert.equal(second.imported_count,0);assert.equal(second.newly_created_opening_count,0);assert.equal(second.preserved_opening_count,3);assert.equal(second.already_existing_count,3);assert.equal(calls.filter(c=>c.method==='POST').length,writeCount);assert.equal(current.length,17);assert.equal(openings.size,3);
 assert.ok(calls.every(c=>!/(sync_run|sync_member|finance_write|payment|communication|expense|receipt)/.test(c.path)));
 assert.equal(current.find(b=>b.beds24_booking_id===99100222).source_status,'new');
});
test('write allowlist denies funds, settlement selection, ordinary sync and communications',()=>{
 for(const p of ['ops_payment_records','rpc/ops_finance_write','rpc/ops_begin_sync','rpc/ops_apply_sync','ops_communications'])assert.throws(()=>controlledImportRequest(p,'token',{method:'POST',body:{}}));
 assert.throws(()=>controlledImportRequest('rpc/ops_stage_historical_batch','token',{method:'POST',body:{approved_items:[{settle:true}]}}));
});
test('AAL2 admin displays only three and imports once with repeated click returning idempotent result',async t=>{
 auth(t);const p=await fixture();const saved={preview:p,ids:selectApproved(p).map(e=>e.item.snapshot.beds24_booking_id)};let calls=0;
 const h=createLocalImportHandler({selection:()=>saved,run:async()=>{calls++;return {imported_count:3,already_existing_count:0,total_bookings:17,opening_period_count:3,exceptions:[]};}});
 const show=response();await h(request({action:'show'}),show);assert.equal(show.code,200);assert.equal(show.body.candidates.length,3);assert.equal(calls,0);
 const first=response();await h(request(),first);assert.equal(first.code,200);const second=response();await h(request(),second);assert.equal(second.body.imported_count,0);assert.equal(calls,1);
});
test('browser only loads selection automatically; confirmation required; no retries on failure',async()=>{
 const nodes=new Map();const el=()=>({disabled:true,checked:false,append(){},addEventListener(name,fn){this[name]=fn;}});const document={getElementById(id){if(!nodes.has(id))nodes.set(id,el());return nodes.get(id);},createElement:el};const actions=[];
 vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-import.js',import.meta.url),'utf8'),{document,fetch:async(u,o)=>{const b=JSON.parse(o.body);actions.push(b);if(b.action==='show')return {ok:true,json:async()=>({candidates:[{},{},{}]})};throw Error('failure');}});
 await new Promise(r=>setImmediate(r));assert.deepEqual(actions,[{action:'show'}]);await nodes.get('import').click();assert.equal(actions.length,1);nodes.get('confirmed').checked=true;await nodes.get('import').click();await nodes.get('import').click();assert.equal(actions.length,2);assert.match(nodes.get('status').textContent,/No automatic retry/);
 const html=fs.readFileSync(new URL('../scripts/staff-september-import.html',import.meta.url),'utf8');assert.equal((html.match(/<button/g)||[]).length,1);
});

test('legacy or inconsistent committed RPC counters cannot report successful import',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('External network forbidden'));
 const p=await fixture();const saved={preview:p,ids:selectApproved(p).map(e=>e.item.snapshot.beds24_booking_id)};
 for(const result of [{booking_count:3,settlement_count:0},{booking_count:3,newly_created_opening_count:0,preserved_opening_count:0,settlement_count:0},{booking_count:3,newly_created_opening_count:3,preserved_opening_count:0,settlement_count:1}]){
  await assert.rejects(runControlledImport(saved,'mock',{request:async()=>[],apply:async()=>result}),/counters unconfirmed/);
 }
});

test('browser distinguishes bookings, created openings, preserved openings and settlements',async()=>{
 const nodes=new Map();const el=()=>({disabled:true,checked:false,append(){},addEventListener(name,fn){this[name]=fn;}});
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,el());return nodes.get(id);},createElement:el};
 vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-import.js',import.meta.url),'utf8'),{document,fetch:async(u,o)=>({ok:true,json:async()=>JSON.parse(o.body).action==='show'?{candidates:[{},{},{}]}:{imported_count:3,newly_created_opening_count:3,preserved_opening_count:0,settlement_count:0}})});
 await new Promise(r=>setImmediate(r));nodes.get('confirmed').checked=true;await nodes.get('import').click();
 assert.match(nodes.get('status').textContent,/3 bookings imported; 3 opening rows created; 0 opening rows preserved; 0 settlement rows created/);
});
