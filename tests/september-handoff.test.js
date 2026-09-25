import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createLocalPreviewHandler} from '../scripts/local-september-preview.mjs';
import {createLocalImportHandler,runControlledImport} from '../scripts/local-september-import.mjs';
import {collectHistorical,makeHistoricalPreview,applyApprovedHistorical} from '../lib/beds24-historical-backfill.js';
import {rememberImportPreview,getImportSelection,canonicalApprovedChannel,selectApproved} from '../scripts/september-import-selection.mjs';
Object.assign(process.env,{BSTE_STAFF_ENV:'staging',BSTE_OPERATIONS_ENABLED:'true',BSTE_OPERATIONS_STAGING_PROJECT_REF:'abcdefghijklmnopqrst',BSTE_STAFF_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',BSTE_STAFF_SUPABASE_PUBLIC_KEY:'test-public',BSTE_BEDS24_ACCOUNT_KEY:'handoff-test',BSTE_STAFF_ORIGIN:'https://localhost:3443',BEDS24_LONG_LIFE_TOKEN:'mock-provider-secret'});delete process.env.VERCEL;delete process.env.VERCEL_ENV;
const rows=[{id:99900111,propertyId:351452,roomId:724919,arrival:'2026-09-05',departure:'2026-09-13',channel:'Airbnb'}, {id:99900222,propertyId:352005,roomId:726060,arrival:'2026-09-08',departure:'2026-09-11',channel:'Airbnb'}, {id:99900333,propertyId:352276,roomId:726696,arrival:'2026-09-06',departure:'2026-09-13',channel:'Booking.com'}];
async function fixture(mutate=()=>{}){
 const data=structuredClone(rows).map(r=>({...r,status:'confirmed',firstName:'GuestPrivate',email:'private@example.org'}));mutate(data);
 const d=await collectHistorical({token:'mock',account:'handoff-test',fetcher:async(u)=>Response.json({data:data.filter(r=>r.roomId===Number(new URL(u).searchParams.get('roomId'))),pages:{nextPageExists:false}})});return makeHistoricalPreview(d,[],'handoff-test');
}
const req=(body,token='mock-session-a')=>({method:'POST',body,headers:{host:'localhost:3443',origin:'https://localhost:3443','content-type':'application/json',cookie:'__Host-bste_staff='+token},socket:{encrypted:true,remoteAddress:'127.0.0.1'}});
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
function auth(t,user,overrides={}){t.mock.method(globalThis,'fetch',async u=>{
 const path=new URL(u).pathname;if(path==='/auth/v1/user')return Response.json({id:user});
 assert.equal(path,'/rest/v1/rpc/ops_staff_access','No live or data/write requests allowed');
 return Response.json({active:true,user_id:user,role:'administrator',mfa_required:true,mfa_satisfied:true,permissions:['sync.run','finance.read','finance.write','finance.cutover'],...overrides});
});}
function safe(body){assert.doesNotMatch(JSON.stringify(body),/99900111|99900222|99900333|GuestPrivate|private@example|mock-session|mock-provider-secret/);}
for(const [name,mutate,code] of [
 ['valid same-session handoff',()=>{},null],
 ['verified Beds24 aliases',r=>{r[0].channel='airbnb';r[1].channel='airbnb';r[2].channel='booking';},null],
 ['trailing channel whitespace',r=>r[0].channel+=' ','CHANNEL_MISMATCH'],
 ['request',r=>r[0].status='request','CANDIDATE_STATUS_REJECTED'],
 ['inquiry',r=>r[0].status='inquiry','CANDIDATE_STATUS_REJECTED'],
 ['duplicate',r=>r.push({...r[0]}),'PREVIEW_CONFLICT'],
 ['conflicting duplicate',r=>r.push({...r[0],price:99}),'PREVIEW_CONFLICT']
])test('end-to-end preview -> stored outcome -> import show: '+name,async t=>{
 auth(t,name);const p=await fixture(mutate);const preview=res();await createLocalPreviewHandler({preview:async()=>p})(req({}),preview);
 assert.equal(preview.code,200);assert.equal(preview.body.import_ready,code===null);assert.equal(preview.body.reason_code,code||undefined);safe(preview.body);
 const show=res();await createLocalImportHandler({run:async()=>assert.fail('Import forbidden')})(req({action:'show'}),show);
 if(code){assert.equal(show.code,409);assert.equal(show.body.code,code);assert.match(show.body.error,/Candidate selection rejected/);}else{assert.equal(show.code,200);assert.equal(show.body.candidates.length,3);}safe(show.body);
});
test('end-to-end expired selection has a distinct code and no usable payload',async t=>{
 const start=Date.now();auth(t,'expiry-user');const p=await fixture();const preview=res();await createLocalPreviewHandler({preview:async()=>p})(req({}),preview);assert.equal(preview.body.import_ready,true);
 t.mock.method(Date,'now',()=>start+26*60000);const show=res();await createLocalImportHandler()(req({action:'show'}),show);assert.equal(show.body.code,'SELECTION_EXPIRED');assert.equal(show.code,409);safe(show.body);
});
test('end-to-end new session rejected while original session still resolves',async t=>{
 auth(t,'session-user');const p=await fixture();const preview=res();await createLocalPreviewHandler({preview:async()=>p})(req({}),preview);
 const changed=res();await createLocalImportHandler()(req({action:'show'},'mock-session-b'),changed);assert.equal(changed.body.code,'SESSION_CHANGED');safe(changed.body);
 const original=res();await createLocalImportHandler()(req({action:'show'}),original);assert.equal(original.code,200);
});
test('no selection differs from permission failure and authentication outage',async t=>{
 auth(t,'no-selection-user');const empty=res();await createLocalImportHandler()(req({action:'show'}),empty);assert.equal(empty.body.code,'NO_SELECTION');
 t.mock.restoreAll();auth(t,'no-selection-user',{mfa_satisfied:false});const denied=res();await createLocalImportHandler()(req({action:'show'}),denied);assert.equal(denied.body.code,'PERMISSION_DENIED');assert.equal(denied.code,403);
 t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>{throw Error('private-upstream-secret');});const unavailable=res();await createLocalImportHandler()(req({action:'show'}),unavailable);assert.equal(unavailable.body.code,'AUTHENTICATION_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(unavailable.body),/private-upstream/);
});
test('rejected replacement remains blocked and contains only safe rejection diagnostics',async()=>{
 const p=await fixture();rememberImportPreview('replacement-user','synthetic',p);assert.ok(getImportSelection('replacement-user','synthetic').preview);
 p.entries[0].item.snapshot.source_channel='private@example.org SECRET';const result=rememberImportPreview('replacement-user','synthetic',p);assert.deepEqual(result.import_ready,false);assert.equal(result.reason_code,'CHANNEL_MISMATCH');safe(result);
 assert.throws(()=>getImportSelection('replacement-user','synthetic'),e=>e.code==='CHANNEL_MISMATCH');
});
test('import UI displays approved safe codes without echoing provider errors',async()=>{
 const nodes=new Map();const element=()=>({disabled:true,addEventListener(){},append(){}});const document={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element};
 vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-import.js',import.meta.url),'utf8'),{document,fetch:async()=>({ok:false,json:async()=>({code:'CHANNEL_MISMATCH',error:'secret-upstream'})})});
 await new Promise(r=>setImmediate(r));assert.match(nodes.get('status').textContent,/CHANNEL_MISMATCH/);assert.doesNotMatch(nodes.get('status').textContent,/secret-upstream/);assert.equal(nodes.get('import').disabled,true);
});
test('preview UI explicitly distinguishes complete preview from ready import handoff',async()=>{
 for(const ready of [true,false]){
  const nodes=new Map();const element=()=>({disabled:true,append(){},replaceChildren(){},addEventListener(name,fn){this[name]=fn;}});const document={getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},createElement:element};
  const data={import_ready:ready,reason_code:'CHANNEL_MISMATCH',reason:'Candidate selection rejected: exact channel mismatch.',by_property:[],candidates:[],differences:[],exceptional:Object.fromEntries(['cancelled','requests_inquiries','blocks','non_guest','unusual_status','conflicts_duplicates','stored_not_returned'].map(k=>[k,[]]))};
  vm.runInNewContext(fs.readFileSync(new URL('../scripts/staff-september-preview.js',import.meta.url),'utf8'),{document,fetch:async()=>({ok:true,json:async()=>data})});
  await nodes.get('run-preview').click();assert.match(nodes.get('status').textContent,/Preview complete/);assert.ok(nodes.get('status').textContent.includes('Import handoff ready: '+(ready?'YES':'NO')));if(!ready)assert.match(nodes.get('status').textContent,/CHANNEL_MISMATCH/);
 }
});

test('canonical approved channels: explicit aliases only; case allowed, whitespace rejected',()=>{
 for(const [raw,expected] of [['airbnb','airbnb'],['Airbnb','airbnb'],['AIRBNB','airbnb'],['booking','booking.com'],['Booking','booking.com'],['booking.com','booking.com'],['BOOKING.COM','booking.com']])assert.equal(canonicalApprovedChannel(raw),expected);
 for(const raw of ['other','expedia','arbitrary free text','booking.com.evil','airbnb.com',' booking','booking ','airbnb\n','booking\t','',null,42,{}])assert.equal(canonicalApprovedChannel(raw),null);
});
test('unknown channels still fail closed as CHANNEL_MISMATCH',async()=>{
 for(const raw of ['other','expedia','arbitrary free text']){
  const p=await fixture(r=>r[2].channel=raw);assert.throws(()=>selectApproved(p),e=>e.code==='CHANNEL_MISMATCH');
 }
});
test('alias comparison preserves raw channel throughout preview, stored selection and import payload',async()=>{
 const p=await fixture(r=>{r[0].channel='airbnb';r[1].channel='airbnb';r[2].channel='booking';});const original=structuredClone(p);
 assert.equal(rememberImportPreview('alias-preservation','synthetic-credential',p).import_ready,true);
 const saved=getImportSelection('alias-preservation','synthetic-credential');assert.equal(saved.preview.entries[2].item.snapshot.source_channel,'booking');assert.equal(saved.preview.entries[2].item.raw.channel,'booking');assert.equal(saved.preview.report.records[2].channel,'booking');
 const calls=[];await applyApprovedHistorical(saved.preview,{digest:p.digest,confirmed_by_bond:true,reason:'Mock alias validation only',import_ids:saved.ids,settle_ids:[]},{staffToken:'synthetic',request:async(path,token,options)=>{
  calls.push(path);if(path==='rpc/ops_stage_historical_batch'){
   const item=options.body.approved_items[2];assert.equal(item.snapshot.source_channel,'booking');assert.equal(item.raw.channel,'booking');assert.equal(item.settle,false);return 'synthetic-batch';
  }assert.equal(path,'rpc/ops_apply_historical_batch');return {booking_count:3};
 }});assert.equal(calls.length,2);assert.deepEqual(p,original);
});
test('alias does not relax property/date/status or session-bound booking identity checks',async()=>{
 for(const mutate of [p=>p.entries[2].item.snapshot.property_slug='legacy-suiderstrand',p=>p.entries[2].item.snapshot.arrival='2026-09-07',p=>p.entries[2].item.snapshot.departure='2026-09-14',p=>p.entries[2].item.snapshot.source_status='request']){
  const p=await fixture(r=>r[2].channel='booking');mutate(p);assert.throws(()=>selectApproved(p));
 }
 const p=await fixture(r=>r[2].channel='booking');rememberImportPreview('alias-identity','synthetic',p);const saved=getImportSelection('alias-identity','synthetic');saved.preview.entries[2].item.snapshot.beds24_booking_id+=1;
 await assert.rejects(runControlledImport(saved,'synthetic',{request:async()=>assert.fail('Identity substitution must fail before storage access')}),/Preview identities changed/);
 assert.throws(()=>getImportSelection('alias-identity','different-session'),e=>e.code==='SESSION_CHANGED');
});
