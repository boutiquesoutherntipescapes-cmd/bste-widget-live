-- Run against the operations staging database as its admin. No external calls.
-- All fixtures, temporary switches and audit records roll back together.
begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare
 b uuid; c uuid; token uuid; result jsonb; channel text; route text;
 rejected boolean; before_enabled boolean;
begin
 select bookingcom_enabled into before_enabled from public.ops_guest_automation_settings where singleton;
 if (select airbnb_enabled or direct_enabled from public.ops_guest_automation_settings where singleton) then raise exception 'New channels must be off before verification'; end if;
 foreach channel in array array['airbnb','direct','booking'] loop
   route:=case channel when 'airbnb' then 'beds24_airbnb' when 'direct' then 'direct_email' else 'beds24_bookingcom' end;
   insert into public.ops_bookings(source_environment,source_account,beds24_booking_id,property_slug,beds24_property_id,beds24_room_id,arrival,departure,source_status,source_channel,guest_name,guest_email,adults,children,source_observed_at)
     values('production','bste-rollback-fixture',9000000000+floor(random()*1000000)::bigint,'legacy-suiderstrand',351452,724919,current_date+30,current_date+33,'confirmed',channel,'Fixture Guest','fixture@example.test',2,0,clock_timestamp()) returning id into b;
   if channel <> 'booking' then
     if (select automation_enrolled_at from public.ops_bookings where id=b) is not null then raise exception 'Disabled channel auto-enrolled'; end if;
     rejected:=false;
     begin
       insert into public.ops_communications(booking_id,message_key,route,scheduled_at,status,automation_enabled) values(b,'departure_eve',route,clock_timestamp(),'scheduled',true);
     exception when others then rejected:=true;
     end;
     if not rejected then raise exception 'Disabled channel allowed enable'; end if;
     perform public.ops_set_additional_guest_channel(route,true);
   end if;
   -- Guard settings still preserve Booking.com's prior state.
   if (select bookingcom_enabled from public.ops_guest_automation_settings where singleton) is distinct from before_enabled then raise exception 'Booking.com switch changed'; end if;
   select id into c from public.ops_communications where booking_id=b and message_key='departure_eve';
   if c is null then raise exception 'Communication not reconciled'; end if;
   update public.ops_communications set scheduled_at=clock_timestamp(),status='scheduled',automation_enabled=true,reason=null where id=c;
   token:=gen_random_uuid();
   result:=public.ops_claim_guest_communication(c,token,clock_timestamp());
   if result->>'claimed' is distinct from 'true' then raise exception 'Claim failed: %',result; end if;
   if (select automation_enabled from public.ops_communications where id=c) then raise exception 'Claim did not consume enable'; end if;
   result:=public.ops_claim_guest_communication(c,gen_random_uuid(),clock_timestamp());
   if result->>'reason' is distinct from 'already_claimed' then raise exception 'Duplicate claim accepted'; end if;
   rejected:=false;
   begin update public.ops_communications set automation_enabled=true where id=c;
   exception when others then rejected:=true; end;
   if not rejected then raise exception 'Claimed communication re-enabled'; end if;
   result:=public.ops_mark_guest_communication_sent(c,gen_random_uuid(),'fixture',clock_timestamp());
   if result->>'reason' is distinct from 'claim_token_mismatch' then raise exception 'Wrong token finalized'; end if;
   result:=public.ops_mark_guest_communication_sent(c,token,'fixture',clock_timestamp());
   if result->>'status' is distinct from 'sent' then raise exception 'Sent finalize failed: %',result; end if;
   perform public.ops_reconcile_guest_communications(b);
   if (select status from public.ops_communications where id=c) is distinct from 'sent' then raise exception 'Sent history rewritten'; end if;
   -- Uncertain outcomes remain terminal, never automatically re-enabled.
   select id into c from public.ops_communications where booking_id=b and message_key='arrival_morning';
   update public.ops_communications set scheduled_at=clock_timestamp() where id=c;
   token:=gen_random_uuid();perform public.ops_claim_guest_communication(c,token,clock_timestamp());
   result:=public.ops_mark_guest_communication_failed(c,token,'provider_outcome_uncertain',clock_timestamp());
   if result->>'status' is distinct from 'failed' then raise exception 'Failed finalize failed'; end if;
   perform public.ops_reconcile_guest_communications(b);
   if (select status from public.ops_communications where id=c) is distinct from 'failed' then raise exception 'Uncertain failure retried'; end if;
   -- Expired/future/channel mismatch/cancelled reject at final claim boundary.
   select id into c from public.ops_communications where booking_id=b and message_key='pre_arrival';
   update public.ops_communications set scheduled_at=clock_timestamp()-interval '16 minutes' where id=c;
   result:=public.ops_claim_guest_communication(c,gen_random_uuid(),clock_timestamp());
   if result->>'reason' is distinct from 'dispatch_window_expired' then raise exception 'Expired window accepted'; end if;
   update public.ops_communications set scheduled_at=clock_timestamp()+interval '1 hour' where id=c;
   result:=public.ops_claim_guest_communication(c,gen_random_uuid(),clock_timestamp());
   if result->>'reason' is distinct from 'not_due_yet' then raise exception 'Future window accepted'; end if;
   update public.ops_guest_automation_settings set airbnb_enabled=true,direct_enabled=true where singleton;
   update public.ops_communications t set scheduled_at=clock_timestamp(),route=case when t.route='beds24_airbnb' then 'beds24_bookingcom' else 'beds24_airbnb' end where t.id=c;
   result:=public.ops_claim_guest_communication(c,gen_random_uuid(),clock_timestamp());
   if result->>'claimed'='true' then raise exception 'Mismatched channel claimed'; end if;
   update public.ops_bookings set source_status='cancelled',source_observed_at=clock_timestamp() where id=b;
   result:=public.ops_claim_guest_communication(c,gen_random_uuid(),clock_timestamp());
   if result->>'claimed'='true' then raise exception 'Cancelled booking claimed'; end if;
   perform public.ops_set_additional_guest_channel('beds24_airbnb',false);
   perform public.ops_set_additional_guest_channel('direct_email',false);
 end loop;
 if has_function_privilege('anon','public.ops_set_additional_guest_channel(text,boolean)','execute') or has_function_privilege('authenticated','public.ops_claim_guest_communication(uuid,uuid,timestamptz)','execute') then raise exception 'Guest RPC exposed'; end if;
end;
$$;
select 'passed: three routes, claims, completion, duplicates, expiry, cancellation, switches and privileges; no provider calls' as verification;
rollback;
