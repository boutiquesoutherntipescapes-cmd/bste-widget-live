-- Isolated staging after 202609250001 ONLY. Entire fixture transaction rolls back.
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$ begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.reject(q text) returns void language plpgsql as $$ begin begin execute q; exception when others then return; end; raise exception 'Expected rejection'; end $$;
insert into auth.users(id) values('b1000000-0000-0000-0000-000000000001');
insert into auth.sessions(id,user_id,created_at,updated_at) values('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001',now(),now());
insert into public.ops_staff(user_id,display_name,role,is_active) values('b1000000-0000-0000-0000-000000000001','Nightly synthetic administrator','administrator',true);
insert into public.ops_properties values('nightly-fixture','Nightly fixture',999995001,999995002);
insert into public.ops_bookings(id,source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_observed_at)
 values('b3000000-0000-0000-0000-000000000001','production','nightly-fixture',999995003,'nightly-fixture',999995001,999995002,'2026-09-05','2026-09-08','confirmed',now());
-- Preserve real and fixture ledger counts: rate decisions must not create cash/opening records.
select set_config('test.payments',(select count(*)::text from public.ops_payment_records),true);
select set_config('test.openings',(select count(*)::text from public.ops_stay_opening_positions),true);
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"b1000000-0000-0000-0000-000000000001","session_id":"b2000000-0000-0000-0000-000000000001","aal":"aal2"}',true);
select set_config('request.jwt.claim.sub','b1000000-0000-0000-0000-000000000001',true),set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.ok(public.ops_session_valid(),'Synthetic session invalid');
select public.ops_finance_write('rate',jsonb_build_object('request_key',gen_random_uuid(),'property_slug','nightly-fixture','season',s,'starts_on',d,'ends_on',d+1,'rate_cents',c,'reason','Fixture standard'))
 from (values('low','2026-09-05'::date,500000),('shoulder','2026-09-06'::date,650000),('high','2026-09-07'::date,800000)) x(s,d,c);
select set_config('test.nights',public.ops_owner_nights('b3000000-0000-0000-0000-000000000001')::text,true);
select pg_temp.ok((current_setting('test.nights')::jsonb->1->>'season')='shoulder','Shoulder default missing');
select pg_temp.ok((select sum((n->>'rate_cents')::bigint)=1950000 from jsonb_array_elements(current_setting('test.nights')::jsonb)n),'Cross-season defaults wrong');
select set_config('test.review',jsonb_build_object('request_key',gen_random_uuid(),'booking_id','b3000000-0000-0000-0000-000000000001','status','reviewed','accommodation_cents',3000000,'cleaning_charge_cents',100000,'channel_fees_cents',0,'cleaner_cost_cents',80000,'cleaner_supplier','Fixture cleaner','funds_received_cents',0,'funds_as_of','2026-09-08','reason','Nightly fixture','owner_nights',jsonb_set(current_setting('test.nights')::jsonb,'{1,rate_cents}','700000'))::text,true);
select pg_temp.reject($q$select public.ops_finance_write('review',current_setting('test.review')::jsonb)$q$);
select set_config('test.review',(current_setting('test.review')::jsonb||'{"owner_rate_reason":"Owner agreed special booking rate"}'::jsonb)::text,true);
-- Invalid money and duplicate/missing nights must fail before a review is inserted.
select pg_temp.reject($q$select public.ops_finance_write('review',jsonb_set(current_setting('test.review')::jsonb,'{owner_nights,1,rate_cents}','-1'))$q$);
select pg_temp.reject($q$select public.ops_finance_write('review',jsonb_set(current_setting('test.review')::jsonb,'{owner_nights,1,rate_cents}','700000.5'))$q$);
select pg_temp.reject($q$select public.ops_finance_write('review',jsonb_set(current_setting('test.review')::jsonb,'{owner_nights,1,night}','"2026-09-05"'))$q$);
select set_config('test.review_id',public.ops_finance_write('review',current_setting('test.review')::jsonb)::text,true);
select pg_temp.ok(public.ops_finance_write('review',current_setting('test.review')::jsonb)::text=current_setting('test.review_id'),'Idempotency failed');
select pg_temp.ok((select sum((n->>'rate_cents')::bigint)=2000000 from public.ops_stay_financial_reviews f cross join lateral jsonb_array_elements(f.rate_nights)n where f.id=current_setting('test.review_id')::uuid),'Actual entitlement wrong');
select pg_temp.ok((select rate_cents=650000 from public.ops_owner_rate_periods where property_slug='nightly-fixture' and season='shoulder'),'Override changed property default');
select pg_temp.reject($q$update public.ops_stay_financial_reviews set reason='overwrite' where id=current_setting('test.review_id')::uuid$q$);
-- A default correction must preserve the explicitly agreed 700000 for this booking.
select public.ops_finance_write('rate',jsonb_build_object('request_key',gen_random_uuid(),'property_slug','nightly-fixture','season','shoulder','starts_on','2026-09-06','ends_on','2026-09-07','rate_cents',675000,'reason','Fixture default correction','previous_id',id)) from public.ops_owner_rate_periods where property_slug='nightly-fixture' and season='shoulder';
select pg_temp.ok((public.ops_owner_nights('b3000000-0000-0000-0000-000000000001')->1->>'rate_cents')::bigint=700000,'Explicit agreement silently changed');
select pg_temp.reject($q$select public.ops_finance_write('review',current_setting('test.review')::jsonb||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',current_setting('test.review_id')))$q$);
-- Append a revised all-night agreement; retain previous amounts and prior revision.
select set_config('test.new_nights',(select jsonb_agg(n||'{"rate_cents":710000}'::jsonb) from jsonb_array_elements(public.ops_owner_nights('b3000000-0000-0000-0000-000000000001'))n)::text,true);
select public.ops_finance_write('review',current_setting('test.review')::jsonb||jsonb_build_object('request_key',gen_random_uuid(),'previous_id',current_setting('test.review_id'),'owner_nights',current_setting('test.new_nights')::jsonb,'owner_rate_reason','All nights agreed'));
select pg_temp.ok((select count(*)=2 from public.ops_stay_financial_reviews where booking_id='b3000000-0000-0000-0000-000000000001'),'Revision history missing');
select pg_temp.ok((select bool_and(funds_received_cents=0) from public.ops_stay_financial_reviews where booking_id='b3000000-0000-0000-0000-000000000001'),'Override inferred funds');
reset role;
select pg_temp.ok((select count(*) from public.ops_payment_records)=current_setting('test.payments')::bigint,'Payment created');
select pg_temp.ok((select count(*) from public.ops_stay_opening_positions)=current_setting('test.openings')::bigint,'Settlement created');
rollback;
