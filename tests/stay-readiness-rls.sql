-- OPS-1: isolated staging ONLY after 202609280001; run COMPLETE file.
-- All fixtures are synthetic; no external transport. No real booking is changed.
-- A failure aborts the transaction; never COMMIT a failed/partial run.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.denied(q text,code text) returns void language plpgsql as $$
begin begin execute q; exception when others then if SQLSTATE<>code then raise; end if; return; end; raise exception 'Expected denial'; end $$;
create function pg_temp.claims(v jsonb) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claims',v::text,true); perform set_config('request.jwt.claim',v::text,true);
 perform set_config('request.jwt.claim.sub',coalesce(v->>'sub',''),true); perform set_config('request.jwt.claim.role',coalesce(v->>'role',''),true);
 perform set_config('request.jwt.claim.aal',coalesce(v->>'aal',''),true); perform set_config('request.jwt.claim.session_id',coalesce(v->>'session_id',''),true);
end $$;
create function pg_temp.fingerprint(t text) returns text language plpgsql as $$
declare result text; begin execute format('select md5(coalesce(string_agg(to_jsonb(x)::text,''|'' order by to_jsonb(x)::text),'''')) from public.%I x',t) into result; return result; end $$;
create temp table baseline(t text primary key,h text);
insert into baseline select t,pg_temp.fingerprint(t) from unnest(array[
 'ops_bookings','ops_stay_financial_reviews','ops_payment_records','ops_stay_opening_positions',
 'ops_communications','ops_sync_runs','ops_sync_members','ops_events','ops_readiness_checkpoints','ops_readiness_responses','ops_readiness_actions','ops_readiness_prompts','ops_readiness_templates','ops_readiness_cleaning']) t;
-- Fingerprint every existing finance/payment/settlement/receipt table, not just counts.
insert into baseline select c.relname,pg_temp.fingerprint(c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and c.relname ~ '^ops_.*(finance|financial|payment|settlement|payout|expense|attachment|owner_rate|owner_statement|reconciliation)'
on conflict(t) do nothing;
select set_config('test.ops1.other_session',gen_random_uuid()::text,true);
select set_config('test.ops1.nonstaff',gen_random_uuid()::text,true);
select set_config('test.ops1.nonstaff_session',gen_random_uuid()::text,true);
select set_config('test.ops1.admin',gen_random_uuid()::text,true);
select set_config('test.ops1.operator',gen_random_uuid()::text,true);
select set_config('test.ops1.finance',gen_random_uuid()::text,true);
select set_config('test.ops1.session',gen_random_uuid()::text,true);
select set_config('test.ops1.operator_session',gen_random_uuid()::text,true);
select set_config('test.ops1.finance_session',gen_random_uuid()::text,true);
select set_config('test.ops1.account','ops1-fixture-'||gen_random_uuid()::text,true);
select set_config('test.ops1.booking',gen_random_uuid()::text,true);
select set_config('test.ops1.manual',gen_random_uuid()::text,true);
select set_config('test.ops1.historical',gen_random_uuid()::text,true);
savepoint synthetic_work;
select pg_temp.claims('{}');
insert into auth.users(id) values(current_setting('test.ops1.admin')::uuid),(current_setting('test.ops1.operator')::uuid),(current_setting('test.ops1.finance')::uuid),(current_setting('test.ops1.nonstaff')::uuid);
insert into auth.sessions(id,user_id,created_at,updated_at) values
 (current_setting('test.ops1.session')::uuid,current_setting('test.ops1.admin')::uuid,now(),now()),
 (current_setting('test.ops1.operator_session')::uuid,current_setting('test.ops1.operator')::uuid,now(),now()),
 (current_setting('test.ops1.finance_session')::uuid,current_setting('test.ops1.finance')::uuid,now(),now()),
 (current_setting('test.ops1.other_session')::uuid,current_setting('test.ops1.admin')::uuid,now(),now()),
 (current_setting('test.ops1.nonstaff_session')::uuid,current_setting('test.ops1.nonstaff')::uuid,now(),now());
insert into public.ops_staff(user_id,display_name,role,is_active) values
 (current_setting('test.ops1.admin')::uuid,'Synthetic OPS1 Admin','administrator',true),
 (current_setting('test.ops1.operator')::uuid,'Synthetic OPS1 Operator','operations',true),
 (current_setting('test.ops1.finance')::uuid,'Synthetic OPS1 Finance','finance',true);
-- The trigger under test runs on actual synthetic booking inserts.
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,guest_name,source_observed_at)
 values(current_setting('test.ops1.booking')::uuid,'production',current_setting('test.ops1.account'),900001,'legacy-suiderstrand',351452,724919,
 (now() at time zone 'Africa/Johannesburg')::date+3,(now() at time zone 'Africa/Johannesburg')::date+6,'new','airbnb','Synthetic readiness guest',clock_timestamp());
insert into public.ops_bookings(id,source_kind,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,guest_name,source_observed_at,manual_reference,manual_booked_on,manual_created_by,first_imported_at,last_synced_at)
 values(current_setting('test.ops1.manual')::uuid,'manual_direct','production','bste-historical-direct',null,'legacy-suiderstrand',351452,724919,
 current_date+3,current_date+6,'confirmed','direct / BSTE website','Synthetic manual guest',clock_timestamp(),'OPS1-'||gen_random_uuid()::text,current_date,current_setting('test.ops1.admin')::uuid,null,null);
select pg_temp.ok((select count(*)=5 from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid),'OTA generated exactly five checkpoints');
select pg_temp.ok((select count(*)=5 from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.manual')::uuid),'Manual direct generated exactly five checkpoints');
select pg_temp.ok((select bool_and((c.due_at at time zone 'Africa/Johannesburg')::date=(case t.anchor when 'arrival' then b.arrival else b.departure end)+t.offset_days and extract(hour from c.due_at at time zone 'Africa/Johannesburg')=t.local_hour) from public.ops_readiness_checkpoints c join public.ops_readiness_templates t using(checkpoint_key) join public.ops_bookings b on b.id=c.booking_id where b.id=current_setting('test.ops1.booking')::uuid),'All five checkpoint calendar/time rules');
select set_config('test.ops1.checkpoint',(select id::text from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid and checkpoint_key='pre_arrival'),true);
-- Helpers invoke only the real authenticated RPCs; no private-helper grants/bypasses.
create function pg_temp.issue(a text) returns text language plpgsql as $$
declare hashes jsonb:=jsonb_build_object('yes',repeat(md5(gen_random_uuid()::text),2),'no',repeat(md5(gen_random_uuid()::text),2),'tomorrow',repeat(md5(gen_random_uuid()::text),2));
 r jsonb; rev integer; replacement uuid;
begin
 select (c->>'revision')::integer into rev from jsonb_array_elements(public.ops_readiness_read(current_setting('test.ops1.account'))) v(b),jsonb_array_elements(b->'checkpoints') w(c) where c->>'id'=current_setting('test.ops1.checkpoint');
 r:=public.ops_readiness_prompt(current_setting('test.ops1.checkpoint')::uuid,rev,gen_random_uuid(),hashes);
 if (r->>'expires_at')::timestamptz<=now() then
  replacement:=(r->>'prompt_id')::uuid;
  r:=public.ops_readiness_prompt(current_setting('test.ops1.checkpoint')::uuid,rev,gen_random_uuid(),hashes,replacement,'staging');
 end if;
 perform set_config('test.ops1.prompt',r->>'prompt_id',true);
 return r->'token_hashes'->>a;
end $$;
create function pg_temp.respond(digest text,note text) returns jsonb language sql as $$
 select public.ops_readiness_respond(digest,note,current_setting('test.ops1.booking')::uuid,'staging');
$$;
-- All application roles have no direct SELECT/INSERT/UPDATE/DELETE on the six tables.
select pg_temp.ok(not exists(select 1 from unnest(array['anon','authenticated','service_role']) r,
 unnest(array['ops_readiness_templates','ops_readiness_checkpoints','ops_readiness_responses','ops_readiness_actions','ops_readiness_prompts','ops_readiness_cleaning']) t,
 unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege where has_table_privilege(r,'public.'||t,privilege)), 'No direct application table privileges');
set local role anon;
select pg_temp.claims('{"role":"anon"}');
select pg_temp.denied('select public.ops_readiness_read(''x'')','42501');
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal1'));
select pg_temp.denied('select public.ops_readiness_generate(current_setting(''test.ops1.booking'')::uuid)','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.finance'),'session_id',current_setting('test.ops1.finance_session'),'aal','aal2'));
select pg_temp.denied('select public.ops_readiness_generate(current_setting(''test.ops1.booking'')::uuid)','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.ok(public.ops_session_valid(),'Real synthetic administrator session validity');
select public.ops_readiness_generate(current_setting('test.ops1.booking')::uuid);
select public.ops_readiness_generate(current_setting('test.ops1.booking')::uuid);
select pg_temp.denied('select * from public.ops_readiness_actions','42501');
select pg_temp.denied('delete from public.ops_readiness_checkpoints','42501');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.nonstaff'),'session_id',current_setting('test.ops1.nonstaff_session'),'aal','aal2'));
select pg_temp.denied('select public.ops_readiness_generate(current_setting(''test.ops1.booking'')::uuid)','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select set_config('test.ops1.yes',pg_temp.issue('yes'),true);
select pg_temp.ok(pg_temp.issue('yes')=current_setting('test.ops1.yes'),'Repeated issuance reuses active prompt/action');
reset role;
select pg_temp.ok((select count(*)=3 from public.ops_readiness_actions where checkpoint_id=current_setting('test.ops1.checkpoint')::uuid),'Repeated preview inserts only three actions');
select set_config('test.ops1.generation_a',current_setting('test.ops1.prompt'),true);
select set_config('test.ops1.old_yes',current_setting('test.ops1.yes'),true);
select set_config('test.ops1.generation_b',gen_random_uuid()::text,true);
select set_config('test.ops1.revision',(select revision::text from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid),true);
set local role authenticated;
select set_config('test.ops1.yes',(public.ops_readiness_prompt(current_setting('test.ops1.checkpoint')::uuid,current_setting('test.ops1.revision')::integer,current_setting('test.ops1.generation_b')::uuid,
 jsonb_build_object('yes',repeat(md5(gen_random_uuid()::text),2),'no',repeat(md5(gen_random_uuid()::text),2),'tomorrow',repeat(md5(gen_random_uuid()::text),2)),current_setting('test.ops1.generation_a')::uuid)->'token_hashes'->>'yes'),true);
select pg_temp.ok(public.ops_readiness_prompt(current_setting('test.ops1.checkpoint')::uuid,current_setting('test.ops1.revision')::integer,current_setting('test.ops1.generation_a')::uuid,'{}')->>'prompt_id'=current_setting('test.ops1.generation_b'),'Ordinary preview resolves B not A');
select pg_temp.ok(public.ops_readiness_prompt(current_setting('test.ops1.checkpoint')::uuid,current_setting('test.ops1.revision')::integer,current_setting('test.ops1.generation_b')::uuid,'{}',current_setting('test.ops1.generation_a')::uuid)->>'prompt_id'=current_setting('test.ops1.generation_b'),'Replacement retry reuses B');
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.old_yes''),''stale'')','P0001');
reset role;
select pg_temp.ok((select superseded_at is not null from public.ops_readiness_prompts where id=current_setting('test.ops1.generation_a')::uuid),'Generation A preserved but superseded');
select pg_temp.ok((select count(*)=2 and count(*) filter(where superseded_at is null)=1 from public.ops_readiness_prompts where checkpoint_id=current_setting('test.ops1.checkpoint')::uuid),'No generation C or duplicate active prompt');
select pg_temp.ok((select count(*)=6 from public.ops_readiness_actions where checkpoint_id=current_setting('test.ops1.checkpoint')::uuid),'Exactly A and B action sets retained');

set local role authenticated;
select pg_temp.denied('select public.ops_readiness_respond(current_setting(''test.ops1.yes''),'''',current_setting(''test.ops1.manual'')::uuid,''staging'')','P0001');
select pg_temp.denied('select public.ops_readiness_respond(current_setting(''test.ops1.yes''),'''',current_setting(''test.ops1.booking'')::uuid,''production'')','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.other_session'),'aal','aal2'));
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.yes''),'''')','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',gen_random_uuid(),'aal','aal2'));
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.yes''),'''')','P0001');
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));

select pg_temp.ok(pg_temp.respond(current_setting('test.ops1.yes'),'Ready fixture')->'checkpoint'->>'status'='complete','YES complete');
select pg_temp.ok(pg_temp.respond(current_setting('test.ops1.yes'),'Duplicate')->'checkpoint'->>'status'='complete','Consumed action replay returns saved result');
select set_config('test.ops1.no',pg_temp.issue('no'),true);
select pg_temp.ok(pg_temp.respond(current_setting('test.ops1.no'),'Synthetic issue')->'checkpoint'->>'status'='needs_attention','NO correction records attention');
select pg_temp.ok((pg_temp.respond(current_setting('test.ops1.no'),'Replay NO')->>'replayed')::boolean,'NO replay explicit');
reset role;
select pg_temp.claims('{}');
update public.ops_bookings set arrival=arrival+1,departure=departure+1,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select status='needs_attention' and issue_open and schedule_review from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid),'First reschedule preserves unresolved NO');
update public.ops_bookings set arrival=arrival+1,departure=departure+1,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select status='needs_attention' and issue_open and schedule_review from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid),'Second reschedule cannot clear unresolved NO/review');
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.ok((pg_temp.respond(current_setting('test.ops1.no'),'Replay after reschedule')->'checkpoint'->>'schedule_review')::boolean,'Replay reports current revision review');
select set_config('test.ops1.defer',pg_temp.issue('tomorrow'),true);
select pg_temp.ok(pg_temp.respond(current_setting('test.ops1.defer'),'Recheck')->'checkpoint'->>'status'='deferred','Tomorrow defers');
reset role;
select pg_temp.ok((select count(*)=3 from public.ops_readiness_responses where checkpoint_id=current_setting('test.ops1.checkpoint')::uuid),'Responses append, replay adds no duplicate');
select pg_temp.ok((select (deferred_until at time zone 'Africa/Johannesburg')::date=(now() at time zone 'Africa/Johannesburg')::date+1 from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid),'Deferred next SAST day');
set local role authenticated;
select set_config('test.ops1.expired',pg_temp.issue('yes'),true);
reset role;
update public.ops_readiness_actions set expires_at=now()-interval '1 minute' where token_hash=current_setting('test.ops1.expired');
update public.ops_readiness_prompts set expires_at=now()-interval '1 minute' where id=current_setting('test.ops1.prompt')::uuid;
set local role authenticated;
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.expired''),'''')','P0001');
select set_config('test.ops1.bound',pg_temp.issue('yes'),true);
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.operator'),'session_id',current_setting('test.ops1.operator_session'),'aal','aal1'));
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.bound''),'''')','P0001');
select public.ops_readiness_generate(current_setting('test.ops1.booking')::uuid); -- ordinary operations allowed, no finance authority
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.respond(current_setting('test.ops1.bound'),'Completed before date change');
reset role;
select pg_temp.ok((select not issue_open and not schedule_review from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid),'Explicit authorized YES resolves issue/review');
select set_config('test.ops1.manual_hash',(select md5(to_jsonb(b)::text) from public.ops_bookings b where id=current_setting('test.ops1.manual')::uuid),true);
create temp table completed_before as select id,status,items,responded_at from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid;
-- Real source importer RPC used locally; no Beds24 network. Stable account stays unique.
select set_config('test.ops1.snapshot',(select (to_jsonb(b)-array['id','source_kind','manual_reference','manual_created_by','manual_booked_on','manual_note'])::text from public.ops_bookings b where id=current_setting('test.ops1.booking')::uuid),true);
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select public.ops_sync_booking(current_setting('test.ops1.snapshot')::jsonb,null,gen_random_uuid());
select public.ops_sync_booking(current_setting('test.ops1.snapshot')::jsonb,null,gen_random_uuid());
select pg_temp.denied('select public.ops_readiness_generate(current_setting(''test.ops1.booking'')::uuid)','42501');
select pg_temp.denied('delete from public.ops_readiness_checkpoints','42501');
select pg_temp.denied('update public.ops_readiness_cleaning set note=''bad''','42501');
select pg_temp.denied('insert into public.ops_readiness_prompts(id) values(gen_random_uuid())','42501');
reset role;
select pg_temp.claims('{}');
select pg_temp.ok((select count(*)=5 from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid),'Repeated sync does not duplicate checklists');
update public.ops_bookings set arrival=arrival+1,departure=departure+1,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select c.status=b.status and c.items=b.items and c.responded_at=b.responded_at and c.schedule_review from public.ops_readiness_checkpoints c join completed_before b using(id)),'Completed evidence survives date change and requires review');
select pg_temp.ok((select (c.due_at at time zone 'Africa/Johannesburg')::date=b.arrival-1 from public.ops_readiness_checkpoints c join public.ops_bookings b on b.id=c.booking_id where b.id=current_setting('test.ops1.booking')::uuid and c.checkpoint_key='final_arrival'),'Future due dates revised');
-- Unused actions must fail after a revision change; consumed replay never mutates.
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select set_config('test.ops1.unused',pg_temp.issue('no'),true);
select public.ops_readiness_cleaner(current_setting('test.ops1.booking')::uuid,'unassigned',null,null,'Not yet assigned');
select public.ops_readiness_cleaner(current_setting('test.ops1.booking')::uuid,'not_required',null,null,'Synthetic exemption');
select pg_temp.denied('select public.ops_readiness_cleaner(current_setting(''test.ops1.booking'')::uuid,''assigned'',''Synthetic cleaner'',''infinity'','''')','P0001');
select pg_temp.denied('select public.ops_readiness_cleaner(current_setting(''test.ops1.booking'')::uuid,''assigned'',''Synthetic cleaner'',''-infinity'','''')','P0001');
select pg_temp.denied('select public.ops_readiness_cleaner(current_setting(''test.ops1.booking'')::uuid,''assigned'',''Synthetic cleaner'',''2030-10-01T16:00:00'','''')','P0001');
reset role;
select set_config('test.ops1.clean_time',(select departure::text||'T16:00:00+02:00' from public.ops_bookings where id=current_setting('test.ops1.booking')::uuid),true);
set local role authenticated;
select public.ops_readiness_cleaner(current_setting('test.ops1.booking')::uuid,'assigned','Synthetic cleaner',current_setting('test.ops1.clean_time'),'Explicit finite zoned time');
reset role;
select pg_temp.claims('{}');
update public.ops_bookings set arrival=arrival+2,departure=departure+2,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select schedule_review and expected_cleaning_at=current_setting('test.ops1.clean_time')::timestamptz from public.ops_readiness_cleaning where booking_id=current_setting('test.ops1.booking')::uuid),'Old explicit cleaning time preserved and review required');
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.unused''),'''')','P0001');
select set_config('test.ops1.cancel_unused',pg_temp.issue('no'),true);
reset role;
select pg_temp.claims('{}');
update public.ops_bookings set source_status='cancelled',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok(not exists(select 1 from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid and status not in ('complete','not_applicable')),'Cancellation suppresses unresolved checkpoints');
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.denied('select pg_temp.issue(''yes'')','P0001');
select pg_temp.denied('select pg_temp.respond(current_setting(''test.ops1.cancel_unused''),'''')','P0001');
reset role;
create temp table replay_before as select t,pg_temp.fingerprint(t) h from baseline where t like 'ops_readiness_%' or t='ops_events';
set local role authenticated;
select pg_temp.ok((pg_temp.respond(current_setting('test.ops1.yes'),'Replay after cancellation')->>'replayed')::boolean,'YES replay after cancellation is explicit');
select pg_temp.ok(not (pg_temp.respond(current_setting('test.ops1.no'),'Replay after cancellation')->>'eligible')::boolean,'Consumed NO replay shows current ineligibility');
reset role;
select pg_temp.ok(not exists(select 1 from replay_before where h<>pg_temp.fingerprint(t)),'Consumed replay performs ZERO readiness/audit mutation');
-- Real canonical eligibility: explicit review vetoes confirmed; blocked vetoes reviewed confirmed.
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
insert into public.ops_booking_overrides(booking_id,operational_status,reason,created_by) values(current_setting('test.ops1.manual')::uuid,'review_required','Synthetic explicit review',current_setting('test.ops1.admin')::uuid);
select pg_temp.ok(not public.ops_readiness_eligible(current_setting('test.ops1.manual')::uuid),'Confirmed with unresolved review ineligible');
insert into public.ops_booking_overrides(booking_id,operational_status,reason,created_by) values(current_setting('test.ops1.booking')::uuid,'confirmed','Synthetic reviewed blocked',current_setting('test.ops1.admin')::uuid);
select pg_temp.claims('{}');
update public.ops_bookings set source_status='blocked',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok(not public.ops_readiness_eligible(current_setting('test.ops1.booking')::uuid),'Blocked remains ineligible despite confirmed override');
-- Simulate pre-existing old unresolved operational work on SYNTHETIC booking only.
update public.ops_bookings set arrival=current_date-24,departure=current_date-20,source_status='confirmed',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
update public.ops_readiness_checkpoints set status='deferred',deferred_until=now()+interval '1 day',issue_open=true,schedule_review=true where id=current_setting('test.ops1.checkpoint')::uuid;
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.ok(exists(select 1 from jsonb_array_elements(public.ops_readiness_read(current_setting('test.ops1.account'))) v(x) where x->'booking'->>'id'=current_setting('test.ops1.booking')),'Deferred unresolved stay beyond seven days remains visible');
reset role;
select pg_temp.ok((select md5(to_jsonb(b)::text)=current_setting('test.ops1.manual_hash') from public.ops_bookings b where id=current_setting('test.ops1.manual')::uuid),'Manual-direct identity unchanged');

reset role;
select pg_temp.claims('{}');
-- Genuine completed September fixture, isolated by the generated source account.
select pg_temp.ok((now() at time zone 'Africa/Johannesburg')::date>date '2026-09-15','September fixture must be historical');
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,guest_name,source_observed_at)
values(current_setting('test.ops1.historical')::uuid,'production',current_setting('test.ops1.account'),900002,'legacy-suiderstrand',351452,724919,date '2026-09-05',date '2026-09-13','confirmed','airbnb','Synthetic historical readiness',clock_timestamp());
select pg_temp.ok((select count(*)=5 and bool_and(status='not_applicable' and historical_skip) from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.historical')::uuid),'Historical September enrollment skipped');
update public.ops_bookings set arrival=date '2026-09-06',departure=date '2026-09-14',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.historical')::uuid;
select pg_temp.ok((select bool_and(status='not_applicable' and historical_skip and not schedule_review) from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.historical')::uuid),'Past September correction remains skipped');
update public.ops_bookings set arrival=(now() at time zone 'Africa/Johannesburg')::date+3,departure=(now() at time zone 'Africa/Johannesburg')::date+7,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.historical')::uuid;
select pg_temp.ok((select bool_and(status='pending' and not historical_skip) from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.historical')::uuid),'Future/current window becomes actionable');
-- Use real response RPCs for completed and unresolved work, not fabricated statuses.
select set_config('test.ops1.main_booking',current_setting('test.ops1.booking'),true);
select set_config('test.ops1.main_checkpoint',current_setting('test.ops1.checkpoint'),true);
select set_config('test.ops1.booking',current_setting('test.ops1.historical'),true);
select set_config('test.ops1.checkpoint',(select id::text from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid and checkpoint_key='pre_arrival'),true);
set local role authenticated;
select pg_temp.claims(jsonb_build_object('role','authenticated','sub',current_setting('test.ops1.admin'),'session_id',current_setting('test.ops1.session'),'aal','aal2'));
select pg_temp.respond(pg_temp.issue('no'),'Synthetic unresolved past issue');
reset role;
select set_config('test.ops1.checkpoint',(select id::text from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid and checkpoint_key='final_arrival'),true);
set local role authenticated;
select pg_temp.respond(pg_temp.issue('yes'),'Synthetic completed evidence');
reset role;
create temp table historical_completed_before as select id,items,responded_at from public.ops_readiness_checkpoints where id=current_setting('test.ops1.checkpoint')::uuid;
select pg_temp.claims('{}');
update public.ops_bookings set arrival=date '2026-09-07',departure=date '2026-09-15',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select status='needs_attention' and issue_open and schedule_review and not historical_skip from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid and checkpoint_key='pre_arrival'),'Unresolved past work remains unresolved');
select pg_temp.ok((select c.status='complete' and c.items=b.items and c.responded_at=b.responded_at and c.schedule_review from public.ops_readiness_checkpoints c join historical_completed_before b using(id)),'Completed historical response remains complete');
update public.ops_bookings set source_status='cancelled',source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
update public.ops_bookings set arrival=(now() at time zone 'Africa/Johannesburg')::date+4,departure=(now() at time zone 'Africa/Johannesburg')::date+8,source_observed_at=clock_timestamp() where id=current_setting('test.ops1.booking')::uuid;
select pg_temp.ok((select bool_and(status in ('not_applicable','complete') and not source_eligible) from public.ops_readiness_checkpoints where booking_id=current_setting('test.ops1.booking')::uuid),'Cancelled historical stay cannot reactivate');
select set_config('test.ops1.booking',current_setting('test.ops1.main_booking'),true);
select set_config('test.ops1.checkpoint',current_setting('test.ops1.main_checkpoint'),true);
select pg_temp.ok(not exists(select 1 from baseline where t not in ('ops_bookings','ops_events') and t not like 'ops_readiness_%' and h<>pg_temp.fingerprint(t)),'No finance/payment/settlement/communication/normal-sync mutation');
rollback to savepoint synthetic_work;
select pg_temp.ok(not exists(select 1 from baseline where h<>pg_temp.fingerprint(t)),'All table contents restored after rollback');
select pg_temp.ok(not exists(select 1 from auth.users where id in (current_setting('test.ops1.admin')::uuid,current_setting('test.ops1.operator')::uuid,current_setting('test.ops1.finance')::uuid)),'No synthetic users remain');
select pg_temp.ok(not exists(select 1 from auth.sessions where id in (current_setting('test.ops1.session')::uuid,current_setting('test.ops1.other_session')::uuid,current_setting('test.ops1.operator_session')::uuid,current_setting('test.ops1.finance_session')::uuid,current_setting('test.ops1.nonstaff_session')::uuid)),'No synthetic sessions remain');
select pg_temp.ok(not exists(select 1 from public.ops_staff where user_id in (current_setting('test.ops1.admin')::uuid,current_setting('test.ops1.operator')::uuid,current_setting('test.ops1.finance')::uuid,current_setting('test.ops1.nonstaff')::uuid)),'No synthetic staff remain');
select pg_temp.ok(not exists(select 1 from auth.users where id=current_setting('test.ops1.nonstaff')::uuid),'No nonstaff fixture remains');
select 'OPS1 rollback checks passed; no fixture records remain' as result;
rollback;
