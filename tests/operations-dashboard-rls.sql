-- ISOLATED STAGING ONLY after BOTH migrations. Not executed by the coding task.
-- psql -v ON_ERROR_STOP=1 -f tests/operations-dashboard-rls.sql
-- Fail before creating fixtures if these reserved test identities already exist.
-- Run using a trusted test-database owner, never against production.
do $$ begin
 if exists(select 1 from auth.users where id in (
  '91000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000003'))
  or exists(select 1 from public.ops_bookings where source_account='dashboard-test')
  or exists(select 1 from public.ops_sync_runs where source_account='dashboard-test') then
  raise exception 'Reserved dashboard test fixtures already exist; investigate before running';
 end if;
end $$;
begin;
create function pg_temp.assert_ok(value boolean, label text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.rejects(statement text, expected text) returns void language plpgsql as $$
begin
 begin execute statement;
 exception when others then if SQLERRM !~ expected then raise; end if; return; end;
 raise exception 'Expected rejection: %',statement;
end $$;
insert into auth.users(id) values ('91000000-0000-0000-0000-000000000001'),('91000000-0000-0000-0000-000000000002'),('91000000-0000-0000-0000-000000000003');
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001',now(),now()),
 ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000002',now(),now()),
 ('92000000-0000-0000-0000-000000000003','91000000-0000-0000-0000-000000000003',now(),now());
insert into public.ops_staff(user_id,display_name,role,is_active) values
 ('91000000-0000-0000-0000-000000000001','Dashboard Test Admin','administrator',true),
 ('91000000-0000-0000-0000-000000000002','Dashboard Test Operator','operations',true),
 ('91000000-0000-0000-0000-000000000003','Dashboard Test Finance','finance',true);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal1"}',true);
select pg_temp.rejects('select public.ops_begin_sync(''dashboard-test'')','Sync permission required');
select pg_temp.rejects('select public.ops_dashboard_rows(''dashboard-test'')','Staff access required');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('test.run',public.ops_begin_sync('dashboard-test')::text,true);
select pg_temp.rejects('select public.ops_begin_sync(''dashboard-test'')','duplicate key');
-- Raw request booking; source deposit does not become a manual payment review.
select set_config('test.items',jsonb_build_array(jsonb_build_object(
 'snapshot',jsonb_build_object('source_environment','production','source_account','dashboard-test','beds24_booking_id',900000001,
 'property_slug','legacy-suiderstrand','beds24_property_id',351452,'beds24_room_id',724919,
 'arrival',current_date,'departure',current_date+3,'source_status','request','source_modified_at',null,'source_observed_at',clock_timestamp()),
 'financial',null,'raw',jsonb_build_object('id',900000001,'deposit',500)))::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- Keep raw deposit and restricted financial deposit without creating a receipt.
select set_config('test.items',jsonb_set(current_setting('test.items')::jsonb,'{0,financial}',
 jsonb_build_object('source_price',1000,'source_currency','ZAR','source_deposit',500,'source_invoice_items','[]'::jsonb,
 'source_modified_at',null,'source_observed_at',current_setting('test.items')::jsonb->0->'snapshot'->'source_observed_at'))::text,true);
select public.ops_apply_sync(current_setting('test.run')::uuid,current_setting('test.items')::jsonb);
reset role;
select set_config('test.booking',(select id::text from public.ops_bookings where source_account='dashboard-test'),true);
select pg_temp.assert_ok(not exists(select 1 from public.ops_payment_records where booking_id=current_setting('test.booking')::uuid),'Source deposit inferred as payment');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
insert into public.ops_booking_overrides(booking_id,operational_status,reason,created_by)
 values(current_setting('test.booking')::uuid,'confirmed','Confirmed independently','91000000-0000-0000-0000-000000000002');
insert into public.ops_payment_records(booking_id,entry_kind,review_status,note,created_by)
 values(current_setting('test.booking')::uuid,'review','deposit_paid','Verified evidence fixture',auth.uid());
insert into public.ops_notes(booking_id,body,created_by) values(current_setting('test.booking')::uuid,'Keep note',auth.uid());
insert into public.ops_tasks(booking_id,task_key,title,status) values(current_setting('test.booking')::uuid,'prep','Keep task','completed');
insert into public.ops_payment_arrangements(booking_id,revised_deadline,reason,created_by,updated_by)
 values(current_setting('test.booking')::uuid,now()+interval '1 day','Keep arrangement',auth.uid(),auth.uid());
select pg_temp.assert_ok((select created_by=auth.uid() from public.ops_booking_overrides where booking_id=current_setting('test.booking')::uuid),'Actor spoofing');
select set_config('test.audit',(select count(*)::text from public.ops_events where booking_id=current_setting('test.booking')::uuid),true);
select set_config('test.run',public.ops_begin_sync('dashboard-test')::text,true);
select set_config('test.items',jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_observed_at}',to_jsonb(clock_timestamp()))::text,true);
select set_config('test.items',jsonb_set(current_setting('test.items')::jsonb,'{0,financial,source_observed_at}',
 current_setting('test.items')::jsonb->0->'snapshot'->'source_observed_at')::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.ops_apply_sync(current_setting('test.run')::uuid,current_setting('test.items')::jsonb);
reset role;
select pg_temp.assert_ok((select count(*) from public.ops_bookings where source_account='dashboard-test')=1,'Duplicate booking');
select pg_temp.assert_ok((select count(*) from public.ops_events where booking_id=current_setting('test.booking')::uuid)=current_setting('test.audit')::bigint,'Unchanged booking audit noise');
select pg_temp.assert_ok((select count(*) from public.ops_notes where booking_id=current_setting('test.booking')::uuid)=1,'Note lost');
select pg_temp.assert_ok((select status from public.ops_tasks where booking_id=current_setting('test.booking')::uuid)='completed','Task overwritten');
select pg_temp.assert_ok((select count(*) from public.ops_payment_arrangements where booking_id=current_setting('test.booking')::uuid)=1,'Arrangement lost');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'source_status'='request','Raw status overwritten');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'operational_status'='confirmed','Operational override lost');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'payment_status'='deposit_paid','Payment review lost');
select set_config('test.run',public.ops_begin_sync('dashboard-test')::text,true);
-- Batch with duplicate source identities must roll back both source writes.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.rejects($s$select public.ops_apply_sync(current_setting('test.run')::uuid,
 current_setting('test.items')::jsonb || current_setting('test.items')::jsonb)$s$,'duplicate key');
select public.ops_fail_sync(current_setting('test.run')::uuid,'storage_failed');
-- Stale observation in a later run is rejected, not accepted as a newer snapshot.
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('test.run',public.ops_begin_sync('dashboard-test')::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.rejects($s$select public.ops_apply_sync(current_setting('test.run')::uuid,
 jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_observed_at}',to_jsonb(clock_timestamp()-interval '1 day')))$s$,'Wrong import scope|Stale source');
select public.ops_fail_sync(current_setting('test.run')::uuid,'storage_failed');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000002","session_id":"92000000-0000-0000-0000-000000000002","aal":"aal1"}',true);
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'payment_status' is null,'Finance leaked to Operations');
select pg_temp.assert_ok(not exists(select 1 from public.ops_beds24_raw_snapshots),'Raw financial payload leaked');
select pg_temp.rejects('insert into public.ops_stay_expenses default values','permission denied');
select pg_temp.rejects('update public.ops_booking_overrides set operational_status=''checked_out''','permission denied');
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.rejects('select public.ops_dashboard_rows(''dashboard-test'')','permission denied');
reset role;
select set_config('request.jwt.claims','{}',true);
select pg_temp.rejects('delete from public.ops_booking_overrides','Append-only history');

-- Successful empty refresh retains the booking and exposes absence, not cancellation.
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('test.absent_run',public.ops_begin_sync('dashboard-test')::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.ops_apply_sync(current_setting('test.absent_run')::uuid,'[]'::jsonb);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select pg_temp.assert_ok(jsonb_array_length(public.ops_dashboard_rows('dashboard-test'))=1,'Absent booking deleted from dashboard');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'not_seen_in_latest_sync'='true','Absent booking warning missing');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'source_status'='request','Absent booking cancelled or source status altered');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'operational_status'='confirmed','Absent booking override changed');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'payment_status'='deposit_paid','Absent booking review changed');
select pg_temp.assert_ok((select imported_count=0 and property_counts='{"legacy-suiderstrand":0,"kalay-ridge-villa-struisbaai":0,"the-pearl-beach-villa-agulhas":0}'::jsonb
 from public.ops_sync_runs where id=current_setting('test.absent_run')::uuid),'Empty run counts wrong');
select pg_temp.assert_ok(not exists(select 1 from public.ops_sync_members where run_id=current_setting('test.absent_run')::uuid),'Empty run has members');

-- Reappearance naturally clears the warning, with the same UUID and staff work.
select set_config('test.reappeared_run',public.ops_begin_sync('dashboard-test')::text,true);
select set_config('test.items',jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_observed_at}',to_jsonb(clock_timestamp()))::text,true);
select set_config('test.items',jsonb_set(current_setting('test.items')::jsonb,'{0,financial,source_observed_at}',
 current_setting('test.items')::jsonb->0->'snapshot'->'source_observed_at')::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.ops_apply_sync(current_setting('test.reappeared_run')::uuid,current_setting('test.items')::jsonb);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000001","session_id":"92000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'not_seen_in_latest_sync'='false','Reappearance warning not cleared');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'id'=current_setting('test.booking'),'Reappearance created another booking');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'operational_status'='confirmed','Override lost on reappearance');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'payment_status'='deposit_paid','Payment review lost on reappearance');
select pg_temp.assert_ok((select count(*) from public.ops_payment_records where booking_id=current_setting('test.booking')::uuid)=1,'Source deposit created another payment record');
select pg_temp.assert_ok((select count(*) from public.ops_booking_overrides where booking_id=current_setting('test.booking')::uuid)=1,'Sync duplicated overrides');
select pg_temp.assert_ok((select source_deposit='500'::jsonb from public.ops_booking_financial_snapshots where booking_id=current_setting('test.booking')::uuid),'Raw financial deposit lost');
select pg_temp.assert_ok((select count(*) from public.ops_events where booking_id=current_setting('test.booking')::uuid)=current_setting('test.audit')::bigint,'Reappearance produced unchanged-booking audit noise');
select pg_temp.assert_ok(not exists(
 select 1 from public.ops_sync_runs r where r.source_account='dashboard-test' and
  (r.imported_count<>(select count(*) from public.ops_sync_members m where m.run_id=r.id)
   or (r.status='succeeded' and r.property_counts<>jsonb_build_object(
      'legacy-suiderstrand',r.imported_count,'kalay-ridge-villa-struisbaai',0,'the-pearl-beach-villa-agulhas',0)))
 ),'Run counts differ from unique membership');
select pg_temp.assert_ok(not exists(select m.run_id,m.booking_id from public.ops_sync_members m
 join public.ops_sync_runs r on r.id=m.run_id where r.source_account='dashboard-test'
 group by m.run_id,m.booking_id having count(*)<>1),'Duplicate run membership');
select pg_temp.assert_ok((select count(*) from public.ops_bookings where source_account='dashboard-test')=1,'Multiple source booking records');

-- Matrix: named Admin/Operations/Finance with valid sessions, including MFA where
-- required. Both grants and actual commands are tested; a zero-row update is not
-- accepted as proof of denial. Helpers run with caller privileges, not DEFINER.
do $$
declare actor text; t text; column_name text;
begin
 foreach actor in array array['001','002','003'] loop
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated',
    'sub','91000000-0000-0000-0000-000000000'||actor,
    'session_id','92000000-0000-0000-0000-000000000'||actor,
    'aal',case when actor='002' then 'aal1' else 'aal2' end)::text,true);
  perform pg_temp.assert_ok(public.ops_can('operations.read'),'Matrix fixture is not an active staff session');
  if actor in ('001','003') then
    perform pg_temp.assert_ok(public.ops_can('finance.read'),'Financial fixture missing verified financial access');
  end if;
  foreach t in array array['ops_sync_runs','ops_sync_members','ops_beds24_raw_snapshots',
    'ops_stay_expenses','ops_month_reconciliations','ops_owner_statement_snapshots','ops_owner_statement_adjustments'] loop
   perform pg_temp.assert_ok(not has_table_privilege(current_user,'public.'||t,'INSERT')
    and not has_table_privilege(current_user,'public.'||t,'UPDATE')
    and not has_table_privilege(current_user,'public.'||t,'DELETE'),'Unexpected table write grant: '||t);
   column_name := case t when 'ops_sync_members' then 'run_id' when 'ops_beds24_raw_snapshots' then 'booking_id' else 'id' end;
   perform pg_temp.rejects(format('insert into public.%I default values',t),'permission denied');
   perform pg_temp.rejects(format('update public.%I set %I=%I',t,column_name,column_name),'permission denied');
   perform pg_temp.rejects(format('delete from public.%I',t),'permission denied');
  end loop;
  perform pg_temp.rejects('select public.ops_apply_sync(null,''[]''::jsonb)','permission denied');
  perform pg_temp.rejects('select public.ops_fail_sync(null,''storage_failed'')','permission denied');
  if actor='001' then
   perform pg_temp.assert_ok(exists(select 1 from public.ops_beds24_raw_snapshots
    where booking_id=current_setting('test.booking')::uuid and payload->>'deposit'='500'),'Admin cannot read expected audit payload');
  else
   perform pg_temp.assert_ok(not exists(select 1 from public.ops_beds24_raw_snapshots
    where booking_id=current_setting('test.booking')::uuid),'Raw payload leaked to non-audit role');
   perform pg_temp.rejects('select public.ops_begin_sync(''dashboard-test'')','Sync permission required');
  end if;
 end loop;
end $$;

-- Operations may change an operational review, never the Beds24 source snapshot.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"91000000-0000-0000-0000-000000000002","session_id":"92000000-0000-0000-0000-000000000002","aal":"aal1"}',true);
select pg_temp.rejects('update public.ops_bookings set source_status=''cancelled'' where id=current_setting(''test.booking'')::uuid','permission denied');
select pg_temp.rejects('select public.ops_sync_booking(null,null,null)','permission denied');
insert into public.ops_booking_overrides(booking_id,operational_status,reason,created_by)
 values(current_setting('test.booking')::uuid,'checked_in','Operational-only check-in fixture',auth.uid());
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'operational_status'='checked_in','Operational review failed');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'source_status'='request','Operational review overwrote Beds24 status');
select pg_temp.rejects($s$insert into public.ops_payment_records(booking_id,entry_kind,review_status,note,created_by)
 values(current_setting('test.booking')::uuid,'review','deposit_paid','Forbidden Operations payment review',auth.uid())$s$,'Named active staff required|row-level security|permission denied');
select pg_temp.assert_ok(public.ops_dashboard_rows('dashboard-test')->0->>'source_status'='request','Rejected financial review changed source');

-- Verify actual function ACLs, including PUBLIC default execution, not just a
-- successful internal role check. Database owners remain trusted administrators.
reset role;
select set_config('request.jwt.claims','{}',true);
do $$ declare f text; importer boolean; begin
 foreach f in array array['public.ops_begin_sync(text)','public.ops_dashboard_rows(text)',
   'public.ops_apply_sync(uuid,jsonb)','public.ops_fail_sync(uuid,text)'] loop
  importer := f in ('public.ops_apply_sync(uuid,jsonb)','public.ops_fail_sync(uuid,text)');
  perform pg_temp.assert_ok(not has_function_privilege('anon',f,'EXECUTE'),'Anonymous RPC execution grant: '||f);
  perform pg_temp.assert_ok(has_function_privilege('authenticated',f,'EXECUTE')=(not importer),'Wrong authenticated RPC grant: '||f);
  perform pg_temp.assert_ok(has_function_privilege('service_role',f,'EXECUTE')=importer,'Wrong importer RPC grant: '||f);
  perform pg_temp.assert_ok(not exists(select 1 from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=f::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC RPC execution grant: '||f);
 end loop;
end $$;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.rejects('select public.ops_begin_sync(''dashboard-test'')','permission denied');
select pg_temp.rejects('select public.ops_apply_sync(null,''[]''::jsonb)','permission denied');
select pg_temp.rejects('select public.ops_fail_sync(null,''storage_failed'')','permission denied');
reset role;
select set_config('request.jwt.claims','{}',true);
rollback;

-- This check is deliberately OUTSIDE the rolled-back fixture transaction.
-- It runs only if all previous assertions passed under ON_ERROR_STOP.
do $$ begin
 if exists(select 1 from auth.users where id in (
  '91000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000003'))
  or exists(select 1 from auth.sessions where id in (
  '92000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000002','92000000-0000-0000-0000-000000000003'))
  or exists(select 1 from public.ops_staff where display_name in ('Dashboard Test Admin','Dashboard Test Operator','Dashboard Test Finance'))
  or exists(select 1 from public.ops_bookings where source_account='dashboard-test')
  or exists(select 1 from public.ops_sync_runs where source_account='dashboard-test')
  or exists(select 1 from public.ops_beds24_raw_snapshots where payload->>'id'='900000001')
  or exists(select 1 from public.ops_events where actor_user_id in (
  '91000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000003')) then
  raise exception 'Dashboard fixtures did not roll back completely';
 end if;
 -- Booking-linked records/members have non-null foreign keys: none can survive
 -- when the test booking and sync runs have rolled back. Sequence gaps are normal.
end $$;