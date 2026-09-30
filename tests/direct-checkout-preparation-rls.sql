-- Isolated staging after separate approval/application of 202609260003.
-- Run whole file. Fixtures are synthetic, dynamically dated, and rolled back.
begin;
create function pg_temp.must(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'PREPARATION_TEST: %',label;end if;end $$;
create function pg_temp.denied(q text,code text) returns void language plpgsql as $$begin begin execute q;exception when others then if sqlstate<>code then raise;end if;return;end;raise exception 'Expected denial';end $$;
create function pg_temp.claims(role_value text) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claims',jsonb_build_object('role',role_value)::text,true);
 perform set_config('request.jwt.claim',jsonb_build_object('role',role_value)::text,true);
 perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claim.role',role_value,true);
end $$;
create function pg_temp.digest_table(tab text) returns text language plpgsql as $$declare v text;begin
 execute format('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,''[]'')) from public.%I t',tab) into v;return v;end $$;
create temp table preparation_baseline(tab text,digest text);
insert into preparation_baseline select tab,pg_temp.digest_table(tab) from unnest(array[
 'ops_bookings','ops_stay_opening_positions','ops_stay_financial_reviews','ops_payment_records','ops_owner_rate_periods',
 'ops_stay_expenses','ops_expense_attachments','ops_finance_requests','ops_month_reconciliations','ops_owner_statement_snapshots','ops_owner_statement_adjustments',
 'payment_attempts','payment_events','checkout_actions','ops_events','direct_checkouts','direct_checkout_preparations']) tab;
create temp table preparation_fixture(p jsonb);
insert into preparation_fixture
select jsonb_build_object('idempotency_key',gen_random_uuid(),'quote_reference',gen_random_uuid(),
 'quote_created_at',clock_at,'quote_expires_at',clock_at+interval '30 minutes','hold_minutes',30,
 'access_hash',encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),
 'guest',jsonb_build_object('first_name','Synthetic','surname','Preparation','email','fixture@example.invalid','mobile','+27000000000'),
 'quote',jsonb_build_object('property_slug','legacy-suiderstrand','arrival',today+10,'departure',today+18,'adults',2,'children',0,
 'currency','ZAR','nights',8,'breakdown',(select jsonb_agg(jsonb_build_object('date',today+10+i,'season','fixture','rate_cents',10000)) from generate_series(0,7) i),
 'accommodation_cents',80000,'cleaning_cents',1,'total_cents',80001,'min_stay_required',2,'min_stay_ok',true,
 'due_now_cents',40001,'balance_cents',40000,'balance_due_date',today+3,'schedule_date',today,
 'balance_deadline',(today+3)::text||'T23:59:00+02:00','pricing_version','fixture-v1','terms_version','fixture-v1','terms_url','https://example.invalid/fixture-terms'))
from (select clock_timestamp() clock_at,(now() at time zone 'Africa/Johannesburg')::date today) t;
create temp table preparation_results(n integer,result jsonb);
grant select on preparation_fixture to anon,authenticated,service_role;
grant select,insert on preparation_results to service_role;
savepoint preparation_rows;
select pg_temp.claims('anon');set local role anon;
select pg_temp.denied($q$select public.direct_prepare_checkout((select p from pg_temp.preparation_fixture))$q$,'42501');
reset role;
select pg_temp.claims('authenticated');set local role authenticated;
select pg_temp.denied($q$select public.direct_prepare_checkout((select p from pg_temp.preparation_fixture))$q$,'42501');
reset role;
select pg_temp.claims('service_role');set local role service_role;
insert into preparation_results select 1,public.direct_prepare_checkout(p) from preparation_fixture;
insert into preparation_results select 2,public.direct_prepare_checkout(p) from preparation_fixture;
select pg_temp.must((select result from preparation_results where n=1)=(select result from preparation_results where n=2),'idempotent response');
select pg_temp.must((select result->>'state'='preparing' and result->>'inventory_protected'='false' and result->>'payment_enabled'='false' from preparation_results where n=1),'unprotected preparing');
select pg_temp.denied($q$select public.direct_prepare_checkout(jsonb_set(p,'{guest,surname}','"Changed"')) from preparation_fixture$q$,'P0001');
select pg_temp.denied($q$select public.direct_prepare_checkout(jsonb_set(p,'{quote,adults}','3')) from preparation_fixture$q$,'P0001');
select pg_temp.denied($q$select public.direct_prepare_checkout(p||jsonb_build_object('idempotency_key',gen_random_uuid())) from preparation_fixture$q$,'P0001');
select pg_temp.denied($q$select public.direct_prepare_checkout(p||jsonb_build_object('beds24_reservation_id',1)) from preparation_fixture$q$,'P0001');
select pg_temp.must(public.direct_checkout_status((select (result->>'checkout_id')::uuid from preparation_results where n=1),(select p->>'access_hash' from preparation_fixture))=(select result from preparation_results where n=1),'capability status');
select pg_temp.denied($q$select public.direct_checkout_status((select (result->>'checkout_id')::uuid from preparation_results where n=1),repeat('0',64))$q$,'P0001');
select pg_temp.denied($q$select * from public.direct_checkout_preparations$q$,'42501');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501');
reset role;
select pg_temp.must(exists(select 1 from public.direct_checkouts where id=(select (result->>'checkout_id')::uuid from preparation_results where n=1)
 and environment='sandbox' and state='preparing' and not protection_verified and protected_at is null and hold_expires_at is null and beds24_reservation_id is null and ops_booking_id is null),'no protected inventory or Operations link');
select pg_temp.must((select count(*) from public.direct_checkout_preparations where quote_reference=(select (p->>'quote_reference')::uuid from preparation_fixture))=1,'one preparation');
select pg_temp.must(pg_temp.digest_table(tab)=digest,'side effects absent: '||tab) from preparation_baseline where tab not in ('direct_checkouts','direct_checkout_preparations','ops_events');
rollback to savepoint preparation_rows;
select pg_temp.must(pg_temp.digest_table(tab)=digest,'rollback unchanged: '||tab) from preparation_baseline;
select not exists(select 1 from public.direct_checkout_preparations where quote_reference=(select (p->>'quote_reference')::uuid from preparation_fixture)) as preparation_removed,
 not exists(select 1 from public.direct_checkouts where idempotency_key=(select (p->>'idempotency_key')::uuid from preparation_fixture)) as checkout_removed;
rollback;
