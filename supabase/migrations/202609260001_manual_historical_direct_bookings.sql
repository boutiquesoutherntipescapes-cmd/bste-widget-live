-- Staging review only. No booking is created by this migration.
begin;
alter table public.ops_bookings
 add column source_kind text not null default 'beds24',
 add column manual_reference text,
 add column manual_booked_on date,
 add column manual_note text,
 add column manual_created_by uuid references public.ops_staff(user_id),
 alter column beds24_booking_id drop not null,
 alter column first_imported_at drop not null,
 alter column last_synced_at drop not null;
alter table public.ops_bookings add constraint ops_booking_source_identity check(
 (source_kind='beds24' and beds24_booking_id is not null and beds24_booking_id>0
  and first_imported_at is not null and last_synced_at is not null
  and manual_reference is null and manual_booked_on is null and manual_note is null and manual_created_by is null)
 or (source_kind='manual_direct' and beds24_booking_id is null and source_environment='production'
  and source_account='bste-historical-direct' and source_channel='direct / BSTE website'
  and source_status='confirmed' and manual_reference is not null and length(manual_reference) between 1 and 100
  and manual_booked_on is not null and manual_booked_on<=arrival
  and manual_created_by is not null and first_imported_at is null and last_synced_at is null
  and automation_enrolled_at is null));
create unique index ops_manual_booking_reference on public.ops_bookings(source_environment,source_account,manual_reference) where source_kind='manual_direct';
-- Source identities cannot cross between namespaces. Historical manual rows are immutable.
create function public.ops_guard_manual_source() returns trigger language plpgsql set search_path='' as $$
begin
 if old.source_kind='manual_direct' then
  raise exception 'Manual historical booking identity is immutable; use an audited future correction workflow'; end if;
 if tg_op='DELETE' then return old; end if;
 if new.source_kind is distinct from old.source_kind then raise exception 'Source namespace is immutable'; end if;
 return new;
end $$;
create trigger guard_manual_source before update or delete on public.ops_bookings for each row execute function public.ops_guard_manual_source();
revoke all on function public.ops_guard_manual_source() from public,anon,authenticated,service_role;
create or replace function public.ops_sync_booking(snapshot jsonb, financial jsonb, run_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare b public.ops_bookings; f public.ops_booking_financial_snapshots; result_id uuid;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null or run_id is null then
    raise exception 'System importer only';
  end if;
  if snapshot is null or jsonb_typeof(snapshot) <> 'object'
    or (financial is not null and jsonb_typeof(financial) <> 'object') then
    raise exception 'Snapshot object required';
  end if;
  if coalesce(snapshot->>'source_kind','beds24')<>'beds24'
   or snapshot->>'beds24_booking_id' is null or (snapshot->>'beds24_booking_id')::bigint<=0
   or snapshot ? 'manual_reference' or snapshot ? 'manual_created_by'
   or snapshot->>'source_account'='bste-historical-direct' then raise exception 'Beds24 importer cannot write manual direct bookings'; end if;
  perform set_config('bste.system_actor', 'beds24_importer', true);
  perform set_config('bste.system_run_id', run_id::text, true);
  b := jsonb_populate_record(null::public.ops_bookings, snapshot);
  -- Concurrent calls serialize via the unique source key and ON CONFLICT row lock.
  insert into public.ops_bookings(source_environment, source_account, beds24_booking_id,
    property_slug, beds24_property_id, beds24_room_id, arrival, departure, source_status,
    source_channel, guest_name, guest_email, guest_mobile, adults, children,
    source_modified_at, source_observed_at)
  values (b.source_environment, b.source_account, b.beds24_booking_id, b.property_slug,
    b.beds24_property_id, b.beds24_room_id, b.arrival, b.departure, b.source_status,
    b.source_channel, b.guest_name, b.guest_email, b.guest_mobile, b.adults, b.children,
    b.source_modified_at, b.source_observed_at)
  on conflict (source_environment, source_account, beds24_booking_id) do update set
    property_slug = excluded.property_slug, beds24_property_id = excluded.beds24_property_id,
    beds24_room_id = excluded.beds24_room_id, arrival = excluded.arrival, departure = excluded.departure,
    source_status = excluded.source_status, source_channel = excluded.source_channel,
    guest_name = excluded.guest_name, guest_email = excluded.guest_email, guest_mobile = excluded.guest_mobile,
    adults = excluded.adults, children = excluded.children,
    source_modified_at = excluded.source_modified_at, source_observed_at = excluded.source_observed_at,
    last_synced_at = clock_timestamp()
  returning id into result_id;
  -- NULL financial means not fetched: preserve previous financial data.
  if financial is not null then
    f := jsonb_populate_record(null::public.ops_booking_financial_snapshots, financial);
    if f.source_observed_at is distinct from b.source_observed_at
      or f.source_modified_at is distinct from b.source_modified_at then
      raise exception 'Financial snapshot must come from the same source observation';
    end if;
    insert into public.ops_booking_financial_snapshots(booking_id, source_price, source_currency,
      source_deposit, source_invoice_items, source_modified_at, source_observed_at)
    values (result_id, f.source_price, f.source_currency, f.source_deposit, f.source_invoice_items,
      f.source_modified_at, f.source_observed_at)
    on conflict (booking_id) do update set source_price = excluded.source_price,
      source_currency = excluded.source_currency, source_deposit = excluded.source_deposit,
      source_invoice_items = excluded.source_invoice_items, source_modified_at = excluded.source_modified_at,
      source_observed_at = excluded.source_observed_at;
  end if;
  perform set_config('bste.system_actor', '', true);
  perform set_config('bste.system_run_id', '', true);
  return result_id;
end;
$$;
revoke all on function public.ops_sync_booking(jsonb,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.ops_sync_booking(jsonb,jsonb,uuid) to service_role;

-- Deliberately narrow first manual historical workflow. No arbitrary guest payload
-- or identity-document fields are accepted. No payments/openings/communications.
create function public.ops_create_charl_historical_direct(expected_overlap_ids uuid[],overlaps_reviewed boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; existing public.ops_bookings; v_overlap_ids uuid[];
begin
 if auth.role() is distinct from 'authenticated' or auth.jwt()->>'aal' is distinct from 'aal2'
  or not public.ops_can('operations.write') or not public.ops_can('finance.write') or not public.ops_can('finance.cutover')
  or not exists(select 1 from public.ops_staff where user_id=auth.uid() and is_active and role='administrator') then
  raise exception 'Active MFA administrator with finance/cutover authority required'; end if;
 if current_date<'2026-09-12'::date then raise exception 'Historical completed stay only'; end if;
 perform pg_advisory_xact_lock(hashtextextended('bste-manual-historical:kalay-ridge-villa-struisbaai',0));
 select * into existing from public.ops_bookings where source_kind='manual_direct'
  and source_environment='production' and source_account='bste-historical-direct' and manual_reference='BSTE-HIST-202609-KAL-01' for update;
 if existing.id is not null then
  if existing.property_slug<>'kalay-ridge-villa-struisbaai' or existing.beds24_property_id<>352005 or existing.beds24_room_id<>726060
   or existing.arrival<>'2026-09-08'::date or existing.departure<>'2026-09-12'::date
   or existing.guest_name is distinct from 'Charl Baard' or existing.adults is distinct from 5
   or existing.manual_booked_on is distinct from '2026-07-27'::date or existing.manual_note is distinct from 'NAMPO direct booking' then
   raise exception 'Historical direct reference conflicts with saved identity'; end if;
  return existing.id;
 end if;
 if exists(select 1 from public.ops_bookings where property_slug='kalay-ridge-villa-struisbaai'
  and arrival='2026-09-08'::date and departure='2026-09-12'::date and lower(trim(guest_name))='charl baard') then
  raise exception 'Possible existing guest booking; inspect before creating'; end if;
 select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_overlap_ids from public.ops_bookings
  where property_slug='kalay-ridge-villa-struisbaai' and arrival<'2026-09-12'::date and departure>'2026-09-08'::date;
 if expected_overlap_ids is null or v_overlap_ids is distinct from (select coalesce(array_agg(x order by x),'{}'::uuid[]) from unnest(expected_overlap_ids) x)
  or (cardinality(v_overlap_ids)>0 and overlaps_reviewed is distinct from true) then raise exception 'Historical overlaps must be explicitly reviewed from a current preview'; end if;
 insert into public.ops_bookings(source_kind,source_environment,source_account,beds24_booking_id,
  property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,
  guest_name,adults,source_observed_at,first_imported_at,last_synced_at,manual_reference,manual_booked_on,manual_note,manual_created_by)
 values('manual_direct','production','bste-historical-direct',null,'kalay-ridge-villa-struisbaai',352005,726060,
  '2026-09-08','2026-09-12','confirmed','direct / BSTE website','Charl Baard',5,clock_timestamp(),null,null,
  'BSTE-HIST-202609-KAL-01','2026-07-27','NAMPO direct booking',auth.uid()) returning id into result;
 -- Preserve the overlap acknowledgement as well as the normal row audit.
 insert into public.ops_events(actor_user_id,actor_name,actor_role,action,entity_table,entity_id,booking_id,detail)
 select auth.uid(),display_name,role,'manual_historical.authorized','ops_bookings',result::text,result,
 jsonb_build_object('overlap_ids',v_overlap_ids,'overlaps_reviewed',overlaps_reviewed,'reason','Approved completed NAMPO direct stay')
 from public.ops_staff where user_id=auth.uid();
 return result;
end $$;
revoke all on function public.ops_create_charl_historical_direct(uuid[],boolean) from public,anon,authenticated,service_role;
grant execute on function public.ops_create_charl_historical_direct(uuid[],boolean) to authenticated;
create or replace function public.ops_dashboard_rows(account_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if not public.ops_can('operations.read') then raise exception 'Staff access required'; end if;
 select coalesce(jsonb_agg(to_jsonb(rows) order by arrival,id),'[]'::jsonb) into result from (
   select b.*, o.operational_status,o.reason as operational_reason,
    public.ops_can('finance.read') as payment_visible,
    case when public.ops_can('finance.read') then p.review_status end as payment_status,
    case when public.ops_can('finance.read') then p.note end as payment_note,
    case when public.ops_can('finance.read') then p.created_at end as payment_reviewed_at,
    b.source_kind='beds24' and exists(select 1 from public.ops_sync_runs where source_account=account_key and status='succeeded')
     and not exists(select 1 from public.ops_sync_members m where m.booking_id=b.id and m.run_id=
       (select id from public.ops_sync_runs where source_account=account_key and status='succeeded' order by started_at desc limit 1)) as not_seen_in_latest_sync
   from public.ops_bookings b
   left join lateral (select operational_status,reason from public.ops_booking_overrides where booking_id=b.id order by created_at desc,id desc limit 1) o on true
   left join lateral (select review_status,note,created_at from public.ops_payment_records where booking_id=b.id and entry_kind='review' order by created_at desc,id desc limit 1) p on true
   where b.source_environment='production' and (b.source_account=account_key or (b.source_kind='manual_direct' and b.source_account='bste-historical-direct'))
    and b.departure >= (now() at time zone 'Africa/Johannesburg')::date
   order by b.arrival,b.id limit 2001
 ) rows;
 if jsonb_array_length(result)>2000 then raise exception 'Dashboard capacity exceeded'; end if;
 return result;
end $$;

revoke all on function public.ops_dashboard_rows(text) from public,anon,authenticated,service_role;
grant execute on function public.ops_dashboard_rows(text) to authenticated;
commit;
