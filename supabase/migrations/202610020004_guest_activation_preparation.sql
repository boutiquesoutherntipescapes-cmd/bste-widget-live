-- Controlled preparation for Booking.com guest automation.
-- This migration does not enable the master switch and does not enable any rows.

begin;

do $$
begin
  if exists (
    select 1
      from public.ops_guest_automation_settings
     where singleton=true
       and bookingcom_enabled=true
  ) then
    raise exception 'Guest automation master switch must be disabled during preparation';
  end if;
end;
$$;

create or replace function public.ops_guard_guest_communication_enable()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if new.automation_enabled is true then
    if not public.ops_guest_bookingcom_enabled() then
      raise exception 'Guest automation master switch is disabled';
    end if;

    if new.status is distinct from 'scheduled' then
      raise exception 'Only scheduled communications may be automated';
    end if;

    if new.route is distinct from 'beds24_bookingcom' then
      raise exception 'Only Booking.com route is enabled for first release';
    end if;

    if new.claim_token is not null or new.claimed_at is not null then
      raise exception 'Claimed communications cannot be re-enabled';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_guest_communication_enable
  on public.ops_communications;

create trigger guard_guest_communication_enable
before insert or update on public.ops_communications
for each row execute function public.ops_guard_guest_communication_enable();

alter table public.ops_communications
  drop constraint if exists ops_communications_automation_enabled_check;

update public.ops_communications
   set automation_enabled=false,
       updated_at=clock_timestamp()
 where automation_enabled is distinct from false;

revoke all privileges on function public.ops_guard_guest_communication_enable()
  from public,anon,authenticated,service_role;

commit;
