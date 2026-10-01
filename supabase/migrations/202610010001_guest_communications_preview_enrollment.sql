-- Staging-only preview enrollment for guest communications.
-- Persists schedule/status only. It does NOT send messages and cannot enable automation.
begin;

-- automation_enrolled_at is local BSTE operational state, not a Beds24 source fact.
-- Allow its one-way NULL -> timestamp transition without weakening source freshness checks.
create or replace function public.ops_guard_snapshot() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.source_environment <> old.source_environment
     or new.source_account <> old.source_account or new.beds24_booking_id <> old.beds24_booking_id then
    raise exception 'Source booking identity cannot change';
  end if;
  if new.source_observed_at < old.source_observed_at
     or (old.source_modified_at is not null and
       (new.source_modified_at is null or new.source_modified_at < old.source_modified_at)) then
    raise exception 'Stale source snapshot';
  end if;
  if new.source_observed_at = old.source_observed_at and
     (to_jsonb(new) - array['last_synced_at','first_imported_at','automation_enrolled_at']) is distinct from
     (to_jsonb(old) - array['last_synced_at','first_imported_at','automation_enrolled_at']) then
    raise exception 'Conflicting snapshot at same observation time';
  end if;
  if old.source_modified_at is not null and new.source_modified_at = old.source_modified_at and
     (to_jsonb(new) - array['source_observed_at','last_synced_at','first_imported_at','automation_enrolled_at']) is distinct from
     (to_jsonb(old) - array['source_observed_at','last_synced_at','first_imported_at','automation_enrolled_at']) then
    raise exception 'Conflicting data at same source revision';
  end if;
  new.first_imported_at := old.first_imported_at;
  new.policy_basis := old.policy_basis;
  if old.automation_enrolled_at is not null
     and new.automation_enrolled_at is distinct from old.automation_enrolled_at then
    raise exception 'Automation enrollment cannot be reset';
  end if;
  return new;
end;
$$;

create or replace function public.ops_preview_communication_route(source_kind_value text, source_channel_value text)
returns text language sql immutable set search_path='' as $$
  select case
    when lower(coalesce(source_kind_value,''))='manual_direct'
      or lower(trim(coalesce(source_channel_value,''))) in ('direct','direct bste','bookingpage','website','bste direct','direct / bste website')
      then 'direct_email'
    when lower(coalesce(source_channel_value,'')) like '%airbnb%' then 'beds24_airbnb'
    when lower(trim(coalesce(source_channel_value,'')))='booking'
      or lower(coalesce(source_channel_value,'')) like '%booking.com%' then 'beds24_bookingcom'
    when length(trim(coalesce(source_channel_value,'')))>0 then 'beds24_other'
    else 'unresolved'
  end;
$$;

create or replace function public.ops_preview_reconcile_communications(target_booking uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
  b public.ops_bookings;
  msg record;
  v_route text;
  v_due timestamptz;
  v_status text;
  v_reason text;
  v_anchor date;
  v_source_status text;
begin
  select * into b from public.ops_bookings where id=target_booking;
  if not found or b.automation_enrolled_at is null then return; end if;

  v_route := public.ops_preview_communication_route(b.source_kind,b.source_channel);
  v_source_status := lower(trim(coalesce(b.source_status,'')));

  for msg in
    select * from (values
      ('booking_confirmation'::text,'enrollment'::text,0::integer,null::time),
      ('pre_arrival','arrival',-3,'09:00'::time),
      ('arrival_morning','arrival',0,'09:00'::time),
      ('arrival_evening_essentials','arrival',0,'20:00'::time),
      ('departure_eve','departure',-1,'18:00'::time),
      ('departure_morning','departure',0,'08:00'::time),
      ('post_stay','departure',1,'10:00'::time)
    ) as x(message_key,anchor_name,offset_days,local_time)
  loop
    if msg.anchor_name='enrollment' then
      v_due := b.automation_enrolled_at;
    else
      v_anchor := case when msg.anchor_name='arrival' then b.arrival else b.departure end;
      v_due := ((v_anchor + msg.offset_days) + msg.local_time) at time zone 'Africa/Johannesburg';
    end if;

    v_status := 'scheduled';
    v_reason := null;

    if v_source_status in ('cancelled','canceled','black','blocked') then
      v_status := 'skipped'; v_reason := 'booking_cancelled';
    elsif v_source_status not in ('new','confirmed') then
      v_status := 'skipped'; v_reason := 'booking_not_confirmed';
    elsif v_route='unresolved' then
      v_status := 'skipped'; v_reason := 'communication_route_unresolved';
    elsif msg.message_key='booking_confirmation' then
      v_status := 'skipped'; v_reason := 'existing_booking_confirmation_not_retroactive';
    elsif v_due < b.automation_enrolled_at then
      v_status := 'skipped'; v_reason := 'window_passed_before_enrollment';
    end if;

    insert into public.ops_communications(
      booking_id,message_key,route,scheduled_at,status,automation_enabled,reason,updated_at
    ) values (
      b.id,msg.message_key,v_route,v_due,v_status,false,v_reason,clock_timestamp()
    )
    on conflict (booking_id,message_key) do update set
      route=excluded.route,
      scheduled_at=excluded.scheduled_at,
      status=excluded.status,
      automation_enabled=false,
      reason=excluded.reason,
      updated_at=clock_timestamp()
    where public.ops_communications.status not in ('sent','failed')
      and not (
        public.ops_communications.status='skipped'
        and coalesce(public.ops_communications.reason,'') like 'manual\_%' escape '\'
      );
  end loop;
end;
$$;

-- Reconcile only when facts that affect timing/route/eligibility actually change.
create or replace function public.ops_preview_communications_source_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.automation_enrolled_at is null then return new; end if;
  if TG_OP='INSERT'
     or new.automation_enrolled_at is distinct from old.automation_enrolled_at
     or new.arrival is distinct from old.arrival
     or new.departure is distinct from old.departure
     or new.source_status is distinct from old.source_status
     or new.source_channel is distinct from old.source_channel
     or new.property_slug is distinct from old.property_slug then
    perform public.ops_preview_reconcile_communications(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists preview_communications_source on public.ops_bookings;
create trigger preview_communications_source
after insert or update on public.ops_bookings
for each row execute function public.ops_preview_communications_source_changed();

create or replace function public.ops_preview_enroll_communications(target_booking uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  b public.ops_bookings;
  enrolled timestamptz;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated' or not public.ops_can('operations.write') then
    raise exception 'Operational permission required';
  end if;

  select * into b from public.ops_bookings
   where id=target_booking and source_environment='production'
   for update;
  if not found then raise exception 'Booking unavailable'; end if;
  if b.source_kind is distinct from 'beds24' then
    raise exception 'Preview enrollment currently supports Beds24 bookings only';
  end if;

  if b.automation_enrolled_at is null then
    update public.ops_bookings
       set automation_enrolled_at=clock_timestamp()
     where id=b.id
     returning automation_enrolled_at into enrolled;
  else
    enrolled := b.automation_enrolled_at;
    perform public.ops_preview_reconcile_communications(b.id);
  end if;

  select jsonb_build_object(
    'booking_id',b.id,
    'automation_enrolled_at',enrolled,
    'preview_only',true,
    'live_sending_enabled',false,
    'communications',coalesce((
      select jsonb_agg(jsonb_build_object(
        'message_key',m.message_key,
        'route',m.route,
        'scheduled_at',m.scheduled_at,
        'status',m.status,
        'automation_enabled',m.automation_enabled,
        'reason',m.reason
      ) order by m.scheduled_at,m.message_key)
      from public.ops_communications m where m.booking_id=b.id
    ),'[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- Internal helpers are trigger/RPC implementation details only.
revoke all privileges on function public.ops_preview_communication_route(text,text) from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_preview_reconcile_communications(uuid) from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_preview_communications_source_changed() from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_preview_enroll_communications(uuid) from public,anon,authenticated,service_role;
grant execute on function public.ops_preview_enroll_communications(uuid) to authenticated;

commit;
