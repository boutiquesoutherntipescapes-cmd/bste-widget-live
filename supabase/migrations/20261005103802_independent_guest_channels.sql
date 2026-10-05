-- Independent Airbnb/direct switches default OFF. Booking.com remains unchanged.
-- The claim consumes the row's enable flag atomically, preserving the existing
-- prohibition against re-enabling a claimed communication.
begin;
alter table public.ops_guest_automation_settings
  add column if not exists airbnb_enabled boolean not null default false,
  add column if not exists direct_enabled boolean not null default false;
create or replace function public.ops_guest_route_enabled(route_value text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select case route_value
   when 'beds24_bookingcom' then bookingcom_enabled
   when 'beds24_airbnb' then airbnb_enabled
   when 'direct_email' then direct_enabled
   else false end from public.ops_guest_automation_settings where singleton=true),false);
$$;
create or replace function public.ops_guest_valid_email(email_value text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(length(email_value)<=254 and email_value ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$',false);
$$;
create or replace function public.ops_guest_auto_enroll_booking()
returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_channel text;
begin
  if not public.ops_guest_route_enabled(public.ops_preview_communication_route(new.source_kind,new.source_channel)) then
    return new;
  end if;

  v_channel := lower(trim(coalesce(new.source_channel,'')));

  if new.source_kind='beds24'
     and new.source_environment='production'
     and lower(trim(coalesce(new.source_status,''))) in ('new','confirmed')
     and (public.ops_preview_communication_route(new.source_kind,new.source_channel)<>'direct_email' or public.ops_guest_valid_email(new.guest_email))
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
  v_master_enabled := public.ops_guest_route_enabled(v_route);

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
      and v_route in ('beds24_bookingcom','beds24_airbnb','direct_email')
      and (v_route<>'direct_email' or public.ops_guest_valid_email(b.guest_email));

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

create or replace function public.ops_guard_guest_communication_enable()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.automation_enabled is true then
    if not public.ops_guest_route_enabled(new.route) then
      raise exception 'Guest automation master switch is disabled';
    end if;

    if new.status is distinct from 'scheduled' then
      raise exception 'Only scheduled communications may be automated';
    end if;

    if new.route not in ('beds24_bookingcom','beds24_airbnb','direct_email') then
      raise exception 'Unsupported guest communication route';
    end if;

    if new.claim_token is not null or new.claimed_at is not null then
      raise exception 'Claimed communications cannot be re-enabled';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.ops_claim_guest_communication(
  target_communication uuid,
  requested_claim_token uuid,
  observed_at timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  c public.ops_communications;
  b public.ops_bookings;
  v_source_status text;
  v_channel text;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest worker service only';
  end if;

  if target_communication is null or requested_claim_token is null or observed_at is null then
    raise exception 'Communication, claim token and observation time are required';
  end if;

  select * into c
    from public.ops_communications
   where id = target_communication
   for update;

  if not found then
    return jsonb_build_object('claimed',false,'reason','communication_missing');
  end if;

  if not public.ops_guest_route_enabled(c.route) then
    return jsonb_build_object('claimed',false,'reason','master_switch_disabled');
  end if;

  select * into b
    from public.ops_bookings
   where id = c.booking_id;

  if not found then
    return jsonb_build_object(
      'claimed',false,'reason','booking_missing','communication_id',c.id
    );
  end if;

  if c.claim_token is not null then
    return jsonb_build_object(
      'claimed',false,'reason','already_claimed','communication_id',c.id
    );
  end if;

  if c.status is distinct from 'scheduled' then
    return jsonb_build_object(
      'claimed',false,'reason','communication_not_scheduled','communication_id',c.id
    );
  end if;

  if c.automation_enabled is distinct from true then
    return jsonb_build_object(
      'claimed',false,'reason','automation_not_enabled','communication_id',c.id
    );
  end if;

  if c.route not in ('beds24_bookingcom','beds24_airbnb','direct_email') then
    return jsonb_build_object(
      'claimed',false,'reason','unsupported_live_route','communication_id',c.id
    );
  end if;

  if b.source_kind is distinct from 'beds24' then
    return jsonb_build_object('claimed',false,'reason','unsupported_source_kind');
  end if;

  if b.source_environment is distinct from 'production' then
    return jsonb_build_object(
      'claimed',false,'reason','booking_environment_mismatch','communication_id',c.id
    );
  end if;

  v_source_status := lower(trim(coalesce(b.source_status,'')));
  if v_source_status not in ('new','confirmed') then
    return jsonb_build_object(
      'claimed',false,
      'reason',case
        when v_source_status in ('cancelled','canceled') then 'booking_cancelled'
        else 'booking_not_confirmed'
      end,
      'communication_id',c.id
    );
  end if;

  v_channel := lower(trim(coalesce(b.source_channel,'')));
  if c.route is distinct from public.ops_preview_communication_route(b.source_kind,b.source_channel) then
    return jsonb_build_object(
      'claimed',false,'reason','booking_channel_mismatch','communication_id',c.id
    );
  end if;

  if b.source_kind='beds24' and (b.beds24_booking_id is null or b.beds24_booking_id <= 0) then
    return jsonb_build_object(
      'claimed',false,'reason','invalid_beds24_booking_id','communication_id',c.id
    );
  end if;

  if c.route='direct_email' and not public.ops_guest_valid_email(b.guest_email) then
    return jsonb_build_object('claimed',false,'reason','guest_email_invalid','communication_id',c.id);
  end if;

  if observed_at < c.scheduled_at then
    return jsonb_build_object(
      'claimed',false,'reason','not_due_yet','communication_id',c.id
    );
  end if;

  if observed_at > c.scheduled_at + interval '15 minutes' then
    return jsonb_build_object(
      'claimed',false,'reason','dispatch_window_expired','communication_id',c.id
    );
  end if;

  update public.ops_communications
     set automation_enabled=false,
         claim_token=requested_claim_token,
         claimed_at=observed_at,
         updated_at=clock_timestamp()
   where id=c.id
     and claim_token is null
  returning * into c;

  if not found then
    return jsonb_build_object(
      'claimed',false,'reason','claim_conflict','communication_id',target_communication
    );
  end if;

  return jsonb_build_object(
    'claimed',true,
    'reason',null,
    'communication_id',c.id,
    'booking_id',c.booking_id,
    'message_key',c.message_key,
    'route',c.route,
    'scheduled_at',c.scheduled_at,
    'beds24_booking_id',b.beds24_booking_id,
    'booking',jsonb_build_object(
      'id',b.id,
      'beds24_booking_id',b.beds24_booking_id,
      'source_environment',b.source_environment,
      'source_status',b.source_status,
      'source_channel',b.source_channel,
      'property_slug',b.property_slug,
      'guest_name',b.guest_name,
      'guest_email',case when c.route='direct_email' then b.guest_email else null end,
      'arrival',b.arrival,
      'departure',b.departure,
      'adults',b.adults,
      'children',b.children,
      'source_observed_at',b.source_observed_at
    )
  );
end;
$$;

create or replace function public.ops_mark_guest_communication_sent(
  target_communication uuid,
  expected_claim_token uuid,
  provider_message_id_value text default null,
  observed_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.ops_communications;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest worker service only';
  end if;

  select * into c
    from public.ops_communications
   where id=target_communication
   for update;

  if not found then
    return jsonb_build_object('ok',false,'reason','communication_missing');
  end if;

  if c.status='sent' then
    return jsonb_build_object(
      'ok',true,'already_finalized',true,'status','sent','communication_id',c.id
    );
  end if;

  if c.status is distinct from 'scheduled' then
    return jsonb_build_object(
      'ok',false,'reason','communication_not_scheduled','communication_id',c.id
    );
  end if;

  if c.claim_token is distinct from expected_claim_token or c.claimed_at is null then
    return jsonb_build_object(
      'ok',false,'reason','claim_token_mismatch','communication_id',c.id
    );
  end if;

  update public.ops_communications
     set status='sent',
         automation_enabled=false,
         provider_message_id=nullif(trim(provider_message_id_value),''),
         sent_at=observed_at,
         reason=null,
         updated_at=clock_timestamp()
   where id=c.id;

  return jsonb_build_object(
    'ok',true,'already_finalized',false,'status','sent','communication_id',c.id
  );
end;
$$;

create or replace function public.ops_mark_guest_communication_failed(
  target_communication uuid,
  expected_claim_token uuid,
  failure_reason text,
  observed_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.ops_communications;
  v_reason text := trim(coalesce(failure_reason,''));
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest worker service only';
  end if;

  if v_reason not in (
    'provider_outcome_uncertain',
    'provider_rejected_message',
    'authentication_unavailable',
    'authentication_failed',
    'messaging_not_configured',
    'render_failed',
    'wifi_secret_missing'
  ) then
    raise exception 'Unsupported guest communication failure reason';
  end if;

  select * into c
    from public.ops_communications
   where id=target_communication
   for update;

  if not found then
    return jsonb_build_object('ok',false,'reason','communication_missing');
  end if;

  if c.status='failed' then
    return jsonb_build_object(
      'ok',true,'already_finalized',true,'status','failed','communication_id',c.id
    );
  end if;

  if c.status is distinct from 'scheduled' then
    return jsonb_build_object(
      'ok',false,'reason','communication_not_scheduled','communication_id',c.id
    );
  end if;

  if c.claim_token is distinct from expected_claim_token or c.claimed_at is null then
    return jsonb_build_object(
      'ok',false,'reason','claim_token_mismatch','communication_id',c.id
    );
  end if;

  update public.ops_communications
     set status='failed',
         automation_enabled=false,
         reason=v_reason,
         sent_at=null,
         updated_at=clock_timestamp()
   where id=c.id;

  return jsonb_build_object(
    'ok',true,'already_finalized',false,'status','failed','communication_id',c.id
  );
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
     or new.guest_email is distinct from old.guest_email
     or new.property_slug is distinct from old.property_slug then
    perform public.ops_reconcile_guest_communications(new.id);
  end if;

  return new;
end;
$$;


-- Only service operators can prepare an explicitly approved channel. Merely
-- installing this RPC never calls it or changes any sending switch.
create or replace function public.ops_set_additional_guest_channel(target_route text, enabled_value boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b record; enrolled_count integer:=0; disabled_count integer:=0;
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'Guest automation service only'; end if;
 if target_route not in ('beds24_airbnb','direct_email') or target_route is null or enabled_value is null then raise exception 'Unsupported additional channel'; end if;
 update public.ops_guest_automation_settings set
   airbnb_enabled=case when target_route='beds24_airbnb' then enabled_value else airbnb_enabled end,
   direct_enabled=case when target_route='direct_email' then enabled_value else direct_enabled end,
   updated_at=clock_timestamp() where singleton=true;
 if enabled_value then
   for b in select id from public.ops_bookings where source_kind='beds24' and source_environment='production'
     and lower(trim(source_status)) in ('new','confirmed') and departure>=current_date
     and public.ops_preview_communication_route(source_kind,source_channel)=target_route
     and (target_route<>'direct_email' or public.ops_guest_valid_email(guest_email))
   loop
     -- Updating enroll metadata cannot rewrite source revisions or history.
     update public.ops_bookings set automation_enrolled_at=coalesce(automation_enrolled_at,clock_timestamp()),
       automation_enrollment_kind=coalesce(automation_enrollment_kind,'existing_activation') where id=b.id;
     perform public.ops_reconcile_guest_communications(b.id);
     enrolled_count:=enrolled_count+1;
   end loop;
   update public.ops_communications set automation_enabled=false,status='skipped',reason='dispatch_window_expired',updated_at=clock_timestamp()
     where route=target_route and status='scheduled' and claim_token is null and scheduled_at<clock_timestamp()-interval '15 minutes';
 else
   update public.ops_communications set automation_enabled=false,updated_at=clock_timestamp() where route=target_route and automation_enabled=true and claim_token is null;
   get diagnostics disabled_count=row_count;
 end if;
 return jsonb_build_object('route',target_route,'enabled',enabled_value,'bookings_reconciled',enrolled_count,'communications_disabled',disabled_count);
end;
$$;
revoke all on function public.ops_guest_route_enabled(text) from public,anon,authenticated,service_role;
revoke all on function public.ops_guest_valid_email(text) from public,anon,authenticated,service_role;
revoke all on function public.ops_set_additional_guest_channel(text,boolean) from public,anon,authenticated;
grant execute on function public.ops_set_additional_guest_channel(text,boolean) to service_role;
commit;
