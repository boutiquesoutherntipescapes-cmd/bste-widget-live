import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createLocalRepairHandler,repairRequest,REPAIR_REASON} from '../scripts/local-september-repair.mjs';
import {APPROVED_STAYS} from '../scripts/september-import-selection.mjs';
import {PROPERTIES} from '../lib/operations-model.js';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test',BSTE_BEDS24_ACCOUNT_KEY:'test-account',BSTE_STAFF_ORIGIN:'https://localhost:3443'});
delete process.env.VERCEL;delete process.env.VERCEL_ENV;
const req=(action='preview')=>({method:'POST',headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json',cookie:'__Host-bste_staff=test-token'},socket:{encrypted:true,remoteAddress:'127.0.0.1'},body:action==='repair'?{action,confirmed:true}:{action}});
const res=()=>({setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
function auth(t,overrides={}){t.mock.method(globalThis,'fetch',async u=>{const path=new URL(u).pathname;if(path==='/auth/v1/user')return Response.json({id:'synthetic-admin'});assert.equal(path,'/rest/v1/rpc/ops_staff_access');return Response.json({user_id:'synthetic-admin',active:true,role:'administrator',mfa_required:true,mfa_satisfied:true,permissions:['sync.run','finance.read','finance.write','finance.cutover'],...overrides});});}
function fixture(){
 const items=APPROVED_STAYS.map((s,i)=>{const p=PROPERTIES.find(p=>p.slug===s.property);return {settle:false,expected_id:null,raw:{},snapshot:{source_environment:'production',source_account:'test-account',beds24_booking_id:990001+i,property_slug:s.property,beds24_property_id:p.propertyId,beds24_room_id:p.roomId,arrival:s.arrival,departure:s.departure,source_channel:s.channel,source_status:'confirmed'}};});
 const batch={id:'b1000000-0000-0000-0000-000000000001',source_environment:'production',source_account:'test-account',scope_from:'2026-09-01',scope_through:'2026-09-23',bond_confirmed:true,approved_items:items};
 const data={ops_bookings:[...items.map((x,i)=>({...x.snapshot,id:'historical-'+i})),...Array.from({length:14},(_,i)=>({id:'current-'+i}))],ops_historical_batches:[batch],ops_historical_results:[{batch_id:batch.id,booking_count:3,settlement_count:0,retained_opening_count:0,newly_created_opening_count:null,preserved_opening_count:null}],ops_stay_opening_positions:[]};
 let writes=0;const request=async(path,token,options={})=>{if(options.method==='POST'){writes++;assert.equal(path,'rpc/ops_repair_september_openings');assert.deepEqual(options.body,{target_batch:batch.id,repair_reason:REPAIR_REASON});assert.equal(options.service,undefined);data.ops_stay_opening_positions=items.map((_,i)=>({id:'opening-'+i,booking_id:'historical-'+i,previous_id:null,opening_period:true,state:'open',owner_settlement_state:'outstanding',cleaner_settlement_state:'outstanding',owner_settled_cents:0,cleaner_settled_cents:0}));return {newly_created_opening_count:3,preserved_opening_count:0,settlement_count:0};}const table=path.split('?')[0];assert.ok(Object.hasOwn(data,table));return structuredClone(data[table]);};
 return {data,request,writes:()=>writes};
}
for(const [name,overrides,mutate] of [
 ['anonymous',{},q=>delete q.headers.cookie],['AAL1',{mfa_satisfied:false},()=>{}],['Finance',{role:'finance'},()=>{}],['Operations',{role:'operations'},()=>{}],['inactive',{active:false},()=>{}],['cutover permission',{permissions:['sync.run','finance.read','finance.write']},()=>{}],['origin',{},q=>q.headers.origin='https://evil.invalid'],['GET',{},q=>q.method='GET'],['client batch',{},q=>q.body.target_batch='arbitrary'],['not HTTPS',{},q=>q.socket.encrypted=false]
])test('repair rejects '+name,async t=>{auth(t,overrides);const q=req();mutate(q);const r=res();await createLocalRepairHandler({request:async()=>assert.fail('Must not read data')})(q,r);assert.ok(r.code>=400);});
test('wrong environment fails closed',async t=>{auth(t);process.env.BSTE_STAFF_ENV='production';t.after(()=>{process.env.BSTE_STAFF_ENV='staging';});const r=res();await createLocalRepairHandler({request:async()=>assert.fail('no data')})(req(),r);assert.ok(r.code>=400);});
test('preview reads only, repair verifies exact state, second execution is read-only/idempotent',async t=>{
 auth(t);const f=fixture(),h=createLocalRepairHandler({request:f.request});const before=structuredClone(f.data);let r=res();await h(req(),r);assert.equal(r.code,200);assert.equal(r.body.candidates.length,3);assert.equal(f.writes(),0);assert.doesNotMatch(JSON.stringify(r.body),/990001|test-token|historical-0/);
 r=res();await h(req('repair'),r);assert.equal(r.body.success,true);assert.equal(f.writes(),1);assert.deepEqual(r.body.counts,{bookings:17,batches:1,results:1,openings:3});
 for(const key of ['ops_bookings','ops_historical_batches','ops_historical_results'])assert.deepEqual(before[key],f.data[key]);
 r=res();await h(req('repair'),r);assert.equal(r.body.success,true);assert.equal(r.body.newly_created_opening_count,0);assert.equal(f.writes(),1);
});
for(const [name,change] of [['batch count',f=>f.data.ops_historical_batches.push(f.data.ops_historical_batches[0])],['booking identity',f=>f.data.ops_bookings[0].arrival='2026-09-04'],['settled approval',f=>f.data.ops_historical_batches[0].approved_items[0].settle=true],['request',f=>f.data.ops_historical_batches[0].approved_items[0].snapshot.source_status='request'],['block',f=>f.data.ops_historical_batches[0].approved_items[0].raw.isBlocked=true]])test('preview rejects '+name,async t=>{auth(t);const f=fixture();change(f);const r=res();await createLocalRepairHandler({request:f.request})(req(),r);assert.ok(r.code>=400);assert.equal(f.writes(),0);});
for(const mode of ['network','bad counters','bad postcondition'])test('uncertain '+mode+' blocks further execution and reload preview',async t=>{
 auth(t);const f=fixture();const request=async(p,k,o={})=>{if(o.method==='POST'){if(mode==='network')throw Error('private provider response');const result=await f.request(p,k,o);if(mode==='bad counters')result.settlement_count=1;else f.data.ops_bookings.pop();return result;}return f.request(p,k,o);};
 const h=createLocalRepairHandler({request});await h(req(),res());const r=res();await h(req('repair'),r);assert.match(r.body.error,/OUTCOME_UNCERTAIN/);assert.doesNotMatch(r.body.error,/private/);const n=f.writes();for(const action of ['preview','repair']){const again=res();await h(req(action),again);assert.match(again.body.error,/OUTCOME_UNCERTAIN/);}assert.equal(f.writes(),n);
});
test('session binding, confirmation and preview expiry enforced',async t=>{
 auth(t);for(const mode of ['session','expiry','confirmation']){const f=fixture();let now=0;const h=createLocalRepairHandler({request:f.request,now:()=>now});await h(req(),res());const q=req('repair');if(mode==='session')q.headers.cookie='__Host-bste_staff=another-token';if(mode==='expiry')now=26*60000;if(mode==='confirmation')q.body.confirmed=false;const r=res();await h(q,r);assert.ok(r.code>=400);assert.equal(f.writes(),0);}
});
test('transport denies every write other than the exact repair RPC',()=>{for(const path of ['ops_bookings','rpc/ops_apply_historical_batch','rpc/ops_finance_write','rpc/ops_apply_sync','ops_payment_records'])assert.throws(()=>repairRequest(path,'token',{method:'POST',body:{}}));assert.throws(()=>repairRequest('rpc/ops_repair_september_openings','token',{method:'POST',service:true,body:{}}));});
test('browser preview automatic but repair explicit, one attempt only',async()=>{
 const nodes=new Map();const node=()=>({disabled:true,checked:false,addEventListener(event,fn){this[event]=fn;}});const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}};const calls=[];
 vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-repair.js',import.meta.url),'utf8'),{document,fetch:async(u,o)=>{const b=JSON.parse(o.body);calls.push(b);if(b.action==='preview')return {ok:true,json:async()=>({complete:false})};throw Error('lost response');}});
 await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);await nodes.get('repair').click();assert.equal(calls.length,1);nodes.get('confirmed').checked=true;await nodes.get('repair').click();await nodes.get('repair').click();assert.equal(calls.length,2);assert.match(nodes.get('status').textContent,/No automatic retry/);
 const html=fs.readFileSync(new URL('../scripts/staff-september-repair.html',import.meta.url),'utf8');assert.equal((html.match(/<button/g)||[]).length,1);
});

test('expired provider session is denied before staging reads',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json({},{status:401}));const r=res();await createLocalRepairHandler({request:async()=>assert.fail('No data access')})(req(),r);assert.equal(r.code,401);
});
test('local server protects and serves repair assets; no deployable repair endpoint exists',async t=>{
 auth(t);const {staffLocalHandler}=await import('../scripts/staff-staging-server.mjs');
 for(const url of ['/staff-september-repair.html','/staff-september-repair.js']){
  const q=req();q.method='GET';q.url=url;const r={setHeader(){},writeHead(code){this.code=code;},end(body){this.body=String(body);}};
  await staffLocalHandler(q,r);assert.ok(r.body.includes('september-repair')||r.body.includes('September'));assert.notEqual(r.code,403);
 }
 assert.equal(fs.existsSync(new URL('../api/september-repair.js',import.meta.url)),false);
 assert.equal(fs.existsSync(new URL('../public/staff-september-repair.html',import.meta.url)),false);
});
