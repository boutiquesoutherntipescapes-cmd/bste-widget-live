-- Isolated Supabase staging only, after all migrations, psql -v ON_ERROR_STOP=1.
-- NOT executed by local Node tests. Entire fixture transaction rolls back.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.reject(q text,pattern text) returns void language plpgsql as $$
begin begin execute q; exception when others then if SQLERRM !~ pattern then raise; end if;return;end;raise exception 'Expected denial: %',q;end $$;
insert into auth.users(id) values('a1000000-0000-0000-0000-000000000001'),('a1000000-0000-0000-0000-000000000002');
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',now(),now()),
 ('a2000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000002',now(),now());
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
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('test.items',jsonb_build_array(jsonb_build_object('snapshot',jsonb_build_object(
 'source_environment','production','source_account','history-test','beds24_booking_id',999981001,
 'property_slug','legacy-suiderstrand','beds24_property_id',351452,'beds24_room_id',724919,
 'arrival','2026-09-20','departure','2026-09-23','source_status','confirmed','source_observed_at',clock_timestamp()),
 'financial',null,'raw',jsonb_build_object('id',999981001,'deposit',500),'expected_id',null,'expected_last_synced_at',null,'settle',true))::text,true);
select set_config('test.batch',public.ops_stage_historical_batch('history-test',repeat('a',64),current_setting('test.items')::jsonb,'Bond confirmed fixture settled',true)::text,true);
select pg_temp.ok(public.ops_stage_historical_batch('history-test',repeat('a',64),current_setting('test.items')::jsonb,'Bond confirmed fixture settled',true)::text=current_setting('test.batch'),'Duplicate staged batch');
select pg_temp.reject($q$select public.ops_apply_historical_batch(current_setting('test.batch')::uuid)$q$,'permission denied');
-- Exception statuses can be retained as source records, but not batch-settled.
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('b',64),jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_status}','"request"'),'Bond fixture',true)$q$,'Exceptional reservation');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('b',64),jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_status}','"black"'),'Bond fixture',true)$q$,'Exceptional reservation');
select pg_temp.reject($q$select public.ops_stage_historical_batch('history-test',repeat('b',64),jsonb_set(current_setting('test.items')::jsonb,'{0,snapshot,source_status}','"cancelled"'),'Bond fixture',true)$q$,'Exceptional reservation');
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.ops_apply_historical_batch(current_setting('test.batch')::uuid);
select public.ops_apply_historical_batch(current_setting('test.batch')::uuid);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('test.booking',(select id::text from public.ops_bookings where source_account='history-test' and beds24_booking_id=999981001),true);
select pg_temp.ok((select count(*) from public.ops_bookings where source_account='history-test' and beds24_booking_id=999981001)=1,'Duplicated booking');
select pg_temp.ok((select count(*) from public.ops_stay_opening_positions where booking_id=current_setting('test.booking')::uuid)=1,'Duplicated settlement');
select pg_temp.ok((select state from public.ops_stay_opening_positions where booking_id=current_setting('test.booking')::uuid)='fully_settled_historical','Explicit settlement selection not retained');
-- Expense and optional JPG/PNG/PDF receipt metadata remain writable after settlement.
select set_config('test.expense',public.ops_finance_write('expense',jsonb_build_object('request_key',gen_random_uuid(),'booking_id',current_setting('test.booking'),
 'incurred_on','2026-09-23','category','laundry','supplier','Fixture laundry','description','Late historical receipt','amount_cents',30000,
 'payer','bste','allocation','owner','owner_amount_cents',30000,'status','approved','reason','Historical evidence'))::text,true);
do $$ declare mime text; begin
 foreach mime in array array['image/jpeg','image/png','application/pdf'] loop
 perform public.ops_finance_write('attachment',jsonb_build_object('request_key',gen_random_uuid(),'expense_id',current_setting('test.expense'),
 'original_name','fixture','media_type',mime,'size_bytes',100,'sha256',repeat('c',64)));
 end loop;
end $$;
select pg_temp.ok((select count(*) from public.ops_stay_opening_positions where booking_id=current_setting('test.booking')::uuid)=1,'Expense or receipt reopened stay');
select set_config('test.opening',(select id::text from public.ops_stay_opening_positions where booking_id=current_setting('test.booking')::uuid),true);
-- Finance cannot reopen. The administrator can append an audited reopening.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000002","session_id":"a2000000-0000-0000-0000-000000000002","aal":"aal2"}',true);
select pg_temp.reject($q$select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id',current_setting('test.booking'),'previous_id',current_setting('test.opening'),'state','open','reason','Not authorized'))$q$,'Cutover authority');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id',current_setting('test.booking'),'previous_id',current_setting('test.opening'),'state','open','reason','Administrator explicit reopening'));
-- Seed a financial revision as existing staff work; importer must never replace it.
reset role;
select set_config('request.jwt.claims','{}',true);
insert into public.ops_stay_financial_reviews(booking_id,request_key,status,accommodation_cents,channel_fees_cents,cleaner_supplier,funds_received_cents,funds_as_of,reason,source_basis,rate_nights,checkout_month,created_by)
 values(current_setting('test.booking')::uuid,gen_random_uuid(),'draft',1230000,0,'Historical cleaner',0,'2026-09-23','Preserve staff review','{}','[]','2026-09-01','a1000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
-- A newly previewed rerun must retain that reopening and all expense/receipt history.
select set_config('test.items',jsonb_set(jsonb_set(jsonb_set(current_setting('test.items')::jsonb,'{0,expected_id}',to_jsonb(current_setting('test.booking'))),
 '{0,expected_last_synced_at}',(select to_jsonb(last_synced_at) from public.ops_bookings where id=current_setting('test.booking')::uuid)),
 '{0,snapshot,source_observed_at}',to_jsonb(clock_timestamp()))::text,true);
select set_config('test.batch2',public.ops_stage_historical_batch('history-test',repeat('d',64),current_setting('test.items')::jsonb,'Bond rerun fixture',true)::text,true);
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.ops_apply_historical_batch(current_setting('test.batch2')::uuid);
reset role;
select set_config('request.jwt.claims','{}',true);
select pg_temp.ok((select state from public.ops_stay_opening_positions where booking_id=current_setting('test.booking')::uuid order by created_at desc limit 1)='open','Rerun overwrote reopening');
select pg_temp.ok((select count(*) from public.ops_stay_expenses where booking_id=current_setting('test.booking')::uuid)=1,'Expense duplicated/lost');
select pg_temp.ok((select count(*) from public.ops_expense_attachments where expense_id=current_setting('test.expense')::uuid)=3,'Receipt duplicated/lost');
select pg_temp.ok((select count(*)=1 and min(accommodation_cents)=1230000 from public.ops_stay_financial_reviews where booking_id=current_setting('test.booking')::uuid),'Financial review overwritten or duplicated');
select pg_temp.ok((select count(*) from public.ops_sync_runs where source_account='history-test')=1,'Historical run contaminated normal health');
select pg_temp.ok((select count(*) from public.ops_sync_members where run_id='a3000000-0000-0000-0000-000000000001')=1,'Normal membership changed');
select pg_temp.ok(not exists(select 1 from public.ops_communications where booking_id=current_setting('test.booking')::uuid),'Communications created');
select pg_temp.ok(not exists(select 1 from public.ops_payment_records where booking_id=current_setting('test.booking')::uuid),'Payment created from deposit');
select pg_temp.ok((select automation_enrolled_at is null from public.ops_bookings where id=current_setting('test.booking')::uuid),'Communication enrollment created');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select pg_temp.ok(exists(select 1 from jsonb_array_elements(public.ops_dashboard_rows('history-test')) r
 where r->>'id'='a4000000-0000-0000-0000-000000000099' and r->>'not_seen_in_latest_sync'='false'),'Current booking falsely marked missing');
reset role;
select set_config('request.jwt.claims','{}',true);
-- Check exact cutover boundaries in the actual write function, not only JS.
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_observed_at)
 values('a4000000-0000-0000-0000-000000000022','production','history-test',999981022,'legacy-suiderstrand',351452,724919,'2026-09-20','2026-09-22','confirmed',now()),
 ('a4000000-0000-0000-0000-000000000024','production','history-test',999981024,'legacy-suiderstrand',351452,724919,'2026-09-20','2026-09-24','confirmed',now());
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1000000-0000-0000-0000-000000000001","session_id":"a2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id','a4000000-0000-0000-0000-000000000022','state','fully_settled_historical','confirmed_by_bond',true,'reason','Bond cutoff boundary'));
select pg_temp.reject($q$select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id','a4000000-0000-0000-0000-000000000024','state','fully_settled_historical','confirmed_by_bond',true,'reason','Boundary denial'))$q$,'checkout on or before 2026-09-23');
-- Explicit opening-period designation does not mean owner/cleaner paid.
select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id','a4000000-0000-0000-0000-000000000022',
 'previous_id',(select id from public.ops_stay_opening_positions where booking_id='a4000000-0000-0000-0000-000000000022' order by created_at desc limit 1),
 'state','open','opening_period',true,'owner_settlement_state','outstanding','cleaner_settlement_state','outstanding','reason','Opening period; channel funds do not pay owner or cleaner'));
select pg_temp.ok((select opening_period and owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding' and state='open'
 from public.ops_stay_opening_positions where booking_id='a4000000-0000-0000-0000-000000000022' order by created_at desc limit 1),'Opening period silently settled obligations');
select pg_temp.reject($q$select public.ops_finance_write('opening',jsonb_build_object('request_key',gen_random_uuid(),'booking_id','a4000000-0000-0000-0000-000000000024','opening_period',true,'state','open','reason','After opening cutoff'))$q$,'Opening-period eligibility');
reset role;
rollback;
do $$ begin
 if exists(select 1 from public.ops_bookings where source_account='history-test') or exists(select 1 from public.ops_historical_batches where source_account='history-test')
 or exists(select 1 from auth.users where id='a1000000-0000-0000-0000-000000000001') then raise exception 'Historical fixtures not rolled back'; end if;
end $$;
