-- ISOLATED SUPABASE TEST DATABASE ONLY, after the reviewed migration.
-- Do not run against production. psql -v ON_ERROR_STOP=1 -f tests/operations-rls.sql
-- Requires a fresh test schema; all fixtures and test helpers roll back.
begin;
create function pg_temp.check_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%', message; end if; end $$;
create function pg_temp.rejects(statement text, expected text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if SQLERRM !~ expected then raise exception 'Unexpected error: %', SQLERRM; end if;
    return;
  end;
  raise exception 'Expected rejection: %', statement;
end $$;
insert into auth.users(id) values
 ('10000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000002'),
 ('10000000-0000-0000-0000-000000000003'),
 ('10000000-0000-0000-0000-000000000004');
insert into auth.sessions(id, user_id, created_at, updated_at) select
 ('30000000-0000-0000-0000-00000000000' || n)::uuid,
 ('10000000-0000-0000-0000-00000000000' || n)::uuid, now(), now()
 from generate_series(1,4) n;
insert into public.ops_staff(user_id, display_name, role, is_active) values
 ('10000000-0000-0000-0000-000000000001', 'Test Admin', 'administrator', true),
 ('10000000-0000-0000-0000-000000000002', 'Test Operator', 'operations', true),
 ('10000000-0000-0000-0000-000000000004', 'Test Finance', 'finance', true);

-- Initial service import, without any staff subject; returned UUID is reused.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('test.booking', public.ops_sync_booking('{
 "source_environment":"sandbox","source_account":"test-account","beds24_booking_id":1,
 "property_slug":"legacy-suiderstrand","beds24_property_id":351452,"beds24_room_id":724919,
 "arrival":"2030-01-10","departure":"2030-01-12","source_status":"new",
 "source_modified_at":"2026-09-18T08:00:00Z","source_observed_at":"2026-09-18T09:00:00Z"
}', '{"source_price":100,"source_currency":"ZAR","source_deposit":50,"source_invoice_items":[],
 "source_modified_at":"2026-09-18T08:00:00Z","source_observed_at":"2026-09-18T09:00:00Z"}',
 '40000000-0000-0000-0000-000000000001')::text, true);
select public.ops_ensure_system_task(current_setting('test.booking')::uuid, 'prep', 'Prepare', null,
 '40000000-0000-0000-0000-000000000001');
select pg_temp.check_true((select created_by is null and created_by_system = 'beds24_importer'
 from public.ops_tasks where task_key = 'prep'), 'Importer impersonated staff');
select pg_temp.check_true(exists(select 1 from public.ops_events where actor_name = 'system/beds24_importer'
 and actor_user_id is null and system_run_id = '40000000-0000-0000-0000-000000000001'), 'System audit missing');
select pg_temp.rejects('update public.ops_bookings set source_status = ''cancelled''', 'permission denied');

-- Anonymous role has neither table access nor privileged RPC access.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select pg_temp.rejects('select * from public.ops_bookings', 'permission denied');
select pg_temp.rejects('select * from public.ops_payment_records', 'permission denied');
select pg_temp.rejects('select public.ops_sync_booking(null,null,null)', 'permission denied');

-- Password-only administrator: zero operational/financial/audit access.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1","session_id":"30000000-0000-0000-0000-000000000001"}', true);
select pg_temp.check_true(not public.ops_can('operations.read'), 'Admin bypassed MFA');
select pg_temp.check_true(not exists(select 1 from public.ops_bookings), 'Admin AAL1 data leaked');
select pg_temp.check_true(not exists(select 1 from public.ops_payment_records), 'Admin AAL1 finance leaked');
select pg_temp.rejects('select public.ops_record_session(''application.session_started'')', 'MFA required');
-- Verified administrator; supplied actor UUID is overwritten.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2","session_id":"30000000-0000-0000-0000-000000000001"}', true);
select pg_temp.check_true(public.ops_can('arrangements.approve'), 'Admin grant missing');
insert into public.ops_payment_records(booking_id, entry_kind, review_status, note, created_by)
 values (current_setting('test.booking')::uuid, 'review', 'unknown', 'Review', '10000000-0000-0000-0000-000000000002');
select pg_temp.check_true((select created_by = auth.uid() from public.ops_payment_records limit 1), 'Actor spoof accepted');
insert into public.ops_payment_arrangements(booking_id, revised_deadline, reason, created_by, updated_by)
 values (current_setting('test.booking')::uuid, '2030-01-09', 'Arrangement', auth.uid(), auth.uid());
select public.ops_record_session('application.session_started');
select pg_temp.check_true(exists(select 1 from public.ops_events where action = 'application.session_started'
 and event_origin = 'application_report'), 'Application event wrongly classified');
select pg_temp.rejects('select public.ops_record_session(''provider.login'')', 'Invalid event');
select pg_temp.rejects('select public.ops_sync_booking(null,null,null)', 'permission denied');

-- Finance must use MFA and cannot approve arrangements or edit operations.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","aal":"aal1","session_id":"30000000-0000-0000-0000-000000000004"}', true);
select pg_temp.check_true(not public.ops_can('finance.write'), 'Finance bypassed MFA');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","aal":"aal2","session_id":"30000000-0000-0000-0000-000000000004"}', true);
select pg_temp.check_true(public.ops_can('finance.write') and not public.ops_can('arrangements.approve')
 and not public.ops_can('operations.write') and not public.ops_can('audit.read'), 'Finance limits broken');
select pg_temp.check_true(not exists(select 1 from public.ops_events), 'Finance audit leaked');
insert into public.ops_payment_records(booking_id, entry_kind, amount_cents, currency, payment_method,
 payment_date, evidence_reference, receipt_key, note, created_by)
 values (current_setting('test.booking')::uuid, 'receipt', 5000, 'ZAR', 'EFT', '2026-09-18', 'fixture', 'bank:receipt-1', 'Verified', auth.uid());
select pg_temp.rejects($s$insert into public.ops_payment_records(booking_id,entry_kind,amount_cents,currency,payment_method,payment_date,evidence_reference,receipt_key,note,created_by)
 values(current_setting('test.booking')::uuid,'receipt',5000,'ZAR','EFT','2026-09-18','fixture','bank:receipt-1','Duplicate',auth.uid())$s$, 'duplicate key');
select pg_temp.rejects($s$insert into public.ops_tasks(booking_id,task_key,title)
 values(current_setting('test.booking')::uuid,'forbidden','Forbidden')$s$, 'Named active staff required|row-level security');

-- Operations: normal work at AAL1, no finance/audit or self-promotion.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal1","session_id":"30000000-0000-0000-0000-000000000002"}', true);
select pg_temp.check_true(public.ops_can('operations.write'), 'Ops grant missing');
select pg_temp.check_true(not exists(select 1 from public.ops_payment_records)
 and not exists(select 1 from public.ops_booking_financial_snapshots)
 and not exists(select 1 from public.ops_payment_arrangements)
 and not exists(select 1 from public.ops_events), 'Operations financial/audit leak');
select pg_temp.rejects('update public.ops_staff set role = ''administrator''', 'permission denied');
select pg_temp.rejects($s$insert into public.ops_payment_records(booking_id,entry_kind,review_status,note,created_by)
 values(current_setting('test.booking')::uuid,'review','paid','Forbidden',auth.uid())$s$, 'Named active staff required|row-level security');
update public.ops_tasks set status = 'completed', updated_by = '10000000-0000-0000-0000-000000000001';
select pg_temp.check_true((select updated_by = auth.uid() and created_by is null
 and created_by_system = 'beds24_importer' and updated_by_system is null from public.ops_tasks limit 1), 'Task attribution failed');
select pg_temp.rejects('update public.ops_tasks set task_key = ''changed''', 'Stable task identity');
insert into public.ops_notes(booking_id, body, created_by) values(current_setting('test.booking')::uuid, 'Keep my note', auth.uid());
select pg_temp.rejects('delete from public.ops_notes', 'permission denied');

-- Repeat source synchronization and task creation cannot erase staff work.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('test.audit_count', (select count(*)::text from public.ops_events), true);
select pg_temp.check_true(public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T10:00:00Z"}'::jsonb from public.ops_bookings b where id=current_setting('test.booking')::uuid),
 (select to_jsonb(f) || '{"source_observed_at":"2026-09-18T10:00:00Z"}'::jsonb from public.ops_booking_financial_snapshots f where booking_id=current_setting('test.booking')::uuid),
 '40000000-0000-0000-0000-000000000002') = current_setting('test.booking')::uuid, 'Booking UUID changed');
select public.ops_ensure_system_task(current_setting('test.booking')::uuid, 'prep', 'Overwrite attempt', null,
 '40000000-0000-0000-0000-000000000002');
select pg_temp.check_true((select count(*) from public.ops_bookings) = 1, 'Duplicate booking');
select pg_temp.check_true((select count(*) from public.ops_events) = current_setting('test.audit_count')::bigint, 'Unchanged sync audit noise');
select pg_temp.check_true((select status='completed' and title='Prepare' from public.ops_tasks where task_key='prep'), 'Staff task overwritten');
select pg_temp.check_true((select count(*) from public.ops_notes) = 1 and
 (select count(*) from public.ops_payment_records) = 2 and
 (select count(*) from public.ops_payment_arrangements) = 1, 'Staff work lost');
select pg_temp.rejects($s$select public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T09:00:00Z"}' from public.ops_bookings b limit 1),null,
 '40000000-0000-0000-0000-000000000003')$s$, 'Stale source snapshot');
select pg_temp.rejects($s$select public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T11:00:00Z","source_modified_at":"2026-09-18T07:00:00Z"}' from public.ops_bookings b limit 1),null,
 '40000000-0000-0000-0000-000000000003')$s$, 'Stale source snapshot');
select pg_temp.rejects($s$select public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T11:00:00Z"}' from public.ops_bookings b limit 1),
 (select to_jsonb(f) from public.ops_booking_financial_snapshots f limit 1),
 '40000000-0000-0000-0000-000000000003')$s$, 'same source observation');
select pg_temp.rejects($s$select public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T11:00:00Z","source_modified_at":null}' from public.ops_bookings b limit 1),null,
 '40000000-0000-0000-0000-000000000003')$s$, 'Stale source snapshot');
select pg_temp.rejects($s$select public.ops_sync_booking(
 (select to_jsonb(b) || '{"source_observed_at":"2026-09-18T11:00:00Z","source_status":"cancelled"}' from public.ops_bookings b limit 1),null,
 '40000000-0000-0000-0000-000000000003')$s$, 'same source revision');
-- Another booking in the same account cannot reuse the same payment identifier.
select set_config('test.booking2', public.ops_sync_booking(
 (select to_jsonb(b) || '{"beds24_booking_id":2}' from public.ops_bookings b limit 1), null,
 '40000000-0000-0000-0000-000000000003')::text, true);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated","aal":"aal2","session_id":"30000000-0000-0000-0000-000000000004"}', true);
select pg_temp.rejects($s$insert into public.ops_payment_records(booking_id,entry_kind,amount_cents,currency,payment_method,payment_date,evidence_reference,receipt_key,note,created_by)
 values(current_setting('test.booking2')::uuid,'receipt',5000,'ZAR','EFT','2026-09-18','fixture','bank:receipt-1','Duplicate across bookings',auth.uid())$s$, 'duplicate key');

-- Privileged-owner tests prove immutable triggers and financial freshness guards.
reset role;
select set_config('request.jwt.claims', '{}', true);
select pg_temp.rejects('update public.ops_events set actor_name = ''Tampered''', 'Append-only history');
select pg_temp.rejects('delete from public.ops_events', 'Append-only history');
select pg_temp.rejects('update public.ops_payment_records set amount_cents = 1', 'Named active staff required|Append-only history');
select pg_temp.rejects('update public.ops_booking_financial_snapshots set source_observed_at = ''2026-09-18T07:00:00Z''', 'Stale financial snapshot');
select pg_temp.rejects('update public.ops_booking_financial_snapshots set source_modified_at = ''2026-09-18T07:00:00Z''', 'Stale financial snapshot');
select pg_temp.rejects('update public.ops_booking_financial_snapshots set source_price = 1', 'Conflicting financial snapshot');
-- Newly granted sensitive authority automatically makes Operations require MFA.
insert into public.ops_role_permissions values ('operations','refunds.authorize');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal1","session_id":"30000000-0000-0000-0000-000000000002"}', true);
select pg_temp.check_true(not public.ops_can('operations.read'), 'New privileged permission bypassed MFA');
-- Unprovisioned Auth user has no access.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated","aal":"aal2","session_id":"30000000-0000-0000-0000-000000000003"}', true);
select pg_temp.check_true(not exists(select 1 from public.ops_bookings), 'Unprovisioned access');
-- Provider logout removes session: even the old AAL2 token loses data access.
reset role;
select set_config('request.jwt.claims', '{}', true);
delete from auth.sessions where id='30000000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2","session_id":"30000000-0000-0000-0000-000000000001"}', true);
select pg_temp.check_true(not public.ops_can('operations.read'), 'Terminated session still authorized');
rollback;
