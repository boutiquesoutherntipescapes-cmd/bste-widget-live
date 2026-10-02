-- Guest communication dispatch claim foundation.
-- SAFETY: this migration does NOT enable automation or live sending.
-- The existing automation_enabled = false database constraint remains untouched.
begin;

alter table public.ops_communications
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz;

create unique index if not exists ops_communications_claim_token_once
  on public.ops_communications(claim_token)
  where claim_token is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ops_communications_claim_pair'
      and conrelid = 'public.ops_communications'::regclass
  ) then
    alter table public.ops_communications
      add constraint ops_communications_claim_pair
      check (
        (claim_token is null and claimed_at is null)
        or
        (claim_token is not null and claimed_at is not null)
      );
  end if;
end;
$$;

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

  select *
    into c
    from public.ops_communications
   where id = target_communication
   for update;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'communication_missing'
    );
  end if;

  select *
    into b
    from public.ops_bookings
   where id = c.booking_id;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'booking_missing',
      'communication_id', c.id
    );
  end if;

  if c.claim_token is not null then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'already_claimed',
      'communication_id', c.id
    );
  end if;

  if c.status is distinct from 'scheduled' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'communication_not_scheduled',
      'communication_id', c.id
    );
  end if;

  -- Critical safety gate. The current schema constraint forces this to false,
  -- so this RPC cannot claim anything until a separate deliberate migration
  -- changes that constraint in the future.
  if c.automation_enabled is distinct from true then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'automation_not_enabled',
      'communication_id', c.id
    );
  end if;

  if c.route is distinct from 'beds24_bookingcom' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'unsupported_live_route',
      'communication_id', c.id
    );
  end if;

  if b.source_environment is distinct from 'production' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'booking_environment_mismatch',
      'communication_id', c.id
    );
  end if;

  v_source_status := lower(trim(coalesce(b.source_status, '')));
  if v_source_status not in ('new', 'confirmed') then
    return jsonb_build_object(
      'claimed', false,
      'reason',
        case
          when v_source_status in ('cancelled', 'canceled') then 'booking_cancelled'
          else 'booking_not_confirmed'
        end,
      'communication_id', c.id
    );
  end if;

  v_channel := lower(trim(coalesce(b.source_channel, '')));
  if not (v_channel = 'booking' or v_channel like '%booking.com%') then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'booking_channel_mismatch',
      'communication_id', c.id
    );
  end if;

  if b.beds24_booking_id is null or b.beds24_booking_id <= 0 then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'invalid_beds24_booking_id',
      'communication_id', c.id
    );
  end if;

  if observed_at < c.scheduled_at then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'not_due_yet',
      'communication_id', c.id
    );
  end if;

  -- Exactly +15 minutes is still dispatchable; anything later is expired.
  if observed_at > c.scheduled_at + interval '15 minutes' then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'dispatch_window_expired',
      'communication_id', c.id
    );
  end if;

  update public.ops_communications
     set claim_token = requested_claim_token,
         claimed_at = observed_at,
         updated_at = clock_timestamp()
   where id = c.id
     and claim_token is null
  returning * into c;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'claim_conflict',
      'communication_id', target_communication
    );
  end if;

  return jsonb_build_object(
    'claimed', true,
    'reason', null,
    'communication_id', c.id,
    'booking_id', c.booking_id,
    'message_key', c.message_key,
    'route', c.route,
    'scheduled_at', c.scheduled_at,
    'beds24_booking_id', b.beds24_booking_id
  );
end;
$$;

revoke all privileges on function public.ops_claim_guest_communication(uuid,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.ops_claim_guest_communication(uuid,uuid,timestamptz)
  to service_role;

commit;
