import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createLocalPreviewHandler,readOnlyPreviewRequest,readOnlyBeds24 } from '../scripts/local-september-preview.mjs';
import { browserPreviewReport,maskBookingId } from '../scripts/september-preview-report.mjs';
import { staffLocalHandler } from '../scripts/staff-staging-server.mjs';
const url='https://abcdefghijklmnopqrst.supabase.co';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:url,BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'test-account',BSTE_STAFF_ORIGIN:'https://localhost:3443',BEDS24_LONG_LIFE_TOKEN:'read-only-test-secret'});
delete process.env.VERCEL;delete process.env.VERCEL_ENV;
const access=(overrides={})=>({active:true,user_id:'staff-id',role:'administrator',display_name:'Bond',mfa_required:true,mfa_satisfied:true,permissions:['sync.run','finance.read'],...overrides});
const req=(overrides={})=>({method:'POST',headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json',cookie:'__Host-bste_staff=opaque-test-token'},socket:{encrypted:true,remoteAddress:'127.0.0.1'},body:{},...overrides});
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}});
function mockAuth(t,value=access(),expired=false){const calls=[];t.mock.method(globalThis,'fetch',async(u,o={})=>{calls.push([u,o]);const path=new URL(u).pathname;if(path==='/auth/v1/user')return Response.json({id:'staff-id'},{status:expired?401:200});if(path==='/rest/v1/rpc/ops_staff_access')return Response.json(value);throw Error('Unexpected network path');});return calls;}
for(const [name,request,staff,expired,code] of [
 ['unauthenticated',req({headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json'}}),access(),false,401],
 ['expired',req(),access(),true,401],['AAL1',req(),access({mfa_satisfied:false}),false,403],
 ['inactive',req(),access({active:false}),false,403],
 ['Operations',req(),access({role:'operations',mfa_required:false,mfa_satisfied:false,permissions:['operations.read']}),false,403],
 ['Finance even with sync grant',req(),access({role:'finance'}),false,403],
 ['missing finance permission',req(),access({permissions:['sync.run']}),false,403],
 ['wrong Origin',req({headers:{...req().headers,origin:'https://evil.invalid'}}),access(),false,403],
 ['GET',req({method:'GET'}),access(),false,405],
 ['non JSON',req({headers:{...req().headers,'content-type':'text/plain'}}),access(),false,415],
 ['nonlocal socket',req({socket:{encrypted:true,remoteAddress:'192.0.2.1'}}),access(),false,403],
 ['insecure socket',req({socket:{encrypted:false,remoteAddress:'127.0.0.1'}}),access(),false,403],
 ['request parameters',req({body:{action:'apply'}}),access(),false,400]
])test('preview rejects '+name,async t=>{mockAuth(t,staff,expired);let ran=false;const h=createLocalPreviewHandler({preview:async()=>{ran=true;}}),res=response();await h(request,res);assert.equal(res.code,code);assert.equal(ran,false);assert.doesNotMatch(JSON.stringify(res),/opaque-test-token|read-only-test-secret/);});
test('production or missing isolation fails before any service access',async t=>{
 mockAuth(t);const h=createLocalPreviewHandler();for(const [key,value] of [['VERCEL_ENV','production'],['VERCEL','1'],['BSTE_STAFF_ENV','production'],['BSTE_OPERATIONS_ENABLED','false'],['BSTE_STAFF_SUPABASE_URL','https://wrong.supabase.co']]){const old=process.env[key];process.env[key]=value;try{const res=response();await h(req(),res);assert.notEqual(res.code,200);}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}}
});
const raw={id:92783243,propertyId:351452,roomId:724919,arrival:'2026-09-20',departure:'2026-09-23',status:'confirmed',channel:'Airbnb',firstName:'PrivateGuest',lastName:'PrivateSurname',email:'private@example.org',phone:'+27821234567',price:12000,deposit:6000};
test('real preview pipeline with mocked providers: administrator AAL2 succeeds; zero writes and no sync state access',async t=>{
 const calls=[];const state={syncRuns:[{id:'unchanged'}],notes:['keep'],payments:['keep'],settlements:[]};const before=structuredClone(state);
 t.mock.method(globalThis,'fetch',async(u,o={})=>{
  const x=new URL(u),method=o.method||'GET';calls.push([x.pathname,method]);
  if(x.origin===url&&x.pathname==='/auth/v1/user'){assert.equal(method,'GET');return Response.json({id:'staff-id'});}
  if(x.origin===url&&x.pathname==='/rest/v1/rpc/ops_staff_access'){assert.ok(['GET','POST'].includes(method));return Response.json(access());} // Existing read-only STABLE permission function.
  assert.equal(method,'GET');assert.equal(o.body,undefined);
  if(x.origin===url&&x.pathname==='/rest/v1/ops_bookings')return Response.json([]);
  if(x.origin==='https://beds24.com'&&x.pathname==='/api/v2/bookings')return Response.json({data:x.searchParams.get('roomId')==='724919'?[raw]:[],pages:{nextPageExists:false}});
  assert.fail('Write, sync or unexpected service path invoked');
 });
 const res=response();await createLocalPreviewHandler()(req(),res);assert.equal(res.code,200);assert.equal(res.body.total_records,1);assert.equal(res.body.candidates[0].nights,3);assert.equal(res.body.candidates[0].opening_period_eligible,true);
 assert.equal(res.body.application_writes,0);assert.equal(res.body.normal_sync_changed,false);assert.deepEqual(state,before);
 assert.equal(calls.filter(([p])=>p==='/api/v2/bookings').length,3);
 assert.ok(calls.every(([p])=>!/(apply|stage_historical|settlement|expense|payment|sync_run|sync_member|record_session)/.test(p)));
 assert.doesNotMatch(JSON.stringify(res.body),/92783243|PrivateGuest|PrivateSurname|private@example|27821234567|opaque-test-token|read-only-test-secret/);
});
test('read guards reject write/import/settlement/normal-sync requests before fetch',async t=>{
 let called=0;t.mock.method(globalThis,'fetch',async()=>{called++;throw Error('No calls allowed');});
 for(const path of ['rpc/ops_apply_historical_batch','rpc/ops_stage_historical_batch','ops_sync_runs','ops_payment_records','ops_stay_expenses','ops_historical_opening_positions'])assert.throws(()=>readOnlyPreviewRequest(path,'token'));
 for(const method of ['POST','PATCH','DELETE','PUT'])assert.throws(()=>readOnlyPreviewRequest('ops_bookings?select=*','token',{method}));
 assert.throws(()=>readOnlyPreviewRequest('ops_bookings?select=*','token',{service:true}));
 await assert.rejects(readOnlyBeds24('https://beds24.com/api/v2/bookings',{method:'POST',redirect:'error'}));assert.equal(called,0);
});
test('mask every report section, project safe fields and exclude exceptions from settlement',()=>{
 const base={booking_id:92783243,property:'legacy-suiderstrand',arrival:'2026-09-20',departure:'2026-09-23',raw_status:'confirmed',channel:'Airbnb',storage:'missing_locally',classification:'guest_candidate',email:'private@example.org',token:'secret-token',guest_name:'PrivateGuest'};
 const p={report:{records:[base,{...base,booking_id:92783244,classification:'request',raw_status:'request'},{...base,booking_id:92783245,classification:'cancelled',raw_status:'cancelled'},{...base,booking_id:92783246,classification:'block',raw_status:'black'},{...base,booking_id:92783247,classification:'non_guest'},{...base,booking_id:92783248,storage:'already_stored',changed_fields:['guest_name','source_price','secret-token']}],exceptions:[{...base,booking_id:92783249,classification:'unusual_status',raw_status:'PrivateGuest private@example.org',channel:'secret-token'}],duplicates:[{...base,condition:'conflicting_duplicate'}],localConflicts:[base],localOnly:[base]}};
 const out=browserPreviewReport(p),text=JSON.stringify(out);assert.doesNotMatch(text,/9278324[3-9]|private@example|PrivateGuest|secret-token/);assert.match(out.candidates[0].booking_id,/^\*{6}243-[a-f0-9]{8}$/);assert.equal(out.candidates[0].opening_period_eligible,false);assert.equal(out.exceptional.requests_inquiries.length,1);assert.equal(out.exceptional.blocks.length,1);assert.equal(out.exceptional.non_guest.length,1);assert.equal(out.exceptional.cancelled.length,1);assert.equal(out.exceptional.unusual_status.length,1);assert.deepEqual(out.differences[0].changed_fields,['guest_name','source_price']);assert.notEqual(maskBookingId(92783243),maskBookingId(91783243));
});
test('concurrent preview requests do not run twice',async t=>{
 mockAuth(t);let release,started;const begun=new Promise(r=>started=r);const wait=new Promise(r=>release=r);let calls=0;
 const h=createLocalPreviewHandler({preview:async()=>{calls++;started();await wait;return {report:{}};}});const a=response(),b=response();const first=h(req(),a);await begun;await h(req(),b);assert.equal(b.code,409);release();await first;assert.equal(a.code,200);assert.equal(calls,1);
});
test('UI does not auto-run or silently retry on repeated clicks or failure',async()=>{
 const nodes=new Map();function el(){return{disabled:true,textContent:'',append(){},replaceChildren(){},addEventListener(event,fn){this[event]=fn;}};}
 const document={getElementById(id){if(!nodes.has(id))nodes.set(id,el());return nodes.get(id);},createElement:el};let calls=0,release;const pending=new Promise(r=>release=r);
 vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-preview.js',import.meta.url),'utf8'),{document,fetch:async()=>{calls++;await pending;throw Error('failed');}});
 assert.equal(calls,0);const button=nodes.get('run-preview');const first=button.click();await button.click();assert.equal(calls,1);release();await first;await button.click();assert.equal(calls,1);assert.equal(button.disabled,true);assert.match(nodes.get('status').textContent,/No automatic retry/);
});
test('local-only page is protected and exposes no write controls',async t=>{
 mockAuth(t);const request=Object.assign(new EventEmitter(),req({url:'/staff-september-preview.html',method:'GET'}));const res={...response(),writeHead(n){this.code=n;},end(body){this.content=body;}};await staffLocalHandler(request,res);assert.match(res.content.toString(),/SEPTEMBER HISTORICAL PREVIEW/);assert.match(res.content.toString(),/READ ONLY — NOTHING WILL BE IMPORTED/);assert.equal((res.content.toString().match(/<button/g)||[]).length,1);
 const runner=fs.readFileSync(new URL('../scripts/staff-staging-server.mjs',import.meta.url),'utf8');assert.match(runner,/local\/september-preview/);
 assert.equal(fs.existsSync(new URL('../public/staff-september-preview.html',import.meta.url)),false);assert.equal(fs.existsSync(new URL('../api/september-preview.js',import.meta.url)),false);
});

test('local page rejects missing cookies and Finance sessions',async t=>{
 mockAuth(t,access({role:'finance'}));
 for(const cookie of ['', '__Host-bste_staff=opaque-test-token']){
  const request=Object.assign(new EventEmitter(),req({url:'/staff-september-preview.html',method:'GET',headers:{...req().headers,cookie}}));
  const res={...response(),writeHead(n){this.code=n;},end(body){this.content=body;}};await staffLocalHandler(request,res);assert.equal(res.code,403);assert.doesNotMatch(String(res.content),/Run September Preview/);
 }
});
test('local router dispatches the preview endpoint and rejects GET without running preview',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('No network expected');});
 const request=Object.assign(new EventEmitter(),req({url:'/local/september-preview',method:'GET'}));let finish;const done=new Promise(r=>finish=r);
 const res={...response(),writeHead(n){this.code=n;},end(body){this.content=body;finish();}};
 await staffLocalHandler(request,res);request.emit('end');await done;assert.equal(res.statusCode,405);assert.equal(calls,0);
});
