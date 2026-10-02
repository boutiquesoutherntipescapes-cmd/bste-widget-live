-- Guest automation master-switch and auto-enrollment preparation.
-- SAFETY: master switch defaults OFF and the existing automation_enabled=false
-- constraint remains untouched. Applying this migration cannot enable delivery.
begin;

create table if not exists public.ops_guest_automation_settings (
  singleton boolean primary key default true check (singleton),
  bookingcom_enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

insert into public.ops_guest_automation_settings(singleton,bookingcom_enabled)
values(true,false)
on conflict(singleton) do nothing;

alter table public.ops_bookings
  add column if not exists automation_enrollment_kind text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='ops_booking_automation_enrollment_kind'
      and conrelid='public.ops_bookings'::regclass
  ) then
    alter table public.ops_bookings
      add constraint ops_booking_automation_enrollment_kind
      check (
        automation_enrollment_kind is null
        or automation_enrollment_kind in (
          'manual_preview',
          'existing_activation',
          'live_new_booking'
        )
      );
  end if;
end;
$$;

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
     (to_jsonb(new) - array[
       'last_synced_at','first_imported_at',
       'automation_enrolled_at','automation_enrollment_kind'
     ]) is distinct from
     (to_jsonb(old) - array[
       'last_synced_at','first_imported_at',
       'automation_enrolled_at','automation_enrollment_kind'
     ]) then
    raise exception 'Conflicting snapshot at same observation time';
  end if;
  if old.source_modified_at is not null and new.source_modified_at = old.source_modified_at and
     (to_jsonb(new) - array[
       'source_observed_at','last_synced_at','first_imported_at',
       'automation_enrolled_at','automation_enrollment_kind'
     ]) is distinct from
     (to_jsonb(old) - array[
       'source_observed_at','last_synced_at','first_imported_at',
       'automation_enrolled_at','automation_enrollment_kind'
     ]) then
    raise exception 'Conflicting data at same source revision';
  end if;

  new.first_imported_at := old.first_imported_at;
  new.policy_basis := old.policy_basis;

  if old.automation_enrolled_at is not null
     and new.automation_enrolled_at is distinct from old.automation_enrolled_at then
    raise exception 'Automation enrollment cannot be reset';
  end if;

  if old.automation_enrollment_kind is not null
     and new.automation_enrollment_kind is distinct from old.automation_enrollment_kind then
    raise exception 'Automation enrollment kind cannot change';
  end if;

  if (new.automation_enrolled_at is null) is distinct from
     (new.automation_enrollment_kind is null) then
    raise exception 'Automation enrollment metadata must be paired';
  end if;

  return new;
end;
$$;

update public.ops_bookings
   set automation_enrollment_kind='manual_preview'
 where automation_enrolled_at is not null
   and automation_enrollment_kind is null;

create or replace function public.ops_guest_bookingcom_enabled()
returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce((
    select bookingcom_enabled
    from public.ops_guest_automation_settings
    where singleton=true
  ),false);
$$;

create or replace function public.ops_guest_auto_enroll_booking()
returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_channel text;
begin
  if not public.ops_guest_bookingcom_enabled() then
    return new;
  end if;

  v_channel := lower(trim(coalesce(new.source_channel,'')));

  if new.source_kind='beds24'
     and new.source_environment='production'
     and lower(trim(coalesce(new.source_status,''))) in ('new','confirmed')
     and (v_channel='booking' or v_channel like '%booking.com%')
     and new.automation_enrolled_at is null then
    new.automation_enrolled_at := clock_timestamp();
    new.automation_enrollment_kind :=
      case when TG_OP='INSERT' then 'live_new_booking'
           else 'existing_activation' end;
  end if;

  return new;
end;
$$;

drop trigger if exists guest_auto_enroll_booking on public.ops_bookings;
create trigger guest_auto_enroll_booking
before insert or update on public.ops_bookings
for each row execute function public.ops_guest_auto_enroll_booking();

create or replace function public.ops_reconcile_guest_communications(target_booking uuid)
returns void
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
  v_master_enabled boolean;
  v_automation_enabled boolean;
begin
  select * into b from public.ops_bookings where id=target_booking;
  if not found or b.automation_enrolled_at is null then return; end if;

  v_route := public.ops_preview_communication_route(b.source_kind,b.source_channel);
  v_source_status := lower(trim(coalesce(b.source_status,'')));
  v_master_enabled := public.ops_guest_bookingcom_enabled();

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
      v_due := ((v_anchor + msg.offset_days) + msg.local_time)
        at time zone 'Africa/Johannesburg';
    end if;

    v_status := 'scheduled';
    v_reason := null;

    if v_source_status in ('cancelled','canceled','black','blocked') then
      v_status := 'skipped';
      v_reason := 'booking_cancelled';
    elsif v_source_status not in ('new','confirmed') then
      v_status := 'skipped';
      v_reason := 'booking_not_confirmed';
    elsif v_route='unresolved' then
      v_status := 'skipped';
      v_reason := 'communication_route_unresolved';
    elsif msg.message_key='booking_confirmation'
       and b.automation_enrollment_kind is distinct from 'live_new_booking' then
      v_status := 'skipped';
      v_reason := 'existing_booking_confirmation_not_retroactive';
    elsif v_due < b.automation_enrolled_at then
      v_status := 'skipped';
      v_reason := 'window_passed_before_enrollment';
    end if;

    v_automation_enabled :=
      v_master_enabled
      and v_status='scheduled'
      and v_route='beds24_bookingcom';

    insert into public.ops_communications(
      booking_id,message_key,route,scheduled_at,status,
      automation_enabled,reason,updated_at
    ) values (
      b.id,msg.message_key,v_route,v_due,v_status,
      v_automation_enabled,v_reason,clock_timestamp()
    )
    on conflict (booking_id,message_key) do update set
      route=excluded.route,
      scheduled_at=excluded.scheduled_at,
      status=excluded.status,
      automation_enabled=excluded.automation_enabled,
      reason=excluded.reason,
      updated_at=clock_timestamp()
    where public.ops_communications.status not in ('sent','failed')
      and public.ops_communications.claim_token is null
      and not (
        public.ops_communications.status='skipped'
        and coalesce(public.ops_communications.reason,'') like 'manual\_%' escape '\'
      );
  end loop;
end;
$$;

create or replace function public.ops_preview_reconcile_communications(target_booking uuid)
returns void
language plpgsql security definer set search_path='' as $$
begin
  perform public.ops_reconcile_guest_communications(target_booking);
end;
$$;

create or replace function public.ops_preview_communications_source_changed()
returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.automation_enrolled_at is null then return new; end if;

  if TG_OP='INSERT'
     or new.automation_enrolled_at is distinct from old.automation_enrolled_at
     or new.automation_enrollment_kind is distinct from old.automation_enrollment_kind
     or new.arrival is distinct from old.arrival
     or new.departure is distinct from old.departure
     or new.source_status is distinct from old.source_status
     or new.source_channel is distinct from old.source_channel
     or new.property_slug is distinct from old.property_slug then
    perform public.ops_reconcile_guest_communications(new.id);
  end if;

  return new;
end;
$$;

create or replace function public.ops_preview_enroll_communications(target_booking uuid)
returns jsonb
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
       set automation_enrolled_at=clock_timestamp(),
           automation_enrollment_kind='manual_preview'
     where id=b.id
     returning automation_enrolled_at into enrolled;
  else
    enrolled := b.automation_enrolled_at;
    perform public.ops_reconcile_guest_communications(b.id);
  end if;

  select jsonb_build_object(
    'booking_id',b.id,
    'automation_enrolled_at',enrolled,
    'preview_only',true,
    'live_sending_enabled',public.ops_guest_bookingcom_enabled(),
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

-- Narrow service-only sync used by the guest worker. It intentionally does not
-- overwrite financial snapshots or raw Beds24 payload storage.
create or replace function public.ops_guest_sync_booking(snapshot jsonb)
returns uuid
language plpgsql security definer set search_path='' as $$
declare
  result uuid;
  run_id uuid := gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest worker service only';
  end if;

  if snapshot is null or jsonb_typeof(snapshot)<>'object'
     or coalesce(snapshot->>'source_kind','beds24')<>'beds24'
     or snapshot->>'beds24_booking_id' is null
     or snapshot->>'source_environment' is distinct from 'production' then
    raise exception 'Invalid guest booking snapshot';
  end if;

  result := public.ops_sync_booking(snapshot,null,run_id);
  return result;
end;
$$;

alter table public.ops_guest_automation_settings enable row level security;
revoke all on public.ops_guest_automation_settings
  from public,anon,authenticated,service_role;

drop trigger if exists audit_change on public.ops_guest_automation_settings;
create trigger audit_change
after insert or update on public.ops_guest_automation_settings
for each row execute function public.ops_audit_change();

revoke all privileges on function public.ops_guest_bookingcom_enabled()
  from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_guest_auto_enroll_booking()
  from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_reconcile_guest_communications(uuid)
  from public,anon,authenticated,service_role;
revoke all privileges on function public.ops_guest_sync_booking(jsonb)
  from public,anon,authenticated,service_role;

grant execute on function public.ops_guest_sync_booking(jsonb) to service_role;

commit;
