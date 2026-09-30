-- Isolated staging after 202609250001 ONLY. Entire fixture transaction rolls back.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception '%',label; end if; end $$;
insert into auth.users(id) values('b1000000-0000-0000-0000-000000000001');
insert into auth.sessions(id,user_id,created_at,updated_at) values('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',now(),now());
insert into public.ops_staff(user_id,display_name,role,is_active) values('b1000000-0000-0000-0000-000000000001','Nightly synthetic administrator','administrator',true);
insert into public.ops_properties values('nightly-fixture','Nightly fixture',999995001,999995002);
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_observed_at)
 values('b3000000-0000-0000-0000-000000000001','production','nightly-fixture',999995003,'nightly-fixture',999995001,999995002,'2026-09-05','2026-09-13','confirmed',now());
-- Preserve real and fixture ledger counts: rate decisions must not create cash/opening records.
select set_config('test.payments',(select count(*)::text from public.ops_payment_records),true);
select set_config('test.openings',(select count(*)::text from public.ops_stay_opening_positions),true);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"b1000000-0000-0000-0000-000000000001","session_id":"b2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('request.jwt.claim.sub','b1000000-0000-0000-0000-000000000001',true),set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.ok(public.ops_session_valid(),'Synthetic session invalid');
-- Exact reported amounts; synthetic identity only. Real helper and review writer.
select public.ops_finance_write('rate',jsonb_build_object('request_key',gen_random_uuid(),'property_slug','nightly-fixture','season','shoulder','starts_on','2026-09-05','ends_on','2026-09-13','rate_cents',350000,'reason','Synthetic September standard'));
select set_config('test.nights',public.ops_owner_nights('b3000000-0000-0000-0000-000000000001')::text,true);
select pg_temp.ok(jsonb_array_length(current_setting('test.nights')::jsonb)=8,'Expected eight occupied nights');
select pg_temp.ok((select bool_and(n->>'season'='shoulder' and (n->>'default_rate_cents')::bigint=350000 and (n->>'rate_cents')::bigint=350000) from jsonb_array_elements(current_setting('test.nights')::jsonb)n),'Shoulder default/agreed rate mismatch');
select set_config('test.review',jsonb_build_object('request_key',gen_random_uuid(),'previous_id',null,'booking_id','b3000000-0000-0000-0000-000000000001',
 'status','draft','accommodation_cents',5148000,'cleaning_charge_cents',117500,'channel_fees_cents',938576,'cleaner_cost_cents',80000,
 'cleaner_supplier','Synthetic cleaner','funds_received_cents',4326924,'funds_as_of','2026-09-11','expenses_complete',false,
 'funds_evidence','Synthetic Airbnb payout reference','reason','Initial reconciliation from synthetic payout statement',
 'owner_nights',current_setting('test.nights')::jsonb,'owner_rate_reason','')::text,true);
-- No exception swallowing: SQLSTATE 42703 or any other error aborts the test.
select set_config('test.review_id',public.ops_finance_write('review',current_setting('test.review')::jsonb)::text,true);
select pg_temp.ok((select count(*)=1 from public.ops_stay_financial_reviews where id=current_setting('test.review_id')::uuid),'Review did not persist');
select pg_temp.ok((select accommodation_cents=5148000 and cleaning_charge_cents=117500 and channel_fees_cents=938576 and cleaner_cost_cents=80000 and funds_received_cents=4326924 and not expenses_complete and status='draft' and created_by=auth.uid() from public.ops_stay_financial_reviews where id=current_setting('test.review_id')::uuid),'Stored values differ');
select pg_temp.ok((select sum((n->>'rate_cents')::bigint)=2800000 from public.ops_stay_financial_reviews f cross join lateral jsonb_array_elements(f.rate_nights)n where f.id=current_setting('test.review_id')::uuid),'Expected R28000 owner entitlement');
select pg_temp.ok(public.ops_finance_write('review',current_setting('test.review')::jsonb)::text=current_setting('test.review_id'),'Idempotent replay failed');
select pg_temp.ok((select count(*)=1 from public.ops_stay_financial_reviews where booking_id='b3000000-0000-0000-0000-000000000001'),'Retry duplicated review');
reset role;
select pg_temp.ok((select count(*) from public.ops_payment_records)=current_setting('test.payments')::bigint,'Unexpected payment');
select pg_temp.ok((select count(*) from public.ops_stay_opening_positions)=current_setting('test.openings')::bigint,'Unexpected opening or settlement');
rollback;
