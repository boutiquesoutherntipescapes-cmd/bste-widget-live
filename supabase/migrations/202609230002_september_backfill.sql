-- LOCAL REVIEW ONLY. Requires Phase 1. Never apply automatically.
-- Historical scope does not use or update normal sync run/membership tables.
begin;
create table public.ops_historical_batches (
 id uuid primary key default gen_random_uuid(),source_environment text not null default 'production' check(source_environment='production'),
 source_account text not null,preview_digest text not null check(preview_digest ~ '^[a-f0-9]{64}$'),
 scope_from date not null default '2026-09-01' check(scope_from='2026-09-01'),
 scope_through date not null default '2026-09-23' check(scope_through='2026-09-23'),
 approved_items jsonb not null check(jsonb_typeof(approved_items)='array'),approval_reason text not null check(length(trim(approval_reason)) between 1 and 2000),
 approved_by uuid not null references public.ops_staff(user_id),approved_session uuid not null,
 approved_at timestamptz not null default clock_timestamp(),bond_confirmed boolean not null check(bond_confirmed),
 unique(source_account,preview_digest)
);
create table public.ops_historical_results (
 batch_id uuid primary key references public.ops_historical_batches,
 applied_at timestamptz not null default clock_timestamp(),booking_count integer not null,
 settlement_count integer not null,retained_opening_count integer not null
);
alter table public.ops_historical_batches enable row level security;
alter table public.ops_historical_results enable row level security;
revoke all on public.ops_historical_batches,public.ops_historical_results from public,anon,authenticated,service_role;
grant select on public.ops_historical_batches,public.ops_historical_results to authenticated;
create policy history_admin on public.ops_historical_batches for select to authenticated using(public.ops_can('finance.cutover') and public.ops_can('sync.run'));
create policy history_admin on public.ops_historical_results for select to authenticated using(public.ops_can('finance.cutover') and public.ops_can('sync.run'));
create trigger immutable before update or delete on public.ops_historical_batches for each row execute function public.ops_no_change();
create trigger immutable before update or delete on public.ops_historical_results for each row execute function public.ops_no_change();
create trigger audit_history after insert on public.ops_historical_batches for each row execute function public.ops_audit_change();

create function public.ops_stage_historical_batch(account_key text,preview_digest text,approved_items jsonb,approval_reason text,bond_confirmed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare prior public.ops_historical_batches; item jsonb; result uuid;
begin
 if not public.ops_can('finance.cutover') or not public.ops_can('sync.run') or not exists(select 1 from public.ops_staff where user_id=auth.uid() and role='administrator') then raise exception 'MFA administrator historical approval required'; end if;
 if bond_confirmed is distinct from true then raise exception 'Bond confirmation required'; end if;
 if account_key is null or account_key !~ '^[a-zA-Z0-9_-]{1,120}$' then raise exception 'Source account required'; end if;
 if jsonb_typeof(approved_items) is distinct from 'array' or jsonb_array_length(approved_items) not between 1 and 2000 then raise exception 'Invalid historical batch'; end if;
 if (select count(distinct value->'snapshot'->>'beds24_booking_id') from jsonb_array_elements(approved_items))<>jsonb_array_length(approved_items) then raise exception 'Duplicate historical source identity'; end if;
 for item in select value from jsonb_array_elements(approved_items) loop
  if item->'snapshot'->>'source_environment' is distinct from 'production' or item->'snapshot'->>'source_account' is distinct from account_key
   or (item->'snapshot'->>'departure')::date not between '2026-09-01'::date and '2026-09-23'::date
   or item->'snapshot'->>'departure' is null
   or not exists(select 1 from public.ops_properties p where p.property_slug=item->'snapshot'->>'property_slug'
     and p.beds24_property_id=(item->'snapshot'->>'beds24_property_id')::bigint and p.beds24_room_id=(item->'snapshot'->>'beds24_room_id')::bigint
     and (p.beds24_property_id,p.beds24_room_id) in ((351452,724919),(352005,726060),(352276,726696)))
   then raise exception 'Historical scope violation'; end if;
  if coalesce((item->>'settle')::boolean,false) and (item->'raw'->>'isBlocked'='true' or item->'raw'->>'ownerStay'='true'
   or exists(select 1 from jsonb_each_text(item->'raw') x where x.key in ('type','bookingType','booking_type','subType')
    and x.value ~* '^(owner([ _-]stay)?|block(ed)?|maintenance|non[ _-]guest)$')) then raise exception 'Non-guest reservation cannot be batch-settled'; end if;
  if coalesce((item->>'settle')::boolean,false) and lower(item->'snapshot'->>'source_status') not in ('new','confirmed') then raise exception 'Exceptional reservation cannot be batch-settled'; end if;
  if lower(item->'snapshot'->>'source_status') not in ('new','confirmed','request','inquiry','cancelled','black') or item->'snapshot'->>'source_status' is null then raise exception 'Unsupported historical status'; end if;
  if item->'snapshot'->>'source_observed_at' is null or (item->'snapshot'->>'source_observed_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (item->'snapshot'->>'source_observed_at')::timestamptz>clock_timestamp()+interval '1 minute' then raise exception 'Fresh historical preview required'; end if;
 end loop;
 perform pg_advisory_xact_lock(hashtextextended('history-preview:'||account_key||':'||preview_digest,0));
 select * into prior from public.ops_historical_batches b where b.source_account=account_key and b.preview_digest=ops_stage_historical_batch.preview_digest;
 if prior.id is not null then
  if prior.approved_items is distinct from approved_items or prior.approved_by<>auth.uid() or prior.approval_reason is distinct from approval_reason then raise exception 'Preview already approved with different selection or actor'; end if;
  return prior.id;
 end if;
 insert into public.ops_historical_batches(source_account,preview_digest,approved_items,approval_reason,approved_by,approved_session,bond_confirmed)
 values(account_key,preview_digest,approved_items,approval_reason,auth.uid(),(auth.jwt()->>'session_id')::uuid,true) returning id into result;
 return result;
end $$;

create function public.ops_apply_historical_batch(batch_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare batch public.ops_historical_batches; existing public.ops_bookings; item jsonb; booking uuid;
 result public.ops_historical_results; n integer:=0; settled integer:=0; retained integer:=0;
 actor public.ops_staff; opening_id uuid;
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'Historical importer only'; end if;
 select * into batch from public.ops_historical_batches where id=batch_id for update;
 if batch.id is null then raise exception 'Approved preview required'; end if;
 select * into result from public.ops_historical_results r where r.batch_id=ops_apply_historical_batch.batch_id;
 if result.batch_id is not null then return to_jsonb(result); end if;
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
  if lower(item->'snapshot'->>'source_status') in ('new','confirmed') and not coalesce((item->'raw'->>'isBlocked')::boolean,false) and not coalesce((item->'raw'->>'ownerStay')::boolean,false)
   and not exists(select 1 from jsonb_each_text(item->'raw') x where x.key in ('type','bookingType','booking_type','subType') and x.value ~* '^(owner([ _-]stay)?|block(ed)?|maintenance|non[ _-]guest)$') then
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
    if coalesce((item->>'settle')::boolean,false) then settled:=settled+1; end if;
   end if;
  end if;
  n:=n+1;
 end loop;
 insert into public.ops_historical_results(batch_id,booking_count,settlement_count,retained_opening_count)
 values(batch.id,n,settled,retained) returning * into result;
 return to_jsonb(result);
end $$;
revoke all on function public.ops_stage_historical_batch(text,text,jsonb,text,boolean),public.ops_apply_historical_batch(uuid) from public,anon,authenticated,service_role;
grant execute on function public.ops_stage_historical_batch(text,text,jsonb,text,boolean) to authenticated;
grant execute on function public.ops_apply_historical_batch(uuid) to service_role;
commit;
