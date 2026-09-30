import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eligibility,readinessView,visibleStay,contactReadiness,normalizeInternalReply,validCleaningTimestamp,effectiveStatus} from '../lib/stay-readiness.js';
import {createReadinessHandler} from '../api/staff-readiness.js';
import {createInternalReplyAdapter} from '../lib/readiness-inbound.js';
const id='10000000-0000-4000-8000-000000000001',cp='20000000-0000-4000-8000-000000000001';
const booking={id,arrival:'2030-10-04',departure:'2030-10-08',source_status:'confirmed',source_channel:'airbnb',source_kind:'beds24'};
const checkpoint={id:cp,checkpoint_key:'pre_arrival',label:'Pre-arrival',status:'complete',revision:1,due_at:'2030-10-01T06:00:00Z',items:[]};
const cleaning={state:'assigned',cleaner_name:'Synthetic',expected_cleaning_at:'2030-10-08T14:00:00Z'};
const now=new Date('2030-10-02T08:00:00Z');
for(const raw of ['new','confirmed','request','blocked','black','cancelled','other'])for(const override of [null,'confirmed','review_required'])test(`eligibility parity contract ${raw}/${override}`,()=>{const b={...booking,source_status:raw,operational_status:override};const expected=!['blocked','black','cancelled'].includes(raw)&&override!=='review_required'&&(['new','confirmed'].includes(raw)||override==='confirmed');assert.equal(eligibility(b).eligible,expected);assert.equal(readinessView(b,[checkpoint],cleaning,now).ready,expected);});
test('database eligibility denial always vetoes presentation READY',()=>assert.equal(readinessView({...booking,readiness_eligible:false},[checkpoint],cleaning,now).ready,false));
test('unresolved NO remains prominent during a deferral, without being overdue',()=>{const c={...checkpoint,status:'deferred',issue_open:true,deferred_until:'2030-10-03T06:00:00Z'};const v=readinessView(booking,[c],cleaning,now);assert.equal(v.checkpoints[0].effective_status,'deferred');assert.ok(v.attention.some(a=>a.includes('issue flagged')));assert.ok(!v.attention.some(a=>a.includes('overdue')));assert.equal(v.ready,false);});
test('first and repeated schedule review remain visible until explicit cleared state',()=>{for(const c of [{...checkpoint,status:'needs_attention',issue_open:true,schedule_review:true},{...checkpoint,status:'needs_attention',issue_open:true,schedule_review:true,revision:3}]){assert.equal(readinessView(booking,[c],cleaning,now).ready,false);}assert.equal(readinessView(booking,[{...checkpoint,issue_open:false,schedule_review:false}],cleaning,now).ready,true);});
test('post-departure deferred work stays visible and is not overdue early',()=>{const b={...booking,arrival:'2030-09-01',departure:'2030-09-04'},c={...checkpoint,checkpoint_key:'post_clean',status:'deferred',deferred_until:'2030-10-03T06:00:00Z'};const v=readinessView(b,[c],cleaning,now);assert.equal(v.outstanding,true);assert.equal(visibleStay(b,v,'2030-10-02','2030-10-02'),true);assert.equal(v.checkpoints[0].effective_status,'deferred');});
for(const c of [{status:'needs_attention'},{status:'complete',schedule_review:true},{status:'pending',checkpoint_key:'post_clean',due_at:'2030-11-01T06:00:00Z'}])test('old outstanding stay retained: '+JSON.stringify(c),()=>{const b={...booking,arrival:'2030-09-01',departure:'2030-09-04'},v=readinessView(b,[{...checkpoint,...c}],cleaning,now);assert.equal(visibleStay(b,v,'2030-10-02','2030-10-02'),true);});
test('resolved old stay can age out normally',()=>{const b={...booking,arrival:'2030-09-01',departure:'2030-09-04'};assert.equal(visibleStay(b,readinessView(b,[checkpoint],cleaning,now),'2030-10-02','2030-10-02'),false);});
test('due instant and overdue are distinct',()=>{const c={...checkpoint,status:'pending'};assert.equal(effectiveStatus(c,new Date(c.due_at)),'due');assert.equal(effectiveStatus(c,new Date(Date.parse(c.due_at)+1000)),'overdue');});
for(const invalid of ['constructor','__proto__','prototype','toString','other'])test('own-key allowlists reject '+invalid,()=>{assert.equal(contactReadiness({...booking,source_channel:invalid}).unreachable,true);assert.throws(()=>normalizeInternalReply({environment:'staging',provider:'fixture',verified_sender:true,authorized_staff_id:id,message_id:'unique',checkpoint_reference:cp,correlation_id:'exact',text:invalid}));});
for(const value of ['2030-10-08T16:00:00+02:00','2030-10-08T14:00:00Z'])test('finite zoned cleaning accepted '+value,()=>assert.equal(validCleaningTimestamp(value),true));
for(const value of ['2030-10-08T16:00:00','infinity','-infinity','2030-02-30T16:00:00+02:00','bad'])test('invalid cleaning rejected '+value,()=>assert.equal(validCleaningTimestamp(value),false));
test('not-required is distinct from unassigned; arrangement review blocks READY',()=>{assert.equal(readinessView(booking,[checkpoint],{state:'not_required'},now).ready,true);assert.equal(readinessView(booking,[checkpoint],{state:'unassigned'},now).ready,false);assert.equal(readinessView(booking,[checkpoint],{...cleaning,schedule_review:true},now).ready,false);});
function response(){return {setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};}
function request(body){return {method:'POST',headers:{'content-type':'application/json'},body};}
// Stateful SQL-contract mock: request-ID history is retained separately from active context.
function storage(){const prompts=new Map(),history=new Map(),calls=[];return {calls,prompts,history,request:async(path,token,{body})=>{
 calls.push({path,body});if(!path.endsWith('prompt'))return {saved:true};
 for(const [revision,previous] of prompts)if(revision!==body.expected_revision){previous.superseded=true;prompts.delete(revision);}
 let p=history.get(body.request_id);
 if(!body.replace_prompt||!p){p=prompts.get(body.expected_revision);if(body.replace_prompt){assert.equal(p.prompt_id,body.replace_prompt);p.superseded=true;p=null;}
 if(!p){p={prompt_id:body.request_id,token_hashes:body.token_hashes,checkpoint:{...checkpoint,revision:body.expected_revision},expires_at:'2090-01-01T00:00:00Z',superseded:false};prompts.set(body.expected_revision,p);history.set(p.prompt_id,p);}}
 return {...p};
}};}

function handler(db){return createReadinessHandler({configure:()=>({ref:'fixture',account:'fixture'}),origin(){},authorize:async()=>({token:'synthetic-session-token'}),request:db.request});}
async function run(h,b){const out=response();await h(request(b),out);return out;}
test('repeated preview uses identical random capabilities and stable request identity',async()=>{const db=storage(),h=handler(db),b={action:'preview',checkpoint_id:cp,revision:1};const first=await run(h,b),second=await run(h,b);assert.equal(first.code,200);assert.deepEqual(first.body.actions,second.body.actions);assert.equal(db.calls[0].body.request_id,db.calls[1].body.request_id);assert.equal(db.prompts.size,1);assert.equal(first.body.token_hashes,undefined);assert.ok(!JSON.stringify(first.body).includes('synthetic-session-token'));});
test('server cache loss does not mint another active set; replacement is explicit',async()=>{const db=storage(),first=await run(handler(db),{action:'preview',checkpoint_id:cp,revision:1});const h2=handler(db),second=await run(h2,{action:'preview',checkpoint_id:cp,revision:1});assert.equal(second.body.actions,null);assert.equal(second.body.replacement_required,true);assert.equal(second.body.prompt_id,first.body.prompt_id);const replacement=await run(h2,{action:'preview',checkpoint_id:cp,revision:1,replace_prompt_id:second.body.prompt_id});assert.notEqual(replacement.body.prompt_id,first.body.prompt_id);assert.ok(replacement.body.actions);});
test('new revision gets a distinct action set',async()=>{const db=storage(),h=handler(db);const a=await run(h,{action:'preview',checkpoint_id:cp,revision:1}),b=await run(h,{action:'preview',checkpoint_id:cp,revision:2});assert.notEqual(a.body.prompt_id,b.body.prompt_id);assert.notDeepEqual(a.body.actions,b.body.actions);});
test('wrong environment and non-zoned cleaner time denied before storage',async()=>{const db=storage(),h=handler(db);assert.equal((await run(h,{action:'read',environment:'production'})).code,403);assert.equal((await run(h,{action:'cleaner',booking_id:id,cleaning_state:'assigned',cleaner_name:'Synthetic',expected_cleaning_at:'2030-10-08T16:00:00'})).code,400);assert.equal(db.calls.length,0);});
test('cleaning exemption requires reason and does not silently include a cleaner',async()=>{const db=storage(),h=handler(db);assert.equal((await run(h,{action:'cleaner',booking_id:id,cleaning_state:'not_required',note:''})).code,400);assert.equal((await run(h,{action:'cleaner',booking_id:id,cleaning_state:'not_required',note:'Synthetic exemption',cleaner_name:'Someone'})).code,400);assert.equal((await run(h,{action:'cleaner',booking_id:id,cleaning_state:'not_required',note:'Synthetic exemption'})).code,200);assert.equal(db.calls.at(-1).body.cleaner,null);});
test('future adapter deduplicates atomically, rejects conflicts and wrong environment',async()=>{const seen=new Map();let applied=0;const adapter=createInternalReplyAdapter({environment:'staging',verifySender:async()=>({authorized:true,id}),correlate:async i=>({authorized:true,environment:i.environment,correlation_id:i.correlation_id,checkpoint_reference:i.checkpoint_reference}),processOnce:async(k,fn)=>{const key=JSON.stringify([k.environment,k.provider,k.message_id]);if(seen.has(key)){const prev=seen.get(key);if(prev.fingerprint!==k.fingerprint)throw new Error('Conflicting duplicate');return {replayed:true,result:await prev.promise};}const promise=Promise.resolve().then(fn);seen.set(key,{fingerprint:k.fingerprint,promise});return {replayed:false,result:await promise};},respond:async()=>{applied++;return {saved:true};}});const input={environment:'staging',provider:'fixture',message_id:'unique',checkpoint_reference:cp,correlation_id:'signed-correlation',text:'yes'};const results=await Promise.all([adapter(input),adapter(input)]);assert.equal(applied,1);assert.equal(results.filter(r=>r.replayed).length,1);await assert.rejects(adapter({...input,text:'no'}),/Conflicting duplicate/);await assert.rejects(adapter({...input,environment:'production'}),/Environment/);});
test('future adapter cannot operate without atomic deduplication or authorized correlation',async()=>{assert.throws(()=>createInternalReplyAdapter({environment:'staging'}));const adapter=createInternalReplyAdapter({environment:'staging',verifySender:async()=>({authorized:false}),correlate:async()=>({}),processOnce(){throw new Error('Must not reach ledger');},respond(){throw new Error('Must not apply');}});await assert.rejects(adapter({environment:'staging'}),/authorization/);});
const sql=fs.readFileSync(new URL('../supabase/migrations/202609280001_operational_readiness.sql',import.meta.url),'utf8');
test('SQL replay branch contains no mutation/reconciliation and exposes current state',()=>{const branch=sql.slice(sql.indexOf('if a.consumed_at is not null then'),sql.indexOf('perform public.ops_readiness_reconcile(c.booking_id);',sql.indexOf('if a.consumed_at is not null then')));assert.match(branch,/ops_readiness_current/);assert.match(branch,/'replayed',true/);assert.doesNotMatch(branch,/\b(update|insert|delete)\b/i);});
test('SQL preserves sticky issue/review and unique active prompt identity',()=>{assert.match(sql,/schedule_review=c.schedule_review or/);assert.match(sql,/when 'yes' then false when 'no' then true else issue_open/);assert.match(sql,/ops_readiness_one_active_prompt/);assert.match(sql,/unique\(prompt_id,action\)/);assert.match(sql,/or public.ops_readiness_outstanding\(b.id\)/);assert.match(sql,/coalesce\(o.operational_status,''\)<>'review_required'/);});

test('rollback suite covers canonical RPC signatures and expanded security/cleanup contract',()=>{
 const sql=fs.readFileSync(new URL('./stay-readiness-rls.sql',import.meta.url),'utf8');
 for(const marker of ['expected','nonstaff','other_session','Repeated issuance','Unused actions','ZERO readiness/audit mutation','Second reschedule','Old explicit cleaning time','seven days','No synthetic sessions','No synthetic staff','has_table_privilege','ops_readiness_prompts','ops_readiness_templates']) assert.ok(sql.includes(marker),marker);
 assert.match(sql,/public\.ops_readiness_respond\(digest,note,current_setting/);
 assert.match(sql,/public\.ops_readiness_prompt\(current_setting[\s\S]*?rev,gen_random_uuid\(\),hashes/);
 assert.ok(!sql.includes('ops_readiness_prompt(current_setting(\'test.ops1.checkpoint\')::uuid,hashes)'));
});

test('preview A -> replace B -> ordinary preview resolves B, not A or C; replacement retry is idempotent',async()=>{
 const db=storage(),h=handler(db),body={action:'preview',checkpoint_id:cp,revision:1};
 const a=await run(h,body),b=await run(h,{...body,replace_prompt_id:a.body.prompt_id});
 assert.equal(db.history.get(a.body.prompt_id).superseded,true);
 const ordinary=await run(h,body);assert.equal(ordinary.body.prompt_id,b.body.prompt_id);assert.deepEqual(ordinary.body.actions,b.body.actions);assert.equal(ordinary.body.replacement_required,false);
 const retry=await run(h,{...body,replace_prompt_id:a.body.prompt_id});assert.equal(retry.body.prompt_id,b.body.prompt_id);assert.deepEqual(retry.body.actions,b.body.actions);
 assert.equal(db.history.size,2);assert.equal(db.prompts.size,1);assert.ok(db.calls.every(c=>c.path.endsWith('ops_readiness_prompt')));
});
test('revision change supersedes the old generation and repeated preview resolves new revision',async()=>{
 const db=storage(),h=handler(db),body={action:'preview',checkpoint_id:cp,revision:1};const a=await run(h,body),b=await run(h,{...body,revision:2}),again=await run(h,{...body,revision:2});
 assert.equal(db.history.get(a.body.prompt_id).superseded,true);assert.equal(again.body.prompt_id,b.body.prompt_id);assert.equal(db.history.size,2);assert.equal(db.prompts.size,1);
});
test('SQL ordinary lookup is independent of existing historical request identity',()=>{
 const lookup=sql.slice(sql.indexOf('select * into p from public.ops_readiness_prompts where id=request_id;'),sql.indexOf("return public.ops_readiness_current(c.id)||jsonb_build_object('prompt_id'"));
 assert.match(lookup,/if replace_prompt is null or p.id is null then/);assert.match(lookup,/environment=target_environment and superseded_at is null/);
});
test('SQL historical skip is explicit, SAST gated, and cannot suppress genuine unresolved/completed states',()=>{
 assert.match(sql,/historical_skip boolean not null default false/);
 assert.match(sql,/elsif c.status='not_applicable'[\s\S]*?not c.historical_skip or c.issue_open or \(due_time at time zone 'Africa\/Johannesburg'\)::date >=/);
 assert.match(sql,/historical_skip=c.historical_skip and next_status='not_applicable'/);
 const suite=fs.readFileSync(new URL('./stay-readiness-rls.sql',import.meta.url),'utf8');
 for(const label of ['Historical September enrollment skipped','Past September correction remains skipped','Future/current window becomes actionable','Unresolved past work remains unresolved','Completed historical response remains complete','Cancelled historical stay cannot reactivate','Ordinary preview resolves B not A','Replacement retry reuses B'])assert.ok(suite.includes(label),label);
});
