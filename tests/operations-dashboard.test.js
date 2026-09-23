import test from 'node:test';
import assert from 'node:assert/strict';
import { PROPERTIES, presentDashboard, sastDate } from '../lib/operations-model.js';
import { collectBookings, mapBooking, ImportError } from '../lib/beds24-operations-import.js';
import { createOperationsHandler } from '../api/staff-operations.js';
import { refreshBookings } from '../lib/operations-service.js';
import { operationsConfig, operationsRequest } from '../lib/operations-store.js';
import { StaffAuthError } from '../lib/staff-auth.js';
const now = new Date('2030-01-10T22:30:00Z');
const ref='abcdefghijklmnopqrst';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:ref,
 BSTE_STAFF_SUPABASE_URL:`https://${ref}.supabase.co`,BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'bste-test',
 BSTE_STAFF_ORIGIN:'https://localhost:3443',BSTE_BEDS24_IMPORT_ENABLED:'true',BEDS24_LONG_LIFE_TOKEN:'test-read-only',BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test'});
function raw(p=PROPERTIES[0],id=1,status='new'){return {id,roomId:p.roomId,propertyId:p.propertyId,status,arrival:'2030-01-10',departure:'2030-01-14',
 firstName:'Test',lastName:'Guest',numAdult:2,numChild:0,channel:'Airbnb',price:'1234.50',deposit:617.25,invoiceItems:[]};}
const page=(rows,next=false)=>new Response(JSON.stringify({data:rows,pages:{nextPageExists:next}}));
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
const post=(body)=>({method:'POST',headers:{origin:'https://localhost:3443','content-type':'application/json'},body});
test('SAST calendar date and in-house/upcoming/departure grouping',()=>{
 assert.equal(sastDate(now),'2030-01-11');
 const rows=[{...mapBooking(raw(),PROPERTIES[0],now.toISOString(),'bste-test').snapshot,id:'a'},
 {...mapBooking(raw(PROPERTIES[1],2),PROPERTIES[1],now.toISOString(),'bste-test').snapshot,id:'b',arrival:'2030-01-12'},
 {...mapBooking(raw(PROPERTIES[2],3),PROPERTIES[2],now.toISOString(),'bste-test').snapshot,id:'c',departure:'2030-01-11'}];
 const view=presentDashboard(rows,[],now);assert.deepEqual(view.properties.map(p=>p.count),[1,1,1]);
 assert.deepEqual(new Set(view.bookings.map(b=>b.group)),new Set(['in_house','upcoming','departing_today']));
});
test('pagination includes all properties/statuses and never writes or refreshes a Beds24 token',async()=>{
 const calls=[];const responses=[page([raw(PROPERTIES[0],1,'new')],true),page([raw(PROPERTIES[0],2,'request')]),page([raw(PROPERTIES[1],3,'confirmed')]),page([])];
 const batch=await collectBookings({token:'test-read-only',account:'bste-test',now,fetcher:async(url,opts)=>{calls.push({url,opts});return responses.shift();}});
 assert.equal(batch.items.length,3);assert.deepEqual(Object.values(batch.counts),[2,1,0]);
 assert.deepEqual(batch.items.map(i=>i.snapshot.source_status),['new','request','confirmed']);
 for(const c of calls){assert.equal(c.opts.method,'GET');assert.equal(new URL(c.url).pathname,'/api/v2/bookings');assert.equal(c.opts.redirect,'error');assert.equal(c.opts.headers.token,'test-read-only');
  assert.equal(new URL(c.url).searchParams.get('departureFrom'),'2030-01-10');}
 assert.equal(new URL(calls[1].url).searchParams.get('page'),'2');
});
test('identical duplicate source rows are deduplicated; conflicting duplicate rows fail',async()=>{
 let responses=[page([raw(),raw()]),page([]),page([])];
 let batch=await collectBookings({token:'x',account:'bste-test',now,fetcher:async()=>responses.shift()});assert.equal(batch.items.length,1);
 responses=[page([raw(),{...raw(),price:999}])];
 await assert.rejects(collectBookings({token:'x',account:'bste-test',now,fetcher:async()=>responses.shift()}),{code:'conflicting_duplicate_booking'});
});
test('source fields/financial payload preserved but deposit never sets manual payment status',()=>{
 const source=raw(PROPERTIES[0],7,'request');source.currency=undefined;
 const item=mapBooking(source,PROPERTIES[0],now.toISOString(),'bste-test');
 assert.deepEqual(item.raw,source);assert.equal(item.financial.source_deposit,617.25);assert.equal(item.financial.source_currency,null);
 assert.equal(item.snapshot.payment_status,undefined);assert.equal(item.snapshot.source_deposit,undefined);
 const row={...item.snapshot,operational_status:'confirmed',payment_visible:true,payment_status:'deposit_paid'};
 const view=presentDashboard([row],[],now);assert.equal(view.bookings[0].source_status,'request');
 assert.equal(view.bookings[0].operational_status,'confirmed');assert.equal(view.bookings[0].payment_status,'deposit_paid');
});
test('missing pagination metadata and unmapped rooms fail closed',async()=>{
 await assert.rejects(collectBookings({token:'x',account:'bste-test',now,fetcher:async()=>new Response(JSON.stringify({data:[]}))}),{code:'invalid_beds24_response'});
 assert.throws(()=>mapBooking({...raw(),roomId:999},PROPERTIES[0],now.toISOString(),'bste-test'),{code:'unmapped_source_booking'});
});
test('failed source page records failed attempt and never applies a partial snapshot',async()=>{
 const paths=[];
 await assert.rejects(refreshBookings('staff',{request:async(path)=>{paths.push(path);return 'run-1';},collect:async()=>{throw new ImportError('beds24_read_failed');}}),{status:503});
 assert.deepEqual(paths,['rpc/ops_begin_sync','rpc/ops_fail_sync']);
 const view=presentDashboard([{...mapBooking(raw(),PROPERTIES[0],now.toISOString(),'bste-test').snapshot}],
 [{status:'failed',error_code:'beds24_read_failed'},{status:'succeeded',completed_at:now.toISOString()}],now);
 assert.match(view.diagnostics.warning,/failed/);assert.equal(view.bookings.length,1);assert.ok(view.bookings[0].attention.includes('Source data needs refresh'));
});
test('storage stale rejection is reported as failure without clearing saved records',async()=>{
 const calls=[];
 await assert.rejects(refreshBookings('staff',{collect:async()=>({items:[],counts:{}}),request:async(path)=>{
  calls.push(path);if(path==='rpc/ops_apply_sync')throw new StaffAuthError(503,'Stale snapshot');return 'run-1';}}),{status:503});
 assert.deepEqual(calls,['rpc/ops_begin_sync','rpc/ops_apply_sync','rpc/ops_fail_sync']);
});
test('repeated refresh sends only source/financial/raw data to the existing idempotent RPC',async()=>{
 const body=[];const item=mapBooking(raw(),PROPERTIES[0],now.toISOString(),'bste-test');
 const request=async(path,token,opts)=>{if(path==='rpc/ops_apply_sync')body.push(opts.body);return path==='rpc/ops_begin_sync'?'run-id':1;};
 for(let i=0;i<2;i++)await refreshBookings('staff',{request,collect:async()=>({items:[item],counts:{}})});
 assert.deepEqual(body[0].items,body[1].items);
 assert.deepEqual(Object.keys(body[0].items[0]).sort(),['financial','raw','snapshot']);
 assert.doesNotMatch(JSON.stringify(body),/ops_notes|ops_tasks|ops_payment_records|ops_booking_overrides|ops_payment_arrangements/);
});
test('anonymous and privileged AAL1 denial occurs before dashboard access',async()=>{
 for(const status of [401,403]){let accessed=false;const handler=createOperationsHandler({authorize:async()=>{throw new StaffAuthError(status,'Denied');},load:async()=>{accessed=true;}});
 const res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.code,status);assert.equal(accessed,false);}
});
test('manual operational/payment review uses staff JWT and separate append-only tables',async()=>{
 const calls=[];const permissions=[];const handler=createOperationsHandler({authorize:async(req,p)=>{permissions.push(p);return{staff:{user_id:'staff-id'},token:'staff-token'};},
 request:async(path,token,opts)=>calls.push({path,token,opts})});
 for(const [action,status] of [['operational','confirmed'],['payment','deposit_paid']]){
  const res=response();await handler(post({action,status,reason:'Verified with Bond',booking_id:'10000000-0000-0000-0000-000000000001'}),res);assert.equal(res.code,200);}
 assert.deepEqual(permissions,['operations.write','finance.write']);assert.deepEqual(calls.map(c=>c.path),['ops_booking_overrides','ops_payment_records']);
 assert.ok(calls.every(c=>c.token==='staff-token'&&!c.opts.service));assert.equal(calls[1].opts.body.entry_kind,'review');
});
test('Operations cannot record payment and Finance cannot override operational status',async()=>{
 for(const [action,allowed] of [['payment','operations.write'],['operational','finance.write']]){
 let write=false;const handler=createOperationsHandler({authorize:async(req,p)=>{if(p!==allowed)throw new StaffAuthError(403,'Denied');},request:async()=>{write=true;}});
 const res=response();await handler(post({action}),res);assert.equal(res.code,403);assert.equal(write,false);}
});
test('cross-origin refresh denied before authorization',async()=>{
 let auth=false;const handler=createOperationsHandler({authorize:async()=>{auth=true;}});const req=post({action:'sync'});req.headers.origin='https://attacker.invalid';
 const res=response();await handler(req,res);assert.equal(res.code,403);assert.equal(auth,false);
});
test('wrong Supabase project and production environment fail before any fetch',()=>{
 const env={...process.env,BSTE_STAFF_SUPABASE_URL:'https://production.supabase.co'};assert.throws(()=>operationsConfig(env),{status:503});
 assert.throws(()=>operationsConfig({...process.env,VERCEL_ENV:'production'}),{status:503});
});
test('server storage errors never disclose service credentials or provider bodies',async()=>{
 await assert.rejects(operationsRequest('rpc/ops_apply_sync',null,{service:true,method:'POST',body:{},fetcher:async()=>new Response('secret data',{status:500})}),error=>error.status===503&&!error.message.includes('secret'));
});

test('raw new remains an active operational record without fabricating staff confirmation',()=>{
 const view=presentDashboard([mapBooking(raw(),PROPERTIES[0],now.toISOString(),'bste-test').snapshot],[],now);
 assert.equal(view.bookings[0].source_status,'new');assert.equal(view.bookings[0].operational_status,'active_from_source');
 assert.equal(view.bookings[0].operational_is_manual,false);
});

const requestWarning = 'Beds24 request: verify operational status';
function requestRow() {
 return mapBooking(raw(PROPERTIES[1],92783243,'request'),PROPERTIES[1],now.toISOString(),'bste-test').snapshot;
}
test('request without staff review retains operational warning',()=>{
 const row=requestRow();
 assert.ok(presentDashboard([row],[],now).bookings[0].attention.includes(requestWarning));
 assert.equal(row.source_status,'request');
});
test('resolved staff operational reviews clear only the request warning',()=>{
 for(const status of ['confirmed','checked_in','checked_out']) {
  const row={...requestRow(),operational_status:status};
  const booking=presentDashboard([row],[],now).bookings[0];
  assert.ok(!booking.attention.includes(requestWarning),status);
  assert.equal(booking.source_status,'request');
  assert.equal(row.source_status,'request');
 }
});
test('returning a reviewed request to unresolved restores its warning',()=>{
 const row={...requestRow(),operational_status:'confirmed'};
 assert.ok(!presentDashboard([row],[],now).bookings[0].attention.includes(requestWarning));
 for(const status of ['review_required',null,'']) {
  row.operational_status=status;
  assert.ok(presentDashboard([row],[],now).bookings[0].attention.includes(requestWarning));
 }
});
test('payment and missing/stale sync attention remain independent of operational review',()=>{
 const row={...requestRow(),operational_status:'confirmed',payment_visible:true,not_seen_in_latest_sync:true};
 const booking=presentDashboard([row],[],now).bookings[0];
 assert.ok(!booking.attention.includes(requestWarning));
 assert.ok(booking.attention.includes('Payment not reviewed'));
 assert.ok(booking.attention.includes('Source data needs refresh'));
 assert.ok(booking.attention.includes('Not returned in latest complete sync; do not assume cancelled'));
 row.payment_status='deposit_paid';
 assert.ok(!presentDashboard([row],[],now).bookings[0].attention.includes('Payment not reviewed'));
});
test('mocked repeated sync preserves confirmed review and keeps request warning cleared',async()=>{
 const staffReview={operational_status:'confirmed',payment_visible:true,payment_status:'deposit_paid'};
 let saved=requestRow();
 const request=async(path,token,opts)=>{
  if(path==='rpc/ops_begin_sync')return 'run-id';
  assert.equal(path,'rpc/ops_apply_sync');
  const snapshot=opts.body.items[0].snapshot;
  assert.equal(Object.hasOwn(snapshot,'operational_status'),false);
  assert.equal(Object.hasOwn(snapshot,'payment_status'),false);
  saved={...saved,...snapshot}; // Mock source storage; staff reviews are stored separately.
  return 1;
 };
 for(let i=0;i<2;i++) {
  const observedAt=new Date(now.getTime()+i*1000).toISOString();
  const item=mapBooking(raw(PROPERTIES[1],92783243,'request'),PROPERTIES[1],observedAt,'bste-test');
  await refreshBookings('staff',{request,collect:async()=>({items:[item],counts:{}})});
  const booking=presentDashboard([{...saved,...staffReview}],[{status:'succeeded',completed_at:observedAt}],now).bookings[0];
  assert.equal(booking.source_status,'request');
  assert.equal(booking.operational_status,'confirmed');
  assert.equal(booking.payment_status,'deposit_paid');
  assert.ok(!booking.attention.includes(requestWarning));
 }
});
