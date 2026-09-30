import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHistoricalDirectHandler,directRequest,DIRECT_REFERENCE,DIRECT_CANDIDATE} from '../scripts/local-historical-direct.mjs';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test',BSTE_BEDS24_ACCOUNT_KEY:'test-account',BSTE_STAFF_ORIGIN:'https://localhost:3443'});
delete process.env.VERCEL;delete process.env.VERCEL_ENV;
const req=(action='preview')=>({method:'POST',headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json',cookie:'__Host-bste_staff=test-token'},socket:{encrypted:true,remoteAddress:'127.0.0.1'},body:action==='repair'?{action,confirmed:true}:{action}});
const res=()=>({setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
function auth(t,overrides={}){t.mock.method(globalThis,'fetch',async u=>{const path=new URL(u).pathname;if(path==='/auth/v1/user')return Response.json({id:'synthetic-admin'});assert.equal(path,'/rest/v1/rpc/ops_staff_access');return Response.json({user_id:'synthetic-admin',active:true,role:'administrator',mfa_required:true,mfa_satisfied:true,permissions:['operations.write','finance.read','finance.write','finance.cutover'],...overrides});});}

const q=(action='preview')=>({...req(),body:action==='create'?{action,confirmed:true,overlaps_reviewed:true}:{action}});
function fixture(){let rows=[],writes=0;return {writes:()=>writes,request:async(p,t,o={})=>{if(o.method==='POST'){writes++;assert.equal(p,'rpc/ops_create_charl_historical_direct');assert.deepEqual(o.body,{expected_overlap_ids:[],overlaps_reviewed:true});rows=[{id:'manual',source_kind:'manual_direct',source_environment:'production',source_account:'bste-historical-direct',beds24_booking_id:null,beds24_property_id:352005,beds24_room_id:726060,manual_reference:DIRECT_REFERENCE,manual_booked_on:DIRECT_CANDIDATE.booked_on,manual_note:DIRECT_CANDIDATE.note,manual_created_by:'synthetic-admin',property_slug:DIRECT_CANDIDATE.property_slug,guest_name:'Charl Baard',adults:5,arrival:DIRECT_CANDIDATE.arrival,departure:DIRECT_CANDIDATE.departure,source_status:'confirmed',source_channel:DIRECT_CANDIDATE.source}];return 'manual';}return structuredClone(rows);}};}
for(const [name,overrides,mutate] of [['anonymous',{},r=>delete r.headers.cookie],['AAL1',{mfa_satisfied:false},()=>{}],['Finance',{role:'finance'},()=>{}],['Operations',{role:'operations'},()=>{}],['inactive',{active:false},()=>{}],['origin',{},r=>r.headers.origin='https://evil.invalid'],['GET',{},r=>r.method='GET'],['passport payload',{},r=>r.body.passport='forbidden'],['HTTP',{},r=>r.socket.encrypted=false]])test('direct rejects '+name,async t=>{auth(t,overrides);const r=q();mutate(r);const out=res();await createHistoricalDirectHandler({request:async()=>assert.fail('no storage')})(r,out);assert.ok(out.code>=400);});
test('direct preview has no writes; creation verified; rerun idempotent',async t=>{auth(t);const f=fixture(),h=createHistoricalDirectHandler({request:f.request});let out=res();await h(q(),out);assert.equal(out.code,200);assert.equal(f.writes(),0);out=res();await h(q('create'),out);assert.equal(out.body.saved,true);assert.equal(f.writes(),1);out=res();await h(q('create'),out);assert.equal(out.body.created,false);assert.equal(f.writes(),1);});
test('direct requires matching unexpired session preview',async t=>{auth(t);for(const mode of ['session','expiry','confirmation']){const f=fixture();let time=0;const h=createHistoricalDirectHandler({request:f.request,now:()=>time});await h(q(),res());const r=q('create');if(mode==='session')r.headers.cookie='__Host-bste_staff=changed';if(mode==='expiry')time=26*60000;if(mode==='confirmation')r.body.confirmed=false;const out=res();await h(r,out);assert.ok(out.code>=400);assert.equal(f.writes(),0);}});
test('uncertain creation is never automatically retried',async t=>{auth(t);let writes=0;const h=createHistoricalDirectHandler({request:async(p,t,o={})=>{if(o.method==='POST'){writes++;throw Error('private');}return [];}});await h(q(),res());for(let i=0;i<2;i++){const out=res();await h(q('create'),out);assert.match(out.body.error,/unconfirmed|uncertain/);}assert.equal(writes,1);});
test('direct transport cannot write finance, openings, imports or communications',()=>{for(const p of ['ops_bookings','rpc/ops_finance_write','rpc/ops_apply_sync','rpc/ops_apply_historical_batch','ops_stay_opening_positions','ops_communications'])assert.throws(()=>directRequest(p,'test',{method:'POST',body:{}}));});
test('schema separates manual identity and protects it from importer overwrite/delete',()=>{const s=fs.readFileSync(new URL('../supabase/migrations/202609260001_manual_historical_direct_bookings.sql',import.meta.url),'utf8');assert.match(s,/beds24_booking_id drop not null/);assert.match(s,/source_kind='manual_direct' and beds24_booking_id is null/);assert.match(s,/before update or delete/);assert.match(s,/Beds24 importer cannot write manual direct bookings/);assert.match(s,/create unique index ops_manual_booking_reference/);assert.doesNotMatch(s,/insert into public.ops_(stay_opening_positions|payment_records|stay_financial_reviews|communications)/);assert.match(s,/finance.cutover/);assert.match(s,/overlaps_reviewed/);});

test('wrong environment denies direct workflow',async t=>{auth(t);process.env.BSTE_STAFF_ENV='production';t.after(()=>process.env.BSTE_STAFF_ENV='staging');const out=res();await createHistoricalDirectHandler({request:async()=>assert.fail('no data')})(q(),out);assert.ok(out.code>=400);});
test('SQL regression uses real repeated sync and rolls back fixtures',()=>{const s=fs.readFileSync(new URL('./manual-historical-direct-rls.sql',import.meta.url),'utf8');assert.equal((s.match(/select public.ops_apply_sync/g)||[]).length,2);assert.match(s,/Manual record unchanged after repeated actual sync/);assert.match(s,/Every previous booking unchanged/);assert.match(s,/rollback;/);});
test('manual booking does not receive missing-source warnings after refresh',async()=>{const {presentDashboard}=await import('../lib/operations-model.js');const r=presentDashboard([{source_kind:'manual_direct',source_status:'confirmed',arrival:'2026-09-08',departure:'2026-09-12',not_seen_in_latest_sync:true,payment_visible:true}],[]);assert.ok(r.bookings[0].attention.includes('Payment not reviewed'));assert.ok(!r.bookings[0].attention.some(x=>/refresh|latest complete sync/.test(x)));});

test('overlapping bookings require explicit acknowledgement and are masked',async t=>{auth(t);let writes=0;const h=createHistoricalDirectHandler({request:async(p,t,o={})=>{if(o.method==='POST'){writes++;throw Error('unexpected');}return [{id:'other',guest_name:'Private other guest',arrival:'2026-09-08',departure:'2026-09-11',source_kind:'beds24',source_status:'new'}];}});let out=res();await h(q(),out);assert.equal(out.body.overlap_count,1);assert.doesNotMatch(JSON.stringify(out.body),/Private other guest/);const r=q('create');r.body.overlaps_reviewed=false;out=res();await h(r,out);assert.equal(out.code,409);assert.equal(writes,0);});
test('browser makes only one explicit creation attempt',async()=>{const vm=await import('node:vm');const nodes=new Map();const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{checked:false,addEventListener(e,f){this[e]=f;}});return nodes.get(id);}};const calls=[];vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-historical-direct.js',import.meta.url),'utf8'),{document,fetch:async(u,o)=>{const b=JSON.parse(o.body);calls.push(b);if(b.action==='preview')return {ok:true,json:async()=>({already_exists:false,overlap_count:0})};throw Error('lost response');}});await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);nodes.get('confirmed').checked=true;await nodes.get('create').click();await nodes.get('create').click();assert.equal(calls.length,2);assert.match(nodes.get('status').textContent,/No automatic retry/);});

test('overlap variable avoids PostgreSQL OVERLAPS grammar without weakening guard',()=>{
 const s=fs.readFileSync(new URL('../supabase/migrations/202609260001_manual_historical_direct_bookings.sql',import.meta.url),'utf8');
 assert.doesNotMatch(s,/\boverlaps\s+(?:uuid|is)|into overlaps\b|cardinality\(overlaps\)/i);
 assert.match(s,/v_overlap_ids uuid\[\]/);
 assert.match(s,/expected_overlap_ids is null or v_overlap_ids is distinct from/);
 assert.match(s,/cardinality\(v_overlap_ids\)>0 and overlaps_reviewed is distinct from true/);
 assert.match(s,/'overlap_ids',v_overlap_ids/);
 assert.match(s,/^begin;/m);assert.match(s,/commit;\s*$/);
});
test('migration-state diagnostic is catalog-only and covers all introduced artifacts',()=>{
 const s=fs.readFileSync(new URL('../docs/manual-direct-migration-state.sql',import.meta.url),'utf8');
 assert.doesNotMatch(s,/\b(insert|update|delete|alter|create|drop|call|do)\s+(into|table|function|public|\$\$)/i);
 for(const marker of ['manual_created_by','manual_booked_on','manual_reference','manual_note','source_kind','beds24_booking_id','first_imported_at','last_synced_at','ops_booking_source_identity','ops_manual_booking_reference','ops_guard_manual_source','ops_create_charl_historical_direct','ops_sync_booking','ops_dashboard_rows','pg_policy','has_function_privilege','UNCHANGED'])assert.ok(s.includes(marker),marker);
});

test('rollback sync fixtures are unique and sequential, never two running rows for one account',()=>{
 const s=fs.readFileSync(new URL('./manual-historical-direct-rls.sql',import.meta.url),'utf8');
 assert.match(s,/'direct-fixture-sync-'\|\|gen_random_uuid\(\)::text/);
 assert.doesNotMatch(s,/'production','direct-fixture-sync'/);
 const inserts=[...s.matchAll(/insert into public.ops_sync_runs/g)].map(m=>m.index);
 const applies=[...s.matchAll(/select public.ops_apply_sync/g)].map(m=>m.index);
 assert.equal(inserts.length,2);assert.equal(applies.length,2);
 assert.ok(inserts[0]<applies[0]&&applies[0]<inserts[1]&&inserts[1]<applies[1]);
 assert.match(s,/First sync completed before second starts/);
 assert.match(s,/set_config\('test.direct.sync_one',gen_random_uuid\(\)::text,true\)/);
 assert.match(s,/set_config\('test.direct.sync_two',gen_random_uuid\(\)::text,true\)/);
 assert.match(s,/^begin;/m);assert.match(s,/^rollback;/m);assert.doesNotMatch(s,/^commit;/m);
});
test('fixture diagnostic reads operational metadata and artifact counts only',()=>{
 const s=fs.readFileSync(new URL('../docs/manual-direct-sync-fixture-diagnostic.sql',import.meta.url),'utf8');
 assert.match(s,/source_account='direct-fixture-sync'/);assert.match(s,/approved_manual_reference_rows_expected_zero/);
 assert.match(s,/synthetic_actor_event_rows/);assert.match(s,/completed_at/);
 assert.doesNotMatch(s,/\b(insert into|update public|delete from|alter table|create table|select \*)\b/i);
});
