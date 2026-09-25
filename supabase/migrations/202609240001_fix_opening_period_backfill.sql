-- Corrective migration only. Does not execute a repair or reapply a batch.
begin;
-- NULL = not recorded by legacy code. Never rewrite old result evidence.
alter table public.ops_historical_results
 add column newly_created_opening_count integer check(newly_created_opening_count>=0),
 add column preserved_opening_count integer check(preserved_opening_count>=0);
create function public.ops_historical_guest_eligible(item jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(item->'raw')='object'
 and lower(item->'snapshot'->>'source_status') in ('new','confirmed')
 and not coalesce((item->'raw'->>'isBlocked')::boolean,false)
 and not coalesce((item->'raw'->>'ownerStay')::boolean,false)
 and not exists(select 1 from jsonb_each_text(item->'raw') x
 where x.key in ('type','bookingType','booking_type','subType')
 and x.value ~* '^(owner([ _-]stay)?|block(ed)?|maintenance|non[ _-]guest)$'),false);
$$;
-- One root and one current decision; append-only revisions are not duplicates.
create function public.ops_assert_historical_openings(target_batch uuid) returns void
language plpgsql security definer set search_path='' as $$
declare batch public.ops_historical_batches; item jsonb; booking uuid; roots integer; leaves integer;
begin
 select * into batch from public.ops_historical_batches where id=target_batch;
 if batch.id is null then raise exception 'Unknown historical batch'; end if;
 for item in select value from jsonb_array_elements(batch.approved_items) loop
  if public.ops_historical_guest_eligible(item) then
   select id into booking from public.ops_bookings where source_environment=batch.source_environment
    and source_account=batch.source_account and beds24_booking_id=(item->'snapshot'->>'beds24_booking_id')::bigint for update;
   select count(*) filter(where o.previous_id is null),count(*) filter(where not exists(
    select 1 from public.ops_stay_opening_positions n where n.previous_id=o.id)) into roots,leaves
    from public.ops_stay_opening_positions o where o.booking_id=booking;
   if booking is null or roots<>1 or leaves<>1 or exists(
    select 1 from public.ops_stay_opening_positions o where o.booking_id=booking and
     (not o.opening_period or (o.previous_id is not null and not exists(
      select 1 from public.ops_stay_opening_positions p where p.id=o.previous_id and p.booking_id=booking)))) then
    raise exception 'Historical opening state incomplete or conflicting; administrator repair required; do not retry import';
   end if;
  end if;
 end loop;
end $$;

create or replace function public.ops_apply_historical_batch(batch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare batch public.ops_historical_batches; existing public.ops_bookings; item jsonb; booking uuid;
 result public.ops_historical_results; n integer:=0; settled integer:=0; retained integer:=0; created integer:=0;
 actor public.ops_staff; opening_id uuid;
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'Historical importer only'; end if;
 select * into batch from public.ops_historical_batches where id=batch_id for update;
 if batch.id is null then raise exception 'Approved preview required'; end if;
 select * into result from public.ops_historical_results r where r.batch_id=ops_apply_historical_batch.batch_id;
 if result.batch_id is not null then
  perform public.ops_assert_historical_openings(batch.id);
  return to_jsonb(result);
 end if;
 select * into actor from public.ops_staff where user_id=batch.approved_by and is_active and role='administrator';
 if actor.user_id is null or batch.approved_at<clock_timestamp()-interval '30 minutes'
  or not exists(select 1 from auth.sessions where id=batch.approved_session and user_id=batch.approved_by and created_at>now()-interval '1 hour')
  or not exists(select 1 from public.ops_role_permissions where role='administrator' and permission='finance.cutover')
  or not exists(select 1 from public.ops_role_permissions where role='administrator' and permission='sync.run') then raise exception 'Historical approval expired or revoked'; end if;
 -- Same account lock as live importer; historical work never changes live health.
 perform pg_advisory_xact_lock(hashtextextended('bste-ops-sync:'||batch.source_account,0));
 if exists(select 1 from public.ops_sync_runs where source_account=batch.source_account and status='running') then raise exception 'Normal sync running; retry after completion'; end if;
 for item in select value from jsonb_array_elements(batch.approved_items) loop
  select * into existing from public.ops_bookings where source_environment='production' and source_account=batch.source_account
    and beds24_booking_id=(item->'snapshot'->>'beds24_booking_id')::bigint for update;
  if existing.id is distinct from (item->>'expected_id')::uuid or existing.last_synced_at is distinct from (item->>'expected_last_synced_at')::timestamptz then raise exception 'Stored booking changed since preview; refresh preview'; end if;
  booking:=public.ops_sync_booking(item->'snapshot',nullif(item->'financial','null'::jsonb),batch.id);
  -- Source-only payload retention. No staff table is synchronized or replaced.
  insert into public.ops_beds24_raw_snapshots values(booking,item->'raw',(item->'snapshot'->>'source_observed_at')::timestamptz)
   on conflict(booking_id) do update set payload=excluded.payload,source_observed_at=excluded.source_observed_at;
  if public.ops_historical_guest_eligible(item) then
   -- Opening-period classification never implies paid obligations.
   -- Any existing opening decision wins, especially an intentional administrator reopening.
   if exists(select 1 from public.ops_stay_opening_positions where booking_id=booking) then retained:=retained+1;
   else
    insert into public.ops_stay_opening_positions(booking_id,request_key,state,reason,confirmed_by_bond,created_by,opening_period,owner_settlement_state,cleaner_settlement_state)
    values(booking,gen_random_uuid(),case when coalesce((item->>'settle')::boolean,false) then 'fully_settled_historical' else 'open' end,
     'Opening-period approval; explicit settlement selection recorded in batch '||batch.id::text,coalesce((item->>'settle')::boolean,false),batch.approved_by,true,
     case when coalesce((item->>'settle')::boolean,false) then 'fully_settled' else 'outstanding' end,
     case when coalesce((item->>'settle')::boolean,false) then 'fully_settled' else 'outstanding' end) returning id into opening_id;
    -- Actual actor authorized this exact immutable batch at AAL2; importer does not invent a user.
    insert into public.ops_events(actor_user_id,actor_name,actor_role,action,entity_table,entity_id,booking_id,detail,system_run_id)
    values(actor.user_id,actor.display_name,actor.role,'historical.opening_position_authorized','ops_stay_opening_positions',opening_id::text,booking,
     jsonb_build_object('batch_id',batch.id,'approved_at',batch.approved_at,'reason',batch.approval_reason),batch.id);
    created:=created+1;
    if not coalesce((item->>'settle')::boolean,false) and not exists(select 1 from public.ops_stay_opening_positions where id=opening_id and opening_period and state='open' and owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding' and owner_settled_cents=0 and cleaner_settled_cents=0) then raise exception 'Unpaid opening postcondition failed'; end if;
    if coalesce((item->>'settle')::boolean,false) then settled:=settled+1; end if;
   end if;
  end if;
  n:=n+1;
 end loop;
 perform public.ops_assert_historical_openings(batch.id);
 insert into public.ops_historical_results(batch_id,booking_count,settlement_count,retained_opening_count,newly_created_opening_count,preserved_opening_count)
 values(batch.id,n,settled,retained,created,retained) returning * into result;
 return to_jsonb(result);
end $$;

-- Exact approved tuples AND immutable batch source IDs. No source sync or payments.
create function public.ops_repair_september_openings(target_batch uuid,repair_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare batch public.ops_historical_batches; result public.ops_historical_results;
 item jsonb; b public.ops_bookings; actor public.ops_staff; opening_id uuid;
 created integer:=0; preserved integer:=0; matched integer;
begin
 if auth.role() is distinct from 'authenticated' or auth.jwt()->>'aal' is distinct from 'aal2'
  or not public.ops_can('finance.cutover') or not public.ops_can('finance.write') or not public.ops_can('sync.run') then
  raise exception 'Active MFA administrator repair authorization required'; end if;
 select * into actor from public.ops_staff where user_id=auth.uid() and is_active and role='administrator';
 if actor.user_id is null then raise exception 'Administrator repair required'; end if;
 if repair_reason is null or length(trim(repair_reason)) not between 1 and 1500 then raise exception 'Repair reason required'; end if;
 select * into batch from public.ops_historical_batches where id=target_batch for update;
 select * into result from public.ops_historical_results where batch_id=target_batch;
 if batch.id is null or result.batch_id is null or not batch.bond_confirmed or batch.source_environment<>'production'
  or batch.scope_from<>'2026-09-01'::date or batch.scope_through<>'2026-09-23'::date
  or jsonb_array_length(batch.approved_items)<>3 or result.booking_count<>3
  or result.settlement_count<>0 or result.retained_opening_count<>0
  or result.newly_created_opening_count is not null or result.preserved_opening_count is not null then
  raise exception 'Not the legacy partial three-stay September batch'; end if;
 perform pg_advisory_xact_lock(hashtextextended('bste-ops-sync:'||batch.source_account,0));
 if exists(select 1 from public.ops_sync_runs where source_account=batch.source_account and status='running') then raise exception 'Normal sync running'; end if;
 select count(*) into matched from jsonb_array_elements(batch.approved_items) i
 join (values
  ('legacy-suiderstrand',351452::bigint,724919::bigint,'2026-09-05','2026-09-13','airbnb'),
  ('kalay-ridge-villa-struisbaai',352005,726060,'2026-09-08','2026-09-11','airbnb'),
  ('the-pearl-beach-villa-agulhas',352276,726696,'2026-09-06','2026-09-13','booking.com')
 ) v(slug,property_id,room_id,arrival,departure,channel)
 on i->'snapshot'->>'property_slug'=v.slug
 and (i->'snapshot'->>'beds24_property_id')::bigint=v.property_id
 and (i->'snapshot'->>'beds24_room_id')::bigint=v.room_id
 and i->'snapshot'->>'arrival'=v.arrival and i->'snapshot'->>'departure'=v.departure
 and case lower(i->'snapshot'->>'source_channel') when 'booking' then 'booking.com' else lower(i->'snapshot'->>'source_channel') end=v.channel;
 if matched<>3 or (select count(distinct value->'snapshot'->>'property_slug') from jsonb_array_elements(batch.approved_items))<>3
  or (select count(distinct value->'snapshot'->>'beds24_booking_id') from jsonb_array_elements(batch.approved_items))<>3 then
  raise exception 'Approved three-stay identities conflict'; end if;
 -- Validate and lock ALL identities before the first insert.
 for item in select value from jsonb_array_elements(batch.approved_items) order by value->'snapshot'->>'beds24_booking_id' loop
  if item->'snapshot'->>'source_environment' is distinct from batch.source_environment
   or item->'snapshot'->>'source_account' is distinct from batch.source_account
   or item->'settle' is distinct from 'false'::jsonb or not public.ops_historical_guest_eligible(item)
   or nullif(item->>'expected_id','') is not null then raise exception 'Batch guest identity/approval conflict'; end if;
  select * into b from public.ops_bookings where source_environment=batch.source_environment and source_account=batch.source_account
   and beds24_booking_id=(item->'snapshot'->>'beds24_booking_id')::bigint for update;
  if b.id is null or b.property_slug is distinct from item->'snapshot'->>'property_slug'
   or b.beds24_property_id is distinct from (item->'snapshot'->>'beds24_property_id')::bigint
   or b.beds24_room_id is distinct from (item->'snapshot'->>'beds24_room_id')::bigint
   or b.arrival is distinct from (item->'snapshot'->>'arrival')::date
   or b.departure is distinct from (item->'snapshot'->>'departure')::date
   or b.source_status is distinct from item->'snapshot'->>'source_status'
   or b.source_channel is distinct from item->'snapshot'->>'source_channel' then raise exception 'Stored booking differs from approved batch'; end if;
  if exists(select 1 from public.ops_stay_opening_positions where booking_id=b.id) and
   ((select count(*) from public.ops_stay_opening_positions where booking_id=b.id)<>1 or not exists(
    select 1 from public.ops_stay_opening_positions where booking_id=b.id and previous_id is null
    and opening_period and state='open' and owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding'
    and owner_settled_cents=0 and cleaner_settled_cents=0)) then raise exception 'Existing opening decision conflicts; not overwritten'; end if;
 end loop;
 for item in select value from jsonb_array_elements(batch.approved_items) loop
  select * into b from public.ops_bookings where source_environment=batch.source_environment and source_account=batch.source_account
   and beds24_booking_id=(item->'snapshot'->>'beds24_booking_id')::bigint;
  if exists(select 1 from public.ops_stay_opening_positions where booking_id=b.id) then preserved:=preserved+1;
  else
   insert into public.ops_stay_opening_positions(booking_id,request_key,state,opening_period,owner_settlement_state,cleaner_settlement_state,
    owner_settled_cents,cleaner_settled_cents,confirmed_by_bond,created_by,reason)
   values(b.id,md5('september-opening-repair:'||batch.id::text||':'||b.id::text)::uuid,'open',true,'outstanding','outstanding',0,0,false,actor.user_id,
    'Repair of historical batch '||batch.id::text||': '||trim(repair_reason)) returning id into opening_id;
   insert into public.ops_events(actor_user_id,actor_name,actor_role,action,entity_table,entity_id,booking_id,detail,system_run_id)
   values(actor.user_id,actor.display_name,actor.role,'historical.opening_position_repaired','ops_stay_opening_positions',opening_id::text,b.id,
    jsonb_build_object('batch_id',batch.id,'reason',trim(repair_reason),'repair_session',auth.jwt()->>'session_id'),batch.id);
   created:=created+1;
  end if;
 end loop;
 perform public.ops_assert_historical_openings(batch.id);
 return jsonb_build_object('newly_created_opening_count',created,'preserved_opening_count',preserved,'settlement_count',0);
end $$;
revoke all on function public.ops_historical_guest_eligible(jsonb),public.ops_assert_historical_openings(uuid),
 public.ops_apply_historical_batch(uuid),public.ops_repair_september_openings(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.ops_apply_historical_batch(uuid) to service_role;
grant execute on function public.ops_repair_september_openings(uuid,text) to authenticated;
commit;
