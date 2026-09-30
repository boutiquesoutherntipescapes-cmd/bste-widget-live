-- Isolated staging ONLY after separately approved 202609260002.
-- Execute COMPLETE file. No COMMIT, provider calls or real booking changes.
-- SAVEPOINT retains the random manifest for post-fixture-rollback assertions;
-- final ROLLBACK removes the temporary harness itself. Any error aborts the transaction.
begin;
create temp table checkout_test_manifest(name text primary key,id uuid not null default gen_random_uuid(),session_id uuid not null default gen_random_uuid(),body jsonb);
insert into checkout_test_manifest(name) values
 ('checkout_sandbox'),('checkout_production'),('attempt_sandbox'),('attempt_production'),
 ('event_sandbox'),('event_production'),('action'),('nonstaff'),('operations'),('finance'),('administrator'),('merchant');
create function pg_temp.fixture(n text) returns jsonb language sql as $$select body from pg_temp.checkout_test_manifest where name=n$$;
create function pg_temp.fixture_id(n text) returns uuid language sql as $$select id from pg_temp.checkout_test_manifest where name=n$$;
create function pg_temp.must(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'CHECKOUT_TEST: %',label; end if; end $$;
create function pg_temp.denied(q text,expected text,label text) returns void language plpgsql as $$
begin begin execute q; exception when others then if sqlstate<>expected then raise exception 'CHECKOUT_TEST %: expected %, received %',label,expected,sqlstate;end if;return;end;raise exception 'CHECKOUT_TEST %: unexpected success',label;end $$;
-- Generic fixture insert: only the four new tables, no definer privileges.
-- Omitted columns retain real defaults; no production function is mocked.
create function pg_temp.insert_fixture(tab text,p jsonb) returns void language plpgsql as $$
declare cols text; begin
 if tab not in ('direct_checkouts','payment_attempts','payment_events','checkout_actions') then raise exception 'Fixture table denied';end if;
 select string_agg(format('%I',k),',' order by k) into cols from jsonb_object_keys(p) k;
 execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1)',tab,cols,cols,tab) using p;
end $$;
create function pg_temp.test_claims(staff_label text,aal_value text,role_value text default 'authenticated') returns void language plpgsql as $$
declare claims jsonb; u uuid; sid uuid; begin
 if staff_label is not null then select id,session_id into strict u,sid from pg_temp.checkout_test_manifest where name=staff_label;end if;
 claims=jsonb_strip_nulls(jsonb_build_object('role',role_value,'sub',u,'session_id',sid,'aal',aal_value));
 perform set_config('request.jwt.claims',claims::text,true);perform set_config('request.jwt.claim',claims::text,true);
 perform set_config('request.jwt.claim.sub',coalesce(u::text,''),true);perform set_config('request.jwt.claim.role',coalesce(role_value,''),true);
 perform set_config('request.jwt.claim.session_id',coalesce(sid::text,''),true);perform set_config('request.jwt.claim.aal',coalesce(aal_value,''),true);
end $$;
select pg_temp.test_claims(null,null,null);
-- Hash complete row contents, not just counts. No financial/guest values printed.
create function pg_temp.table_digest(tab text) returns text language plpgsql as $$
declare result text; begin
 execute format('select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,''[]'')) from public.%I t',tab) into result;
 return result;
end $$;
create temp table checkout_test_baseline(tab text primary key,digest text);
insert into checkout_test_baseline
select t,pg_temp.table_digest(t) from unnest(array[
 'ops_bookings','ops_stay_opening_positions','ops_stay_financial_reviews','ops_payment_records',
 'ops_owner_rate_periods','ops_stay_expenses','ops_expense_attachments','ops_finance_requests',
 'ops_month_reconciliations','ops_owner_statement_snapshots','ops_owner_statement_adjustments',
 'ops_events','direct_checkouts','payment_attempts','payment_events','checkout_actions']) t;
-- Generate every identity/reference; fixtures never reuse a global payment key.
update checkout_test_manifest set body=jsonb_build_object(
 'id',id,'environment',replace(name,'checkout_',''),'idempotency_key',gen_random_uuid(),
 'property_slug','legacy-suiderstrand','arrival','2026-10-10','departure','2026-10-12','adults',2,'children',0,
 'quote_reference',gen_random_uuid(),'quote_version','fixture','quote_created_at',now(),'quote_expires_at',now()+interval '30 minutes',
 'total_cents',10001,'schedule_date','2026-10-01','due_now_cents',5001,'balance_cents',5000,'balance_due_date','2026-10-03',
 'terms_version','fixture','terms_accepted_at',now(),'terms_acceptance_reference',gen_random_uuid())
where name in ('checkout_sandbox','checkout_production');
update checkout_test_manifest set body=jsonb_build_object(
 'id',id,'checkout_id',pg_temp.fixture_id(replace(name,'attempt_','checkout_')),'environment',replace(name,'attempt_',''),
 'merchant_scope',pg_temp.fixture_id('merchant')::text,'initiation_key',gen_random_uuid(),'purpose','deposit','expected_cents',5001)
where name in ('attempt_sandbox','attempt_production');
update checkout_test_manifest set body=jsonb_build_object(
 'id',id,'attempt_id',pg_temp.fixture_id(replace(name,'event_','attempt_')),'environment',replace(name,'event_',''),
 'provider','payfast','merchant_scope',pg_temp.fixture_id('merchant')::text,'event_key',gen_random_uuid()::text,
 'provider_transaction_id',gen_random_uuid()::text,'verification_result','accepted','provider_status','complete',
 'amount_cents',5001,'currency','ZAR','signature_valid',true,'source_valid',true,'merchant_valid',true,'identity_valid',true,'amount_valid',true,'reason_code','verified')
where name in ('event_sandbox','event_production');
update checkout_test_manifest set body=jsonb_build_object('id',id,'checkout_id',pg_temp.fixture_id('checkout_sandbox'),'environment','sandbox','action','confirm','idempotency_key',gen_random_uuid()) where name='action';
-- These grants are TEMP harness reads only, not access to provider/financial tables.
grant select on checkout_test_manifest to anon,authenticated,service_role;
savepoint payment_fixtures;
insert into auth.users(id) select id from checkout_test_manifest where name in ('nonstaff','operations','finance','administrator');
insert into auth.sessions(id,user_id,created_at,updated_at) select session_id,id,now(),now() from checkout_test_manifest where name in ('nonstaff','operations','finance','administrator');
insert into public.ops_staff(user_id,display_name,role,is_active) select id,'Synthetic checkout '||name,name,true from checkout_test_manifest where name in ('operations','finance','administrator');
select pg_temp.insert_fixture('direct_checkouts',pg_temp.fixture('checkout_sandbox'));
select pg_temp.insert_fixture('direct_checkouts',pg_temp.fixture('checkout_production'));
select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_sandbox'));
select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_production'));
select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_sandbox'));
select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_production'));
select pg_temp.insert_fixture('checkout_actions',pg_temp.fixture('action'));
-- Each duplicate uses a FRESH primary key. Only the named business key repeats.
select pg_temp.denied($q$select pg_temp.insert_fixture('direct_checkouts',pg_temp.fixture('checkout_sandbox')||jsonb_build_object('id',gen_random_uuid()))$q$,'23505','checkout idempotency');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_sandbox')||jsonb_build_object('id',gen_random_uuid()))$q$,'23505','attempt initiation');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_sandbox')||jsonb_build_object('id',gen_random_uuid(),'provider_transaction_id',gen_random_uuid()::text))$q$,'23505','event identity');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_sandbox')||jsonb_build_object('id',gen_random_uuid(),'event_key',gen_random_uuid()::text))$q$,'23505','accepted transaction');
select pg_temp.denied($q$select pg_temp.insert_fixture('checkout_actions',pg_temp.fixture('action')||jsonb_build_object('id',gen_random_uuid(),'action','reconcile'))$q$,'23505','action idempotency');
select pg_temp.denied($q$select pg_temp.insert_fixture('checkout_actions',pg_temp.fixture('action')||jsonb_build_object('id',gen_random_uuid(),'idempotency_key',gen_random_uuid()))$q$,'23505','one action per checkout');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_sandbox')||jsonb_build_object('id',gen_random_uuid(),'initiation_key',gen_random_uuid(),'checkout_id',pg_temp.fixture_id('checkout_production')))$q$,'23503','sandbox attempt cannot link to production checkout');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_sandbox')||jsonb_build_object('id',gen_random_uuid(),'event_key',gen_random_uuid()::text,'provider_transaction_id',gen_random_uuid()::text,'attempt_id',pg_temp.fixture_id('attempt_production')))$q$,'23503','sandbox event cannot link to production attempt');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_production')||jsonb_build_object('id',gen_random_uuid(),'initiation_key',gen_random_uuid(),'checkout_id',pg_temp.fixture_id('checkout_sandbox')))$q$,'23503','production attempt cannot link to sandbox checkout');
select pg_temp.denied($q$select pg_temp.insert_fixture('payment_events',pg_temp.fixture('event_production')||jsonb_build_object('id',gen_random_uuid(),'event_key',gen_random_uuid()::text,'provider_transaction_id',gen_random_uuid()::text,'attempt_id',pg_temp.fixture_id('attempt_sandbox')))$q$,'23503','production event cannot link to sandbox attempt');
-- NULL provider references intentionally permit separate as-yet-uninitiated attempts.
select pg_temp.insert_fixture('payment_attempts',pg_temp.fixture('attempt_sandbox')||jsonb_build_object('id',gen_random_uuid(),'initiation_key',gen_random_uuid()));
select pg_temp.denied($q$update public.payment_events set amount_cents=1 where id=pg_temp.fixture_id('event_sandbox')$q$,'P0001','accepted event update');
select pg_temp.denied($q$delete from public.payment_events where id=pg_temp.fixture_id('event_sandbox')$q$,'P0001','accepted event delete');
-- Quote/preparation do not require a protected hold. Phase 1A forbids verified holds.
select pg_temp.must(exists(select 1 from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox') and state='quoted' and protected_at is null and hold_expires_at is null),'quoted without protection');
update public.direct_checkouts set state='preparing' where id=pg_temp.fixture_id('checkout_sandbox');
select pg_temp.must(exists(select 1 from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox') and state='preparing' and protected_at is null),'preparing without protection');
select pg_temp.denied($q$update public.direct_checkouts set protected_at=now(),hold_expires_at=null where id=pg_temp.fixture_id('checkout_sandbox')$q$,'23514','missing expiry');
select pg_temp.denied($q$update public.direct_checkouts set protected_at=null,hold_expires_at=now() where id=pg_temp.fixture_id('checkout_sandbox')$q$,'23514','missing protection timestamp');
select pg_temp.denied($q$update public.direct_checkouts set protected_at=now(),hold_expires_at=now() where id=pg_temp.fixture_id('checkout_sandbox')$q$,'23514','zero duration');
select pg_temp.denied($q$update public.direct_checkouts set protected_at=now(),hold_expires_at=now()-interval '1 minute' where id=pg_temp.fixture_id('checkout_sandbox')$q$,'23514','negative duration');
update public.direct_checkouts set protected_at=now(),hold_expires_at=now()+interval '30 minutes' where id=pg_temp.fixture_id('checkout_sandbox');
select pg_temp.must(exists(select 1 from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox') and hold_expires_at>protected_at and not protection_verified and inventory_scope='isolated_test'),'valid pending timestamps, not verified hold');
select pg_temp.denied($q$update public.direct_checkouts set state='held',beds24_account='untrusted-fixture',beds24_reservation_id=1 where id=pg_temp.fixture_id('checkout_sandbox')$q$,'23514','reference cannot establish held state');
select pg_temp.denied($q$select pg_temp.insert_fixture('direct_checkouts',pg_temp.fixture('checkout_sandbox')||jsonb_build_object('id',gen_random_uuid(),'idempotency_key',gen_random_uuid(),'protection_verified',true))$q$,'23514','Phase 1A cannot verify inventory');
select pg_temp.denied($q$update public.direct_checkouts set state='confirmed' where id=pg_temp.fixture_id('checkout_sandbox')$q$,'P0001','invalid reservation transition');
-- Full row hashes cover owner/cleaner opening amounts, finance and manual direct records.
select pg_temp.must(pg_temp.table_digest(tab)=digest,'no side effects: '||tab) from checkout_test_baseline where tab like 'ops_%' and tab<>'ops_events';
-- Effective ACL checks plus actual operations under each database role.
select pg_temp.must(not has_table_privilege(r,t,'INSERT') and not has_table_privilege(r,t,'UPDATE') and not has_table_privilege(r,t,'DELETE'),'no DML '||r||' '||t)
from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['public.direct_checkouts','public.payment_attempts','public.payment_events','public.checkout_actions']) t;

select pg_temp.test_claims(null,null,'anon');
set local role anon;
select pg_temp.denied($q$select * from public.direct_checkouts$q$,'42501','anon SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','anon INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','anon UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','anon DELETE direct_checkouts');
select pg_temp.denied($q$select * from public.payment_attempts$q$,'42501','anon SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','anon INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','anon UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','anon DELETE payment_attempts');
select pg_temp.denied($q$select * from public.payment_events$q$,'42501','anon SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','anon INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','anon UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','anon DELETE payment_events');
select pg_temp.denied($q$select * from public.checkout_actions$q$,'42501','anon SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','anon INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','anon UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','anon DELETE checkout_actions');
reset role;

select pg_temp.test_claims('nonstaff','aal2','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=0,'nonstaff aal2 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=0,'nonstaff aal2 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=0,'nonstaff aal2 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=0,'nonstaff aal2 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims('operations','aal1','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=0,'operations aal1 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=0,'operations aal1 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=0,'operations aal1 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=0,'operations aal1 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims('finance','aal1','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=0,'finance aal1 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=0,'finance aal1 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=0,'finance aal1 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=0,'finance aal1 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims('administrator','aal1','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=0,'administrator aal1 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=0,'administrator aal1 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=0,'administrator aal1 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=0,'administrator aal1 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims('finance','aal2','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=1,'finance aal2 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=1,'finance aal2 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=1,'finance aal2 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=1,'finance aal2 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims('administrator','aal2','authenticated');
set local role authenticated;
select pg_temp.must((select count(*) from public.direct_checkouts where id=pg_temp.fixture_id('checkout_sandbox'))=1,'administrator aal2 SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','authenticated INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','authenticated UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','authenticated DELETE direct_checkouts');
select pg_temp.must((select count(*) from public.payment_attempts where id=pg_temp.fixture_id('attempt_sandbox'))=1,'administrator aal2 SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','authenticated INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','authenticated UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','authenticated DELETE payment_attempts');
select pg_temp.must((select count(*) from public.payment_events where id=pg_temp.fixture_id('event_sandbox'))=1,'administrator aal2 SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','authenticated INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','authenticated UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','authenticated DELETE payment_events');
select pg_temp.must((select count(*) from public.checkout_actions where id=pg_temp.fixture_id('action'))=1,'administrator aal2 SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','authenticated INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','authenticated UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','authenticated DELETE checkout_actions');
reset role;

select pg_temp.test_claims(null,null,'service_role');
set local role service_role;
select pg_temp.denied($q$select * from public.direct_checkouts$q$,'42501','service_role SELECT direct_checkouts');
select pg_temp.denied($q$insert into public.direct_checkouts default values$q$,'42501','service_role INSERT direct_checkouts');
select pg_temp.denied($q$update public.direct_checkouts set id=id where false$q$,'42501','service_role UPDATE direct_checkouts');
select pg_temp.denied($q$delete from public.direct_checkouts where false$q$,'42501','service_role DELETE direct_checkouts');
select pg_temp.denied($q$select * from public.payment_attempts$q$,'42501','service_role SELECT payment_attempts');
select pg_temp.denied($q$insert into public.payment_attempts default values$q$,'42501','service_role INSERT payment_attempts');
select pg_temp.denied($q$update public.payment_attempts set id=id where false$q$,'42501','service_role UPDATE payment_attempts');
select pg_temp.denied($q$delete from public.payment_attempts where false$q$,'42501','service_role DELETE payment_attempts');
select pg_temp.denied($q$select * from public.payment_events$q$,'42501','service_role SELECT payment_events');
select pg_temp.denied($q$insert into public.payment_events default values$q$,'42501','service_role INSERT payment_events');
select pg_temp.denied($q$update public.payment_events set id=id where false$q$,'42501','service_role UPDATE payment_events');
select pg_temp.denied($q$delete from public.payment_events where false$q$,'42501','service_role DELETE payment_events');
select pg_temp.denied($q$select * from public.checkout_actions$q$,'42501','service_role SELECT checkout_actions');
select pg_temp.denied($q$insert into public.checkout_actions default values$q$,'42501','service_role INSERT checkout_actions');
select pg_temp.denied($q$update public.checkout_actions set id=id where false$q$,'42501','service_role UPDATE checkout_actions');
select pg_temp.denied($q$delete from public.checkout_actions where false$q$,'42501','service_role DELETE checkout_actions');
reset role;
select pg_temp.test_claims(null,null,null);
-- Inspect, do not assume, the installed audit owner/security configuration.
select p.oid::regprocedure as function_name,pg_get_userbyid(p.proowner) as function_owner,p.prosecdef as security_definer,p.proconfig
from pg_proc p where p.oid='public.direct_payment_audit()'::regprocedure;
-- Roll back ALL fixtures first; preserve only pre-fixture temporary manifest/baseline.
rollback to savepoint payment_fixtures;
select pg_temp.must(pg_temp.table_digest(tab)=digest,'post-rollback unchanged: '||tab) from checkout_test_baseline;
select pg_temp.must(not exists(select 1 from auth.users u join checkout_test_manifest m on u.id=m.id),'auth users rolled back');
select pg_temp.must(not exists(select 1 from auth.sessions s join checkout_test_manifest m on s.id=m.session_id),'auth sessions rolled back');
select pg_temp.must(not exists(select 1 from public.ops_staff s join checkout_test_manifest m on s.user_id=m.id),'staff rolled back');
select
 not exists(select 1 from public.direct_checkouts c join checkout_test_manifest m on c.id=m.id) as checkouts_removed,
 not exists(select 1 from public.payment_attempts a join checkout_test_manifest m on a.checkout_id=m.id) as attempts_removed,
 not exists(select 1 from public.payment_events where merchant_scope=pg_temp.fixture_id('merchant')::text) as events_removed,
 not exists(select 1 from public.checkout_actions a join checkout_test_manifest m on a.checkout_id=m.id) as actions_removed,
 (select pg_temp.table_digest('ops_events')=digest from checkout_test_baseline where tab='ops_events') as audit_rows_rolled_back,
 not exists(select 1 from auth.users u join checkout_test_manifest m on u.id=m.id) as auth_users_removed,
 not exists(select 1 from auth.sessions s join checkout_test_manifest m on s.id=m.session_id) as auth_sessions_removed,
 not exists(select 1 from public.ops_staff s join checkout_test_manifest m on s.user_id=m.id) as staff_removed;
rollback;
