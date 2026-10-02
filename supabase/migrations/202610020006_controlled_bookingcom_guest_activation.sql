-- Service-only controlled activation/deactivation for Booking.com guest automation.
-- Creating these RPCs does not activate sending.

begin;

create or replace function public.ops_activate_bookingcom_guest_automation()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  b record;
  reconciled_count integer := 0;
  expired_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest automation service only';
  end if;

  update public.ops_guest_automation_settings
     set bookingcom_enabled=true,
         updated_at=clock_timestamp()
   where singleton=true;

  for b in
    select id
      from public.ops_bookings
     where automation_enrolled_at is not null
       and source_kind='beds24'
       and source_environment='production'
       and lower(trim(coalesce(source_status,''))) in ('new','confirmed')
       and (
         lower(trim(coalesce(source_channel,'')))='booking'
         or lower(coalesce(source_channel,'')) like '%booking.com%'
       )
  loop
    perform public.ops_reconcile_guest_communications(b.id);
    reconciled_count := reconciled_count + 1;
  end loop;

  update public.ops_communications c
     set status='skipped',
         automation_enabled=false,
         reason='dispatch_window_expired',
         updated_at=clock_timestamp()
   where c.status='scheduled'
     and c.automation_enabled=true
     and c.claim_token is null
     and c.scheduled_at < clock_timestamp() - interval '15 minutes';

  get diagnostics expired_count = row_count;

  return jsonb_build_object(
    'bookingcom_enabled',true,
    'bookings_reconciled',reconciled_count,
    'expired_windows_skipped',expired_count
  );
end;
$$;

create or replace function public.ops_deactivate_bookingcom_guest_automation()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  disabled_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null then
    raise exception 'Guest automation service only';
  end if;

  update public.ops_guest_automation_settings
     set bookingcom_enabled=false,
         updated_at=clock_timestamp()
   where singleton=true;

  update public.ops_communications
     set automation_enabled=false,
         updated_at=clock_timestamp()
   where automation_enabled=true
     and claim_token is null;

  get diagnostics disabled_count = row_count;

  return jsonb_build_object(
    'bookingcom_enabled',false,
    'communications_disabled',disabled_count
  );
end;
$$;

revoke all privileges on function public.ops_activate_bookingcom_guest_automation()
  from public,anon,authenticated;
grant execute on function public.ops_activate_bookingcom_guest_automation()
  to service_role;

revoke all privileges on function public.ops_deactivate_bookingcom_guest_automation()
  from public,anon,authenticated;
grant execute on function public.ops_deactivate_bookingcom_guest_automation()
  to service_role;

commit;
