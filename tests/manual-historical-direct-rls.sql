-- Isolated staging only, AFTER 202609260001. Run complete file; never commit.
-- The approved fixed record exists only within this rolled-back fixture.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.reject(q text) returns void language plpgsql as $$
begin begin execute q; exception when others then return; end; raise exception 'Expected rejection'; end $$;
create function pg_temp.claims(v jsonb) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claims',v::text,true);
 perform set_config('request.jwt.claim',v::text,true);
 perform set_config('request.jwt.claim.sub',coalesce(v->>'sub',''),true);
 perform set_config('request.jwt.claim.role',coalesce(v->>'role',''),true);
end $$;
select pg_temp.ok(not exists(select 1 from public.ops_bookings where manual_reference='BSTE-HIST-202609-KAL-01'),'Record already exists: do not run creation fixture');
create temp table direct_baseline as select id,to_jsonb(b) data from public.ops_bookings b;
create temp table money_baseline as select
 (select count(*) from public.ops_stay_opening_positions) openings,
 (select count(*) from public.ops_stay_financial_reviews) reviews,
 (select count(*) from public.ops_payment_records) payments;
insert into auth.users(id) values('d1000000-0000-0000-0000-000000000001');
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001',now(),now());
insert into public.ops_staff(user_id,display_name,role,is_active) values
 ('d1000000-0000-0000-0000-000000000001','Synthetic direct fixture administrator','administrator',true);
-- Freeze pre-existing overlaps so the fixture never edits them.
select set_config('test.direct.overlaps',coalesce((select array_agg(id order by id) from public.ops_bookings where property_slug='kalay-ridge-villa-struisbaai' and arrival<'2026-09-12' and departure>'2026-09-08'),'{}'::uuid[])::text,true);
set local role anon;
select pg_temp.claims('{"role":"anon"}');
select pg_temp.reject($q$select public.ops_create_charl_historical_direct('{}',true)$q$);
reset role;
set local role authenticated;
select pg_temp.claims('{"role":"authenticated","sub":"d1000000-0000-0000-0000-000000000001","session_id":"d2000000-0000-0000-0000-000000000001","aal":"aal1"}');
select pg_temp.reject($q$select public.ops_create_charl_historical_direct('{}',true)$q$);
select pg_temp.claims('{"role":"authenticated","sub":"d1000000-0000-0000-0000-000000000001","session_id":"d2000000-0000-0000-0000-000000000001","aal":"aal2"}');
select pg_temp.ok(public.ops_session_valid(),'Synthetic production session check');
select set_config('test.direct.id',public.ops_create_charl_historical_direct(current_setting('test.direct.overlaps')::uuid[],true)::text,true);
select pg_temp.ok(public.ops_create_charl_historical_direct(current_setting('test.direct.overlaps')::uuid[],true)::text=current_setting('test.direct.id'),'Idempotency');
select pg_temp.ok(exists(select 1 from public.ops_bookings where id=current_setting('test.direct.id')::uuid and source_kind='manual_direct' and beds24_booking_id is null and departure-arrival=4 and date_trunc('month',departure)='2026-09-01'::date),'Direct identity and September inclusion');
reset role;
create temp table direct_saved as select to_jsonb(b) data from public.ops_bookings b where id=current_setting('test.direct.id')::uuid;
-- One unique account per execution. Complete each run before starting the next:
-- ops_one_running_sync deliberately prohibits two concurrent runs for one account.
select set_config('test.direct.sync_account','direct-fixture-sync-'||gen_random_uuid()::text,true);
select set_config('test.direct.sync_one',gen_random_uuid()::text,true);
select set_config('test.direct.sync_two',gen_random_uuid()::text,true);
insert into public.ops_sync_runs(id,source_environment,source_account,initiated_by,status) values
 (current_setting('test.direct.sync_one')::uuid,'production',current_setting('test.direct.sync_account'),'d1000000-0000-0000-0000-000000000001','running');
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
-- Successful complete refreshes with no manual record in Beds24 must preserve it.
select public.ops_apply_sync(current_setting('test.direct.sync_one')::uuid,'[]');
reset role;
select pg_temp.ok(exists(select 1 from public.ops_sync_runs where id=current_setting('test.direct.sync_one')::uuid and status='succeeded'),'First sync completed before second starts');
insert into public.ops_sync_runs(id,source_environment,source_account,initiated_by,status) values
 (current_setting('test.direct.sync_two')::uuid,'production',current_setting('test.direct.sync_account'),'d1000000-0000-0000-0000-000000000001','running');
set local role service_role;
select pg_temp.claims('{"role":"service_role"}');
select public.ops_apply_sync(current_setting('test.direct.sync_two')::uuid,'[]');
select pg_temp.reject($q$select public.ops_sync_booking('{"source_kind":"manual_direct","source_account":"bste-historical-direct","beds24_booking_id":null}',null,current_setting('test.direct.sync_two')::uuid)$q$);
select pg_temp.reject($q$delete from public.ops_bookings where manual_reference='BSTE-HIST-202609-KAL-01'$q$);
reset role;
select pg_temp.ok((select to_jsonb(b) from public.ops_bookings b where id=current_setting('test.direct.id')::uuid)=(select data from direct_saved),'Manual record unchanged after repeated actual sync');
select pg_temp.ok(not exists(select 1 from direct_baseline x left join public.ops_bookings b using(id) where to_jsonb(b) is distinct from x.data),'Every previous booking unchanged');
select pg_temp.ok((select count(*) from public.ops_stay_opening_positions)=(select openings from money_baseline) and
 (select count(*) from public.ops_stay_financial_reviews)=(select reviews from money_baseline) and
 (select count(*) from public.ops_payment_records)=(select payments from money_baseline),'No opening, payment or financial review creation');
rollback;
select not exists(select 1 from auth.users where id='d1000000-0000-0000-0000-000000000001') as synthetic_user_rolled_back,
 not exists(select 1 from public.ops_bookings where manual_reference='BSTE-HIST-202609-KAL-01') as temporary_direct_booking_rolled_back;
