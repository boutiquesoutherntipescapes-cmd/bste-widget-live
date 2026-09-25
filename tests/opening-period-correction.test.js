import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const sql=fs.readFileSync(new URL('../supabase/migrations/202609240001_fix_opening_period_backfill.sql',import.meta.url),'utf8');
const body=name=>sql.split(`function public.${name}(`)[1].split('as $$')[1].split('$$;')[0];
test('corrective SQL preserves old evidence and checks openings before replay and commit',()=>{
 assert.match(sql,/begin;[\s\S]*commit;\s*$/);
 assert.match(sql,/create or replace function public.ops_apply_historical_batch/);
 assert.doesNotMatch(sql,/update public.ops_historical_(batches|results)|delete from public.ops_/i);
 const apply=body('ops_apply_historical_batch');
 assert.match(apply,/if result.batch_id is not null then\s+perform public.ops_assert_historical_openings/);
 assert.match(apply,/perform public.ops_assert_historical_openings\(batch.id\);\s+insert into public.ops_historical_results/);
 for(const counter of ['newly_created_opening_count','preserved_opening_count','settlement_count'])assert.ok(apply.includes(counter));
});
test('repair SQL write targets are exclusively opening records and audit events',()=>{
 const repair=body('ops_repair_september_openings');
 assert.deepEqual([...repair.matchAll(/insert into public\.(\w+)/g)].map(m=>m[1]),['ops_stay_opening_positions','ops_events']);
 assert.doesNotMatch(repair,/\b(update|delete)\s+public\.|ops_sync_booking|ops_finance_write|ops_apply_historical_batch/);
 for(const check of ['auth.uid()','aal2','finance.cutover','finance.write','sync.run','for update','batch.approved_items','source_account','beds24_booking_id','b.arrival','b.departure','owner_settled_cents','cleaner_settled_cents'])assert.ok(repair.includes(check),check);
 assert.match(sql,/grant execute on function public.ops_repair_september_openings\(uuid,text\) to authenticated/);
 assert.doesNotMatch(sql,/grant execute on function public.ops_repair_september_openings\(uuid,text\) to (service_role|anon|public)/);
});
test('real SQL regression fixture covers unpaid creation, repair, immutable evidence and rollback',()=>{
 const tests=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 for(const label of ['Fresh unpaid openings','Repair repeated rows','Repair altered protected','Historical opening state incomplete','Repair audit missing','Existing opening decision conflicts','rollback;'])assert.ok(tests.includes(label),label);
 assert.match(tests,/ops_repair_september_openings/);assert.match(tests,/ops_apply_historical_batch/);
});

test('rollback auth harness sets all claim inputs locally and verifies real auth resolution',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 for(const setting of ['request.jwt.claims','request.jwt.claim','request.jwt.claim.sub','request.jwt.claim.role','request.jwt.claim.aal','request.jwt.claim.session_id'])assert.ok(sql.includes("set_config('"+setting+"'"));
 const helper=sql.split('create function pg_temp.test_claims')[1].split('end $$;')[0];
 assert.doesNotMatch(helper,/security definer|set local role/i);
 for(const check of ['auth.uid()','auth.role()','auth.jwt()','current_user'])assert.ok(helper.includes(check));
 assert.doesNotMatch(sql,/insert into public.ops_role_permissions|create or replace function (public|auth)\./i);
 assert.match(sql,/Required installed Administrator permission missing/);
});
test('rollback auth harness retains stage and repair denials and checks all auth fixtures rolled back',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 for(const label of ['Unauthorized fixture','Missing staff fixture','AAL1 fixture','Non-admin fixture','AAL1 bypassed cutover MFA','Forbidden importer','Anonymous','Finance'])assert.ok(sql.includes(label));
 const cleanup=sql.split('rollback;')[1];
 for(const table of ['auth.users','auth.sessions','public.ops_staff'])assert.ok(cleanup.includes(table));
 assert.ok(cleanup.includes('a1000000-0000-0000-0000-000000000002'));
});

test('claims helper is sessionless-safe and validates only supplied claim context',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const helper=sql.split('create function pg_temp.test_claims')[1].split('end $$;')[0];
 assert.doesNotMatch(sql,/synthetic_session_facts/);
 assert.doesNotMatch(helper,/auth\.sessions|ops_session_valid|ops_can|from pg_temp/);
 assert.match(helper,/auth.uid\(\) is null/);
 assert.match(helper,/BOTH sub and session_id/);
});
test('SQL retains all sessionless contexts and authorization denial cases',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const before=sql.split('insert into auth.users')[0];
 for(const claims of ['{}','{"role":"anon"}','{"role":"authenticated"}','{"role":"service_role"}'])assert.ok(before.includes("select pg_temp.test_claims('"+claims+"')"));
 for(const marker of ['"aal":"aal1"','"aal":"aal2"','Non-admin fixture','AAL1 bypassed cutover MFA','Synthetic session prerequisite failed'])assert.ok(sql.includes(marker));
});
test('direct synthetic-session checks follow insertion and precede staff role switching',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const section=sql.slice(sql.indexOf('insert into auth.sessions'),sql.indexOf('insert into public.ops_staff'));
 assert.doesNotMatch(section,/set local role/);
 for(const label of ['Administrator','Finance'])for(const failure of ['row absent','user mismatch','created_at NULL or older than one hour'])assert.ok(section.includes(label+' '+failure));
 assert.equal((section.match(/select pg_temp.ok\(exists\(select 1 from auth.sessions/g)||[]).length,6);
});
test('each valid admin context directly tests the real session function with a safe fixed diagnostic',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const calls=[...sql.matchAll(/select pg_temp.test_claims\('.*?"sub":"a1000000-0000-0000-0000-000000000001".*?"aal":"aal2".*?;/g)];
 assert.ok(calls.length>0);
 for(const call of calls){const after=sql.slice(call.index+call[0].length);assert.match(after,/^\s*-- Real production check,[\s\S]*?select pg_temp.compare_session_validation\(public.ops_session_valid\(\)\)/);}
 assert.doesNotMatch(sql,/Production ops_session_valid disagreed/);
 assert.equal((sql.match(/select pg_temp.compare_session_validation\(public.ops_session_valid\(\)\)/g)||[]).length,calls.length);
});

test('decisive diagnostic retains caller and nested production results and raises booleans only',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const helper=sql.split('create function pg_temp.compare_session_validation')[1].split('end $$;')[0];
 assert.ok(helper.includes('caller_session_valid boolean'));
 assert.ok(helper.includes('caller_session_valid is distinct from true'));
 assert.ok(helper.includes('function_value is distinct from true'));
 assert.match(helper,/SESSION_DIAGNOSTIC: uid_match=%; session_claim_match=%; aal2=%; direct_predicate=%; ops_session_valid=%/);
 assert.match(helper,/exists\(select 1 from auth.sessions[\s\S]*public.ops_session_valid\(\)/);
 assert.doesNotMatch(helper,/raise notice/);
});

test('all comparison calls follow fixed admin AAL2 claims and four immediate caller assertions',()=>{
 const sql=fs.readFileSync(new URL('./opening-period-correction-rls.sql',import.meta.url),'utf8');
 const lines=sql.split('\n');let active=null,count=0;
 for(let i=0;i<lines.length;i++){
  const match=lines[i].match(/^select pg_temp.test_claims\('([^']+)'/);
  if(match)active=JSON.parse(match[1]);
  if(lines[i].startsWith('select pg_temp.compare_session_validation(')){
   count++;assert.deepEqual(active,{role:'authenticated',sub:'a1000000-0000-0000-0000-000000000001',session_id:'a2000000-0000-0000-0000-000000000001',aal:'aal2'});
   const immediate=lines.slice(i-4,i).join('\n');
   for(const label of ['UID mismatch','session mismatch','AAL2 missing','authenticated role missing'])assert.ok(immediate.includes(label));
  }
 }
 assert.equal(count,7);
 assert.ok(sql.includes('phase=definer_entry; uid_match=%; session_claim_match=%; aal2=%; authenticated_role=%'));
});
