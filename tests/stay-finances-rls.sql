-- ISOLATED STAGING ONLY, after all three migrations. Not run automatically.
-- Run with psql -v ON_ERROR_STOP=1. All fixtures roll back.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.denied(q text, expected text default 'permission denied|Financial MFA access required|Expense approval authority required|Request key already used|Duplicate expense reference|Append-only history|row-level security') returns void language plpgsql as $$
begin begin execute q; exception when others then if SQLERRM !~ expected then raise; end if; return; end; raise exception 'Expected denial: %',q; end $$;
insert into auth.users(id) values('93000000-0000-0000-0000-000000000001'),('93000000-0000-0000-0000-000000000002'),('93000000-0000-0000-0000-000000000003');
insert into auth.sessions(id,user_id,created_at,updated_at) select replace(id::text,'93000000','94000000')::uuid,id,now(),now() from auth.users where id::text like '93000000-%';
insert into public.ops_staff(user_id,display_name,role,is_active) values
 ('93000000-0000-0000-0000-000000000001','Finance fixture admin','administrator',true),
 ('93000000-0000-0000-0000-000000000002','Finance fixture operator','operations',true),
 ('93000000-0000-0000-0000-000000000003','Finance fixture finance','finance',true);
insert into public.ops_properties values('finance-fixture-property','Finance fixture property',999993001,999994001);
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_observed_at)
 values('95000000-0000-0000-0000-000000000001','production','finance-fixture',999990001,'finance-fixture-property',999993001,999994001,'2026-09-20','2026-09-22','new',now());
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"93000000-0000-0000-0000-000000000001","session_id":"94000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select public.ops_finance_write('rate','{"request_key":"96000000-0000-0000-0000-000000000001","property_slug":"finance-fixture-property","season":"low","starts_on":"2026-09-20","ends_on":"2026-09-22","rate_cents":400000,"reason":"Fixture agreement"}');
select set_config('test.expense','{"request_key":"96000000-0000-0000-0000-000000000002","booking_id":"95000000-0000-0000-0000-000000000001","incurred_on":"2026-09-20","category":"stocking","created_by":"93000000-0000-0000-0000-000000000002","description":"Fixture stocking","amount_cents":50000,"supplier":"Fixture supplier","supplier_reference":"INV-FIXTURE","payer":"bste","allocation":"owner","owner_amount_cents":50000,"status":"approved","reason":"Fixture approved"}',true);
select set_config('test.expense_id',public.ops_finance_write('expense',current_setting('test.expense')::jsonb)::text,true);
select pg_temp.ok(public.ops_finance_write('expense',current_setting('test.expense')::jsonb)::text=current_setting('test.expense_id'),'Retry duplicated expense');
select pg_temp.denied($q$select public.ops_finance_write('expense',jsonb_set(current_setting('test.expense')::jsonb,'{amount_cents}','60000'))$q$);
select pg_temp.denied($q$select public.ops_finance_write('expense',jsonb_set(current_setting('test.expense')::jsonb,'{request_key}','"96000000-0000-0000-0000-000000000099"'))$q$);
select pg_temp.ok((select created_by=auth.uid() and approved_by=auth.uid() from public.ops_stay_expenses where id=current_setting('test.expense_id')::uuid),'Actor attribution incorrect');
select public.ops_finance_write('review','{"request_key":"96000000-0000-0000-0000-000000000003","booking_id":"95000000-0000-0000-0000-000000000001","status":"reviewed","accommodation_cents":1000000,"channel_fees_cents":100000,"cleaner_supplier":"Fixture cleaner","funds_received_cents":0,"funds_as_of":"2026-09-22","reason":"Fixture review"}');
select pg_temp.ok((select jsonb_array_length(rate_nights)=2 and checkout_month='2026-09-01'::date from public.ops_stay_financial_reviews where booking_id='95000000-0000-0000-0000-000000000001'),'Nightly rates or checkout month wrong');
select public.ops_finance_write('opening','{"request_key":"96000000-0000-0000-0000-000000000004","booking_id":"95000000-0000-0000-0000-000000000001","state":"fully_settled_historical","confirmed_by_bond":true,"reason":"Bond confirmed settled fixture"}');
select pg_temp.ok(jsonb_array_length(public.ops_finance_history('95000000-0000-0000-0000-000000000001'))>=3,'Financial audit absent');
select pg_temp.denied('update public.ops_stay_expenses set amount_cents=1');
select pg_temp.denied('delete from public.ops_stay_financial_reviews');
-- Finance may prepare but not approve, configure rates or attest historical settlement.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"93000000-0000-0000-0000-000000000003","session_id":"94000000-0000-0000-0000-000000000003","aal":"aal2"}',true);
select pg_temp.ok((select count(*) from public.ops_stay_financial_reviews where booking_id='95000000-0000-0000-0000-000000000001')=1,'Finance cannot read');
select pg_temp.denied($q$select public.ops_finance_write('expense',jsonb_set(current_setting('test.expense')::jsonb,'{request_key}','"96000000-0000-0000-0000-000000000005"'))$q$);
select pg_temp.ok(jsonb_array_length(public.ops_finance_history('95000000-0000-0000-0000-000000000001'))>=3,'Finance scoped history unavailable');
select pg_temp.ok(not exists(select 1 from public.ops_events),'Finance can read unrestricted audit');
-- Valid Operations session cannot read or write any financial records.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"93000000-0000-0000-0000-000000000002","session_id":"94000000-0000-0000-0000-000000000002","aal":"aal1"}',true);
select pg_temp.ok(not exists(select 1 from public.ops_stay_financial_reviews),'Operations financial leak');
select pg_temp.ok(not exists(select 1 from public.ops_stay_expenses),'Operations expense leak');
select pg_temp.ok(not exists(select 1 from public.ops_expense_attachments),'Operations receipt metadata leak');
select pg_temp.denied($q$select public.ops_finance_write('expense',current_setting('test.expense')::jsonb)$q$);
select pg_temp.denied($q$select public.ops_finance_history('95000000-0000-0000-0000-000000000001')$q$);
-- Password-only administrator cannot bypass MFA through RPC or table access.
select set_config('request.jwt.claims','{"role":"authenticated","sub":"93000000-0000-0000-0000-000000000001","session_id":"94000000-0000-0000-0000-000000000001","aal":"aal1"}',true);
select pg_temp.ok(not exists(select 1 from public.ops_stay_financial_reviews),'AAL1 financial leak');
select pg_temp.denied($q$select public.ops_finance_write('expense',current_setting('test.expense')::jsonb)$q$);
set local role anon;
select pg_temp.denied($q$select public.ops_finance_history('95000000-0000-0000-0000-000000000001')$q$);
reset role;
rollback;
do $$ begin
 if exists(select 1 from auth.users where id='93000000-0000-0000-0000-000000000001')
 or exists(select 1 from public.ops_bookings where source_account='finance-fixture') then raise exception 'Fixture rollback failed'; end if;
end $$;
