-- Guest communication dispatch outcome foundation.
-- SAFETY: this migration still does NOT enable automation or live sending.
-- It strengthens the service-role write path and adds explicit claim outcomes.
begin;

create or replace function public.ops_claim_guest_communication(
  target_communication uuid,
  requested_claim_token uuid,
  observed_at timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = ''
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

  if c.route is distinct from 'beds24_bookingcom' then
    return jsonb_build_object(
      'claimed',false,'reason','unsupported_live_route','communication_id',c.id
    );
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
  if not (v_channel='booking' or v_channel like '%booking.com%') then
    return jsonb_build_object(
      'claimed',false,'reason','booking_channel_mismatch','communication_id',c.id
    );
  end if;

  if b.beds24_booking_id is null or b.beds24_booking_id <= 0 then
    return jsonb_build_object(
      'claimed',false,'reason','invalid_beds24_booking_id','communication_id',c.id
    );
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
     set claim_token=requested_claim_token,
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

  if c.automation_enabled is distinct from true then
    return jsonb_build_object(
      'ok',false,'reason','automation_not_enabled','communication_id',c.id
    );
  end if;

  update public.ops_communications
     set status='sent',
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
         reason=v_reason,
         sent_at=null,
         updated_at=clock_timestamp()
   where id=c.id;

  return jsonb_build_object(
    'ok',true,'already_finalized',false,'status','failed','communication_id',c.id
  );
end;
$$;

revoke all privileges on function public.ops_claim_guest_communication(uuid,uuid,timestamptz)
  from public,anon,authenticated;
revoke all privileges on function public.ops_mark_guest_communication_sent(uuid,uuid,text,timestamptz)
  from public,anon,authenticated;
revoke all privileges on function public.ops_mark_guest_communication_failed(uuid,uuid,text,timestamptz)
  from public,anon,authenticated;

grant execute on function public.ops_claim_guest_communication(uuid,uuid,timestamptz)
  to service_role;
grant execute on function public.ops_mark_guest_communication_sent(uuid,uuid,text,timestamptz)
  to service_role;
grant execute on function public.ops_mark_guest_communication_failed(uuid,uuid,text,timestamptz)
  to service_role;

-- Force all service-role communication mutations through the audited RPCs above.
revoke insert,update on public.ops_communications from service_role;

commit;
