-- BSTE Operations Staging ONLY. Run this ENTIRE file, never a selected fragment.
-- Uses the existing booking but a synthetic MFA administrator/session (no real token).
-- All row changes roll back inside the exception block, INCLUDING on success.
-- Outer ROLLBACK removes these temporary helpers. Identity sequences may advance;
-- PostgreSQL sequences are not transactional, but no review/audit/payment row persists.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';
-- Keep before/after verification free of concurrent application writes.
lock table public.ops_bookings,public.ops_stay_financial_reviews,
 public.ops_finance_requests,public.ops_payment_records,public.ops_stay_opening_positions,
 public.ops_events,public.ops_owner_rate_periods in share row exclusive mode;

create function pg_temp.real_review_state() returns jsonb
language plpgsql as $$
declare t text; result jsonb:='{}'::jsonb; summary jsonb;
begin
 foreach t in array array['ops_bookings','ops_stay_financial_reviews','ops_finance_requests',
  'ops_payment_records','ops_stay_opening_positions','ops_events','ops_owner_rate_periods'] loop
  execute format('select jsonb_build_object(''count'',count(*),''hash'',md5(coalesce(string_agg(to_jsonb(r)::text,chr(10) order by to_jsonb(r)::text),''''))) from public.%I r',t) into summary;
  result:=result||jsonb_build_object(t,summary);
 end loop;
 return result;
end $$;

create function pg_temp.real_september_review_diagnostic()
returns table(
 test_result text,failed_phase text,"SQLSTATE" text,"MESSAGE_TEXT" text,
 "PG_EXCEPTION_DETAIL" text,"PG_EXCEPTION_HINT" text,"PG_EXCEPTION_CONTEXT" text,
 target_reviews_before bigint,target_reviews_after bigint,
 new_financial_reviews bigint,new_finance_requests bigint,new_payments bigint,
 new_opening_positions bigint,opening_positions_unchanged boolean,
 protected_rows_unchanged boolean,synthetic_auth_staff_removed boolean,rollback_verified boolean
) language plpgsql as $diag$
declare
 target uuid; matches integer; before_state jsonb; after_state jsonb; nights jsonb;
 payload jsonb; saved uuid; phase text:='preflight'; code text; message text;
 error_detail text; error_hint text; error_context text; before_reviews bigint; after_reviews bigint;
 fixture_user constant uuid:='c9100000-0000-0000-0000-000000000001';
 fixture_session constant uuid:='c9200000-0000-0000-0000-000000000001';
 fixtures_gone boolean;
begin
 if current_user<>'postgres' then raise exception 'Run only in the staging SQL Editor postgres context'; end if;
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='public.ops_stay_financial_reviews'::regclass and a.attname='expenses_complete'
   and a.atttypid='boolean'::regtype and a.attnotnull and not a.attisdropped
   and pg_get_expr(d.adbin,d.adrelid)='false') then
  raise exception 'Apply and verify expenses_complete schema alignment before this rollback diagnostic';
 end if;
 select count(*) into matches from public.ops_bookings where beds24_booking_id=92622943;
 if matches<>1 then raise exception 'Expected exactly one source booking; diagnostic stopped'; end if;
 select id into target from public.ops_bookings where beds24_booking_id=92622943
  and source_environment='production' and property_slug='legacy-suiderstrand'
  and beds24_property_id=351452 and beds24_room_id=724919
  and arrival='2026-09-05'::date and departure='2026-09-13'::date;
 if target is null then raise exception 'Existing booking identity/dates do not match approved diagnostic'; end if;
 select count(*) into before_reviews from public.ops_stay_financial_reviews where booking_id=target;
 if before_reviews<>0 then raise exception 'A review already exists; diagnostic stopped without retrying'; end if;
 if exists(select 1 from auth.users where id=fixture_user)
  or exists(select 1 from auth.sessions where id=fixture_session)
  or exists(select 1 from public.ops_staff where user_id=fixture_user) then raise exception 'Synthetic identifiers already exist'; end if;
 before_state:=pg_temp.real_review_state();
 begin
  phase:='synthetic authenticated Administrator/AAL2 setup';
  insert into auth.users(id) values(fixture_user);
  insert into auth.sessions(id,user_id,created_at,updated_at) values(fixture_session,fixture_user,now(),now());
  insert into public.ops_staff(user_id,display_name,role,is_active)
   values(fixture_user,'Rollback diagnostic administrator','administrator',true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',fixture_user,'session_id',fixture_session,'aal','aal2')::text,true);
  perform set_config('request.jwt.claim.sub',fixture_user::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.session_id',fixture_session::text,true);
  perform set_config('request.jwt.claim.aal','aal2',true);
  execute 'set local role authenticated';
  if not public.ops_session_valid() or not public.ops_can('finance.write') then raise exception 'Synthetic authenticated session failed production validation'; end if;
  phase:='read existing standard/agreed nights';
  nights:=public.ops_owner_nights(target);
  if jsonb_array_length(nights)<>8 or exists(select 1 from jsonb_array_elements(nights)n
   where n->>'season' is distinct from 'shoulder' or n->>'rate_id' is null
    or (n->>'default_rate_cents')::bigint is distinct from 350000::bigint
    or (n->>'rate_cents')::bigint is distinct from 350000::bigint) then raise exception 'Existing standard nights differ from approved R3500 shoulder configuration'; end if;
  -- Send precisely the browser's per-night projection, not extra helper metadata.
  select jsonb_agg(jsonb_build_object('night',n->'night','rate_id',n->'rate_id',
   'default_rate_cents',n->'default_rate_cents','rate_cents',350000) order by n->>'night') into nights
   from jsonb_array_elements(nights)n;
  payload:=jsonb_build_object('booking_id',target,'previous_id',null,'request_key',gen_random_uuid(),
   'status','draft','accommodation_cents',5148000,'cleaning_charge_cents',117500,
   'channel_fees_cents',938576,'cleaner_cost_cents',80000,'cleaner_supplier','Felicia',
   'funds_received_cents',4326924,'funds_as_of','2026-09-11','expenses_complete',false,
   'funds_evidence','Airbnb payout reference','reason','Initial reconciliation from Airbnb payout statement',
   'owner_nights',nights,'owner_rate_reason','');
  phase:='ops_finance_write review INSERT path';
  saved:=public.ops_finance_write('review',payload);
  phase:='verify successful review before forced rollback';
  if not exists(select 1 from public.ops_stay_financial_reviews f where f.id=saved and f.booking_id=target
    and f.accommodation_cents=5148000 and f.cleaning_charge_cents=117500 and f.channel_fees_cents=938576
    and f.cleaner_cost_cents=80000 and f.funds_received_cents=4326924 and f.status='draft'
    and not f.expenses_complete and jsonb_array_length(f.rate_nights)=8
    and (select sum((n->>'rate_cents')::bigint) from jsonb_array_elements(f.rate_nights)n)=2800000)
   then raise exception 'Saved review did not match exact diagnostic values'; end if;
  -- This exception deliberately undoes every fixture, review, request and audit row.
  raise exception using errcode='ZX001',message='Successful diagnostic; force rollback';
 exception when others then
  get stacked diagnostics code=returned_sqlstate,message=message_text,
   error_detail=pg_exception_detail,error_hint=pg_exception_hint,error_context=pg_exception_context;
 end;
 -- Role/claims and all row mutations inside the subtransaction have now rolled back.
 after_state:=pg_temp.real_review_state();
 select count(*) into after_reviews from public.ops_stay_financial_reviews where booking_id=target;
 fixtures_gone:=not exists(select 1 from auth.users where id=fixture_user)
  and not exists(select 1 from auth.sessions where id=fixture_session)
  and not exists(select 1 from public.ops_staff where user_id=fixture_user);
 if before_state is distinct from after_state or after_reviews<>0 or not fixtures_gone then
  raise exception 'ROLLBACK VERIFICATION FAILED; outer transaction must roll back';
 end if;
 return query select
  case when code='ZX001' then 'CALL SUCCEEDED; ALL CHANGES ROLLED BACK' else 'CALL FAILED; ALL CHANGES ROLLED BACK' end,
  phase,case when code='ZX001' then '00000' else code end,
  case when code='ZX001' then 'Review succeeded only inside rollback diagnostic' else message end,
  case when code='ZX001' then null::text else error_detail end,
  case when code='ZX001' then null::text else error_hint end,
  case when code='ZX001' then null::text else error_context end,
  before_reviews,after_reviews,
  (after_state->'ops_stay_financial_reviews'->>'count')::bigint-(before_state->'ops_stay_financial_reviews'->>'count')::bigint,
  (after_state->'ops_finance_requests'->>'count')::bigint-(before_state->'ops_finance_requests'->>'count')::bigint,
  (after_state->'ops_payment_records'->>'count')::bigint-(before_state->'ops_payment_records'->>'count')::bigint,
  (after_state->'ops_stay_opening_positions'->>'count')::bigint-(before_state->'ops_stay_opening_positions'->>'count')::bigint,
  before_state->'ops_stay_opening_positions'=after_state->'ops_stay_opening_positions',
  before_state=after_state,fixtures_gone,true;
end $diag$;
select * from pg_temp.real_september_review_diagnostic();
rollback;
