-- After 202609240001 in isolated staging ONLY. Real SQL tests, not Node mocks.
-- Run the entire file; any error must abort. No real booking identities used.
-- NOT executed by local Node tests. Entire fixture transaction rolls back.
begin;
-- Fail before fixtures if the separate schema alignment has not been applied.
do $$ begin
 if (select count(*) from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass and not attisdropped
 and attname in ('opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents'))<>5 then
  raise exception 'Apply 202609240002 schema alignment before the correction regression test'; end if;
 if (select count(*) from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass and not attisdropped
 and attname in ('owner_settled_amount_known','cleaner_settled_amount_known'))<>2 then
  raise exception 'Apply 202609240003 opening write alignment before the correction regression test'; end if;
end $$;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.reject(q text,pattern text) returns void language plpgsql as $$
begin begin execute q; exception when others then if SQLERRM !~ pattern then raise; end if;return;end;raise exception 'Expected denial: %',q;end $$;
-- SQL Editor's postgres role is NOT a staff session. Keep every supported claim
-- input consistent so pre-existing scalar/legacy settings cannot override fixtures.
-- SECURITY INVOKER: this helper never sets SQL role, grants authority or mocks auth.
create function pg_temp.test_claims(claims jsonb) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claims',claims::text,true);
 perform set_config('request.jwt.claim',claims::text,true);
 perform set_config('request.jwt.claim.sub',coalesce(claims->>'sub',''),true);
 perform set_config('request.jwt.claim.role',coalesce(claims->>'role',''),true);
 perform set_config('request.jwt.claim.email','',true);
 perform set_config('request.jwt.claim.aal',coalesce(claims->>'aal',''),true);
 perform set_config('request.jwt.claim.session_id',coalesce(claims->>'session_id',''),true);
 perform pg_temp.ok(auth.uid() is not distinct from (claims->>'sub')::uuid,'Synthetic auth.uid mismatch');
 perform pg_temp.ok(auth.role() is not distinct from claims->>'role','Synthetic auth.role mismatch');
 perform pg_temp.ok(auth.jwt()->>'aal' is not distinct from claims->>'aal','Synthetic MFA claim mismatch');
 perform pg_temp.ok(auth.jwt()->>'session_id' is not distinct from claims->>'session_id','Synthetic session claim mismatch');
 if claims->>'role' is not null then
  perform pg_temp.ok(current_user::text=claims->>'role','SQL role differs from synthetic JWT role');
 end if;
 -- Deliberately sessionless contexts must work even BEFORE fixtures exist.
 if claims->>'sub' is null and claims->>'session_id' is null then
  perform pg_temp.ok(auth.uid() is null,'Sessionless claims unexpectedly resolved a user');
  perform pg_temp.ok(auth.jwt()->>'session_id' is null,'Sessionless claims unexpectedly resolved a session');
  return;
 end if;
 perform pg_temp.ok(claims->>'sub' is not null and claims->>'session_id' is not null,
  'Synthetic authenticated claims must declare BOTH sub and session_id');
 perform pg_temp.ok(claims->>'role'='authenticated','Synthetic user session requires authenticated role');
end $$;
-- Test-only, rolled back with this transaction. The argument is the REAL result
-- evaluated in the authenticated caller, so nesting cannot conceal a caller failure. Same postgres definer and empty
-- search_path as the production function; no SELECT grant on auth.sessions is
-- given to authenticated. Does not set claims, change roles or write any rows.
create function pg_temp.compare_session_validation(caller_session_valid boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid_value uuid; session_value text; aal_value text;
 direct_value boolean; function_value boolean; diagnostic jsonb;
begin
 -- Limit the diagnostic to the fixed synthetic Administrator before any lookup.
 if auth.uid() is distinct from 'a1000000-0000-0000-0000-000000000001'::uuid
 or auth.jwt()->>'session_id' is distinct from 'a2000000-0000-0000-0000-000000000001'
 or auth.jwt()->>'aal' is distinct from 'aal2'
 or auth.role() is distinct from 'authenticated' then
  raise exception 'SESSION_DIAGNOSTIC: phase=definer_entry; uid_match=%; session_claim_match=%; aal2=%; authenticated_role=%',
   coalesce(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,false),
   coalesce(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001',false),
   coalesce(auth.jwt()->>'aal'='aal2',false),coalesce(auth.role()='authenticated',false);
 end if;
 -- Both expressions are evaluated in ONE statement, with the same role/GUCs
 -- and statement snapshot. Keep the direct predicate identical to production.
 select auth.uid(),auth.jwt()->>'session_id',auth.jwt()->>'aal',
  exists(select 1 from auth.sessions
    where id::text = auth.jwt()->>'session_id' and user_id = auth.uid()
      and created_at > now() - interval '1 hour'),
  public.ops_session_valid()
 into uid_value,session_value,aal_value,direct_value,function_value;
 diagnostic:=jsonb_build_object(
  'synthetic_user','a1000000-0000-0000-0000-000000000001',
  'synthetic_session','a2000000-0000-0000-0000-000000000001',
  'uid_matches',uid_value='a1000000-0000-0000-0000-000000000001'::uuid,
  'session_matches',session_value='a2000000-0000-0000-0000-000000000001',
  'aal2',aal_value='aal2','direct_exists',direct_value,
  'ops_session_valid',caller_session_valid,'definer_nested_result',function_value);
 if direct_value is distinct from true or caller_session_valid is distinct from true or function_value is distinct from true then
  raise exception 'SESSION_DIAGNOSTIC: uid_match=%; session_claim_match=%; aal2=%; direct_predicate=%; ops_session_valid=%; definer_nested_result=%',
   coalesce(uid_value='a1000000-0000-0000-0000-000000000001'::uuid,false),
   coalesce(session_value='a2000000-0000-0000-0000-000000000001',false),
   coalesce(aal_value='aal2',false),coalesce(direct_value,false),coalesce(caller_session_valid,false),coalesce(function_value,false);
 end if;
 return diagnostic;
end $$;
revoke all on function pg_temp.compare_session_validation(boolean) from public,anon,authenticated,service_role;
grant execute on function pg_temp.compare_session_validation(boolean) to authenticated;
-- Refuse to simulate a different owner from the real SECURITY DEFINER function.
select pg_temp.ok((select a.proowner=b.proowner from pg_proc a cross join pg_proc b
 where a.oid='pg_temp.compare_session_validation(boolean)'::regprocedure
 and b.oid='public.ops_session_valid()'::regprocedure), 'Diagnostic and production function owners differ');
-- All sessionless states are exercised before any session fixtures exist.
reset role;
select pg_temp.test_claims('{}');
set local role anon;
select pg_temp.test_claims('{"role":"anon"}');
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated"}');
select pg_temp.reject($q$select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001"}')$q$,'BOTH sub and session_id');
select pg_temp.reject($q$select pg_temp.test_claims('{"role":"authenticated","session_id":"a2000000-0000-0000-0000-000000000001"}')$q$,'BOTH sub and session_id');
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}');
reset role;
select pg_temp.test_claims('{}');
-- Do not silently add production permissions to make a fixture pass.
do $$ declare permission_name text; begin
 foreach permission_name in array array['sync.run','finance.cutover','finance.write','finance.read','expenses.approve'] loop
  if not exists(select 1 from public.ops_role_permissions where role='administrator' and permission=permission_name) then
   raise exception 'Required installed Administrator permission missing: %',permission_name;
  end if;
 end loop;
end $$;
insert into auth.users(id) values('a1000000-0000-0000-0000-000000000001'),('a1000000-0000-0000-0000-000000000002');
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',now(),now()),
 ('a2000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000002',now(),now());
-- Direct fixture checks as SQL Editor/postgres, BEFORE switching to authenticated.
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000001'),
 'Synthetic session prerequisite failed: Administrator row absent');
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000001' and user_id='a1000000-0000-0000-0000-000000000001'),
 'Synthetic session prerequisite failed: Administrator user mismatch');
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000001' and user_id='a1000000-0000-0000-0000-000000000001' and created_at>now()-interval '1 hour'),
 'Synthetic session prerequisite failed: Administrator created_at NULL or older than one hour');
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000002'),
 'Synthetic session prerequisite failed: Finance row absent');
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000002' and user_id='a1000000-0000-0000-0000-000000000002'),
 'Synthetic session prerequisite failed: Finance user mismatch');
select pg_temp.ok(exists(select 1 from auth.sessions where id='a2000000-0000-0000-0000-000000000002' and user_id='a1000000-0000-0000-0000-000000000002' and created_at>now()-interval '1 hour'),
 'Synthetic session prerequisite failed: Finance created_at NULL or older than one hour');
-- Only safe indicators: no real session IDs, claims or tokens are returned.
select md5(regexp_replace(lower(p.prosrc),'[[:space:]]','','g')) as installed_session_body_hash,
 md5(regexp_replace(lower(p.prosrc),'[[:space:]]','','g'))='6340b89be222af11195f6fee53c4529b' as matches_local_session_logic,
 p.prosecdef as security_definer
 from pg_proc p where p.oid='public.ops_session_valid()'::regprocedure;
do $$ begin
 if not exists(select 1 from pg_proc where oid='public.ops_session_valid()'::regprocedure and prosecdef
 and md5(regexp_replace(lower(prosrc),'[[:space:]]','','g'))='6340b89be222af11195f6fee53c4529b') then
  raise exception 'Installed ops_session_valid differs from local reviewed logic or SECURITY DEFINER setting; inspect installed definition before changing synthetic fields';
 end if;
end $$;
insert into public.ops_staff(user_id,display_name,role,is_active) values
 ('a1000000-0000-0000-0000-000000000001','Historical fixture admin','administrator',true),
 ('a1000000-0000-0000-0000-000000000002','Historical fixture Finance','finance',true);
-- Existing normal sync must retain its exact health/counts after historical work.
insert into public.ops_sync_runs(id,source_environment,source_account,initiated_by,status,source_read_status,completed_at,imported_count,property_counts)
 values('a3000000-0000-0000-0000-000000000001','production','history-test','a1000000-0000-0000-0000-000000000001','succeeded','succeeded',now(),1,'{"legacy-suiderstrand":1}');
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_observed_at)
 values('a4000000-0000-0000-0000-000000000099','production','history-test',999981099,'legacy-suiderstrand',351452,724919,current_date+1,current_date+3,'confirmed',now());
insert into public.ops_sync_members values('a3000000-0000-0000-0000-000000000001','a4000000-0000-0000-0000-000000000099');
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');

select set_config('test.items',(select jsonb_agg(jsonb_build_object('snapshot',jsonb_build_object(
 'source_environment','production','source_account','history-test','beds24_booking_id',v.bid,
 'property_slug',v.slug,'beds24_property_id',v.pid,'beds24_room_id',v.rid,
 'arrival',v.arrival,'departure',v.departure,'source_status',v.status,'source_channel',v.channel,'source_observed_at',clock_timestamp()),
 'financial',null,'raw',jsonb_build_object('deposit',500),'expected_id',null,'expected_last_synced_at',null,'settle',false))
 from (values (999982001,'legacy-suiderstrand',351452,724919,'2026-09-05','2026-09-13','confirmed','airbnb'),
 (999982002,'kalay-ridge-villa-struisbaai',352005,726060,'2026-09-08','2026-09-11','new','airbnb'),
 (999982003,'the-pearl-beach-villa-agulhas',352276,726696,'2026-09-06','2026-09-13','confirmed','booking'))
 v(bid,slug,pid,rid,arrival,departure,status,channel))::text,true);
-- Context and authorization denials are tested before the first successful stage.
set local role anon;
select pg_temp.test_claims('{"role":"anon"}');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('e',64),current_setting('test.items')::jsonb,'Unauthorized fixture',true)$q$,'permission denied');
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated"}');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('e',64),current_setting('test.items')::jsonb,'Missing staff fixture',true)$q$,'MFA administrator');
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal1"}');
select pg_temp.ok(not public.ops_can('finance.cutover'),'AAL1 bypassed cutover MFA');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('e',64),current_setting('test.items')::jsonb,'AAL1 fixture',true)$q$,'MFA administrator');
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000002","session_id":"a2000000-0000-0000-0000-000000000002","aal":"aal2"}');
select pg_temp.ok(public.ops_can('finance.write') and not public.ops_can('finance.cutover'),'Finance fixture permissions incorrect');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('e',64),current_setting('test.items')::jsonb,'Non-admin fixture',true)$q$,'MFA administrator');
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}');
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select set_config('test.fresh',public.ops_stage_historical_batch('history-test',repeat('e',64),current_setting('test.items')::jsonb,'Fresh unpaid opening regression',true)::text,true);
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}'::jsonb);
select set_config('test.fresh_result',public.ops_apply_historical_batch(current_setting('test.fresh')::uuid)::text,true);
select pg_temp.ok(current_setting('test.fresh_result')::jsonb @> '{"booking_count":3,"newly_created_opening_count":3,"preserved_opening_count":0,"settlement_count":0}', 'Fresh unpaid opening counters');
select pg_temp.ok(public.ops_apply_historical_batch(current_setting('test.fresh')::uuid)=current_setting('test.fresh_result')::jsonb,'Fresh rerun changed result');
reset role;
select pg_temp.test_claims('{}'::jsonb);
select pg_temp.ok((select count(*)=3 and bool_and(o.opening_period and o.state='open' and o.owner_settlement_state='outstanding' and o.cleaner_settlement_state='outstanding' and o.owner_settled_cents=0 and o.cleaner_settled_cents=0)
 from public.ops_stay_opening_positions o join public.ops_bookings b on b.id=o.booking_id where b.source_account='history-test'),'Fresh unpaid openings');
-- Explicit settlement remains separate; it is a subset of newly created openings.
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select set_config('test.settled_items',jsonb_build_array(jsonb_set(jsonb_set(current_setting('test.items')::jsonb->0,'{snapshot,beds24_booking_id}','999982004'),'{settle}','true'))::text,true);
select set_config('test.settled_batch',public.ops_stage_historical_batch('history-test',repeat('1',64),current_setting('test.settled_items')::jsonb,'Explicit test settlement',true)::text,true);
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}'::jsonb);
select pg_temp.ok(public.ops_apply_historical_batch(current_setting('test.settled_batch')::uuid) @>
 '{"newly_created_opening_count":1,"preserved_opening_count":0,"settlement_count":1}', 'Explicit settlement counters');
reset role;
select pg_temp.test_claims('{}'::jsonb);
select pg_temp.ok((select o.state='fully_settled_historical' and o.confirmed_by_bond from public.ops_stay_opening_positions o join public.ops_bookings b on b.id=o.booking_id
 where b.source_account='history-test' and b.beds24_booking_id=999982004),'Explicit settled opening');
-- Simulate a skipped insert to prove the postcondition rolls the ENTIRE apply back.
create function pg_temp.skip_test_opening() returns trigger language plpgsql as $$
begin
 if exists(select 1 from public.ops_bookings where id=new.booking_id and source_account='history-test' and beds24_booking_id=999982005) then return null; end if;
 return new;
end $$;
create trigger corrective_test_skip before insert on public.ops_stay_opening_positions for each row execute function pg_temp.skip_test_opening();
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select set_config('test.skipped_batch',public.ops_stage_historical_batch('history-test',repeat('2',64),
 jsonb_build_array(jsonb_set(current_setting('test.items')::jsonb->0,'{snapshot,beds24_booking_id}','999982005')),'Atomic postcondition test',true)::text,true);
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}'::jsonb);
select pg_temp.reject($q$select public.ops_apply_historical_batch(current_setting('test.skipped_batch')::uuid)$q$,'Unpaid opening postcondition failed');
reset role;
select pg_temp.test_claims('{}'::jsonb);
drop trigger corrective_test_skip on public.ops_stay_opening_positions;
select pg_temp.ok(not exists(select 1 from public.ops_bookings where source_account='history-test' and beds24_booking_id=999982005),'Failed apply committed booking');
select pg_temp.ok(not exists(select 1 from public.ops_historical_results where batch_id=current_setting('test.skipped_batch')::uuid),'Failed apply committed result');
select pg_temp.ok(not public.ops_historical_guest_eligible(jsonb_set(current_setting('test.items')::jsonb->0,'{snapshot,source_status}','"request"')),'Request qualified');
select pg_temp.ok(not public.ops_historical_guest_eligible(jsonb_set(current_setting('test.items')::jsonb->0,'{raw,isBlocked}','true')),'Block qualified');
-- Simulate an OLD committed batch with its three bookings but no opening positions.
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select set_config('test.legacy_items',(select jsonb_agg(jsonb_set(v,'{snapshot,source_account}','"history-repair-test"')) from jsonb_array_elements(current_setting('test.items')::jsonb) v)::text,true);
select set_config('test.legacy',public.ops_stage_historical_batch('history-repair-test',repeat('f',64),current_setting('test.legacy_items')::jsonb,'Legacy partial regression',true)::text,true);
reset role;
select pg_temp.test_claims('{}'::jsonb);
insert into public.ops_bookings(source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,source_observed_at)
 select 'production','history-repair-test',(v->'snapshot'->>'beds24_booking_id')::bigint,v->'snapshot'->>'property_slug',
 (v->'snapshot'->>'beds24_property_id')::bigint,(v->'snapshot'->>'beds24_room_id')::bigint,
 (v->'snapshot'->>'arrival')::date,(v->'snapshot'->>'departure')::date,v->'snapshot'->>'source_status',v->'snapshot'->>'source_channel',clock_timestamp()
 from jsonb_array_elements(current_setting('test.legacy_items')::jsonb) v;
insert into public.ops_historical_results(batch_id,booking_count,settlement_count,retained_opening_count)
 values(current_setting('test.legacy')::uuid,3,0,0);
-- Seed staff financial evidence that the repair must preserve byte-for-byte.
select set_config('test.repair_booking',(select id::text from public.ops_bookings where source_account='history-repair-test' and beds24_booking_id=999982001),true);
insert into public.ops_stay_financial_reviews(booking_id,request_key,status,accommodation_cents,channel_fees_cents,cleaner_supplier,funds_received_cents,funds_as_of,reason,source_basis,rate_nights,checkout_month,created_by)
 values(current_setting('test.repair_booking')::uuid,gen_random_uuid(),'draft',1230000,0,'Fixture cleaner',0,'2026-09-23','Preserve draft, not funds received','{}','[]','2026-09-01','a1000000-0000-0000-0000-000000000001');
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select set_config('test.repair_expense',public.ops_finance_write('expense',jsonb_build_object('request_key',gen_random_uuid(),'booking_id',current_setting('test.repair_booking'),
 'incurred_on','2026-09-13','category','laundry','supplier','Fixture supplier','description','Preserved expense','amount_cents',30000,
 'payer','bste','allocation','owner','owner_amount_cents',30000,'status','approved','reason','Test evidence'))::text,true);
select public.ops_finance_write('attachment',jsonb_build_object('request_key',gen_random_uuid(),'expense_id',current_setting('test.repair_expense'),
 'original_name','fixture','media_type','application/pdf','size_bytes',100,'sha256',repeat('c',64)));
reset role;
select pg_temp.test_claims('{}'::jsonb);
-- Preserve exact table snapshots, including any pre-existing non-test financial work.
create function pg_temp.protected_state() returns jsonb language plpgsql as $$
declare t text; rows jsonb; result jsonb:='{}';
begin
 foreach t in array array['ops_bookings','ops_historical_batches','ops_historical_results','ops_payment_records','ops_payment_arrangements',
 'ops_stay_financial_reviews','ops_stay_expenses','ops_expense_attachments','ops_sync_runs','ops_sync_members','ops_communications','ops_booking_financial_snapshots','ops_beds24_raw_snapshots'] loop
 execute format('select coalesce(jsonb_agg(x order by x::text),''[]''::jsonb) from (select to_jsonb(r) x from public.%I r) q',t) into rows;
 result:=result||jsonb_build_object(t,rows);
 end loop;return result;
end $$;
select set_config('test.before',pg_temp.protected_state()::text,true);
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}'::jsonb);
select pg_temp.reject($q$select public.ops_apply_historical_batch(current_setting('test.legacy')::uuid)$q$,'Historical opening state incomplete');
select pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Forbidden importer')$q$,'permission denied');
set local role anon;
select pg_temp.test_claims('{"role":"anon"}'::jsonb);
select pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Anonymous')$q$,'permission denied');
set local role authenticated;
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal1"}'::jsonb);
select pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'AAL1')$q$,'MFA administrator');
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000002","session_id":"a2000000-0000-0000-0000-000000000002","aal":"aal2"}'::jsonb);
select pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Finance')$q$,'MFA administrator');
select pg_temp.test_claims('{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}'::jsonb);
-- Real production check, never a copied lookup. The preceding helper verifies
-- exact supplied claims. This message contains ONLY fixed synthetic identifiers.
select pg_temp.ok(auth.uid()='a1000000-0000-0000-0000-000000000001'::uuid,'Comparison caller: synthetic Administrator UID mismatch');
select pg_temp.ok(auth.jwt()->>'session_id'='a2000000-0000-0000-0000-000000000001','Comparison caller: synthetic Administrator session mismatch');
select pg_temp.ok(auth.jwt()->>'aal'='aal2','Comparison caller: AAL2 missing');
select pg_temp.ok(auth.role()='authenticated','Comparison caller: authenticated role missing');
select pg_temp.compare_session_validation(public.ops_session_valid()) as synthetic_session_comparison;
select pg_temp.ok(public.ops_can('sync.run'),'Synthetic admin missing sync.run');
select pg_temp.ok(public.ops_can('finance.cutover'),'Synthetic admin missing finance.cutover');
select pg_temp.ok(public.ops_can('finance.write'),'Synthetic admin missing finance.write');
select pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.fresh')::uuid,'Wrong batch')$q$,'Not the legacy partial');
-- REAL corrected write path; nested fixture history is rolled back before repair.
do $$ declare base jsonb; input_value jsonb; bad jsonb; opened uuid; settled uuid; reopened uuid;
begin
 begin
  base:=jsonb_build_object('booking_id',current_setting('test.repair_booking'),'state','open','reason','Opening write compatibility fixture');
  input_value:=base||jsonb_build_object('request_key',gen_random_uuid());
  opened:=public.ops_finance_write('opening',input_value);
  perform pg_temp.ok(public.ops_finance_write('opening',input_value)=opened,'Opening retry duplicated');
  perform pg_temp.reject(format('select public.ops_finance_write(''opening'',%L::jsonb)',(input_value||'{"reason":"Changed retry"}'::jsonb)::text),'Request key already used');
  perform pg_temp.ok(exists(select 1 from public.ops_stay_opening_positions where id=opened and opening_period
   and owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding' and owner_settled_cents=0 and cleaner_settled_cents=0
   and owner_settled_amount_known and cleaner_settled_amount_known),'Open write defaults wrong');
  for bad in select value from jsonb_array_elements('[
   {"state":"fully_settled_historical","owner_settlement_state":"outstanding","confirmed_by_bond":true},
   {"state":"open","owner_settlement_state":"fully_settled","cleaner_settlement_state":"fully_settled","confirmed_by_bond":true},
   {"owner_settlement_state":"partially_settled","confirmed_by_bond":true},
   {"owner_settlement_state":"partially_settled","owner_settled_cents":0,"confirmed_by_bond":true},
   {"owner_settled_cents":-1},{"cleaner_settled_cents":-1},{"owner_settled_cents":1.5},
   {"owner_settled_cents":50},{"state":"fully_settled_historical","confirmed_by_bond":false},
   {"owner_settlement_state":"partially_settled","owner_settled_cents":50,"confirmed_by_bond":false}
  ]') loop
   perform pg_temp.reject(format('select public.ops_finance_write(''opening'',%L::jsonb)',
    (base||bad||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',opened))::text),
    'contradicts|Partial settlement|non-negative integer|Outstanding obligation|Bond confirmation');
  end loop;
  input_value:=base||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',opened,'state','fully_settled_historical','confirmed_by_bond',true);
  settled:=public.ops_finance_write('opening',input_value);
  perform pg_temp.ok(public.ops_finance_write('opening',input_value)=settled,'Settled retry duplicated');
  perform pg_temp.ok(exists(select 1 from public.ops_stay_opening_positions where id=settled and previous_id=opened
   and state='fully_settled_historical' and owner_settlement_state='fully_settled' and cleaner_settlement_state='fully_settled'
   and owner_settled_amount_known=false and cleaner_settled_amount_known=false),'Unknown historical amounts manufactured');
  reopened:=public.ops_finance_write('opening',base||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',settled));
  perform pg_temp.ok(exists(select 1 from public.ops_stay_opening_positions where id=reopened and previous_id=settled and state='open'),'Reopening chain lost');
  perform pg_temp.ok((select count(*)=3 from public.ops_stay_opening_positions where booking_id=current_setting('test.repair_booking')::uuid),'Revision history overwritten');
  perform pg_temp.reject(format('select public.ops_finance_write(''opening'',%L::jsonb)',
   (base||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',opened))::text),'Stale financial revision');
  perform pg_temp.ok((select coalesce(jsonb_agg(x order by x::text),'[]'::jsonb) from (select to_jsonb(r) x from public.ops_payment_records r) q)=current_setting('test.before')::jsonb->'ops_payment_records','Opening decision created payment');
  perform pg_temp.ok((select coalesce(jsonb_agg(x order by x::text),'[]'::jsonb) from (select to_jsonb(r) x from public.ops_stay_financial_reviews r) q)=current_setting('test.before')::jsonb->'ops_stay_financial_reviews','Opening decision changed funds review');
  raise exception using errcode='ZX002',message='Rollback opening compatibility fixtures';
 exception when sqlstate 'ZX002' then null;
 end;
end $$;
do $$ begin
 begin
  perform public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id',current_setting('test.repair_booking'),
   'state','fully_settled_historical','confirmed_by_bond',true,'reason','Temporary conflicting decision'));
  perform pg_temp.reject($q$select public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Conflict test')$q$,'Existing opening decision conflicts');
  raise exception using errcode='ZX001',message='Rollback deliberate conflict fixture';
 exception when sqlstate 'ZX001' then null;
 end;
end $$;
select pg_temp.ok(public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Repair fixture approved by administrator')=
 '{"newly_created_opening_count":3,"preserved_opening_count":0,"settlement_count":0}'::jsonb,'Repair did not create three unpaid openings');
select pg_temp.ok(public.ops_repair_september_openings(current_setting('test.legacy')::uuid,'Idempotent repeat')=
 '{"newly_created_opening_count":0,"preserved_opening_count":3,"settlement_count":0}'::jsonb,'Repair repeated rows');
reset role;
select pg_temp.test_claims('{}'::jsonb);
select pg_temp.ok(pg_temp.protected_state()=current_setting('test.before')::jsonb,'Repair altered protected source/financial/batch/sync data');
select pg_temp.ok((select count(*)=3 and bool_and(o.opening_period and o.state='open' and o.owner_settlement_state='outstanding' and o.cleaner_settlement_state='outstanding' and o.owner_settled_cents=0 and o.cleaner_settled_cents=0)
 from public.ops_stay_opening_positions o join public.ops_bookings b on b.id=o.booking_id where b.source_account='history-repair-test'),'Repair unpaid positions');
select pg_temp.ok((select count(*)=3 and bool_and(actor_user_id='a1000000-0000-0000-0000-000000000001'::uuid and occurred_at is not null and detail->>'reason'='Repair fixture approved by administrator')
 from public.ops_events where action='historical.opening_position_repaired' and system_run_id=current_setting('test.legacy')::uuid),'Repair audit missing/duplicated');
-- A repaired legacy result can be checked, but is never rewritten to pretend the original import succeeded fully.
set local role service_role;
select pg_temp.test_claims('{"role":"service_role"}'::jsonb);
select pg_temp.ok(public.ops_apply_historical_batch(current_setting('test.legacy')::uuid)->'newly_created_opening_count'='null'::jsonb,'Legacy result rewritten');
reset role;
select pg_temp.test_claims('{}'::jsonb);
select pg_temp.ok(pg_temp.protected_state()=current_setting('test.before')::jsonb,'Replay changed original evidence');
rollback;
do $$ begin
 if exists(select 1 from public.ops_bookings where source_account in ('history-test','history-repair-test'))
 or exists(select 1 from public.ops_historical_batches where source_account in ('history-test','history-repair-test'))
 or exists(select 1 from auth.users where id in ('a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002'))
 or exists(select 1 from auth.sessions where id in ('a2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000002'))
 or exists(select 1 from public.ops_staff where user_id in ('a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002')) then raise exception 'Corrective fixtures not rolled back'; end if;
end $$;
