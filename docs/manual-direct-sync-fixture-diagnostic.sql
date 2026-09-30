-- READ ONLY. No guest/contact fields, credentials or mutations.
-- Zero rows in the first result is expected after a rolled-back failed test.
select id,source_environment,source_account,status,started_at,completed_at,
 initiated_by as fixture_staff_link,
 (select count(*) from public.ops_sync_members m where m.run_id=r.id) as member_count,
 (select count(*) from public.ops_events e where e.system_run_id=r.id) as linked_event_count
from public.ops_sync_runs r
where source_environment='production' and source_account='direct-fixture-sync'
order by started_at,id;

-- Counts only: no guest identities or sensitive payloads.
select
 (select count(*) from public.ops_sync_runs where source_environment='production' and source_account='direct-fixture-sync') as old_fixture_sync_rows,
 (select count(*) from public.ops_bookings where manual_reference='BSTE-HIST-202609-KAL-01') as approved_manual_reference_rows_expected_zero,
 (select count(*) from public.ops_bookings where property_slug='kalay-ridge-villa-struisbaai' and arrival='2026-09-08' and departure='2026-09-12' and lower(trim(guest_name))='charl baard') as matching_guest_stay_rows_expected_zero,
 (select count(*) from public.ops_bookings where manual_created_by='d1000000-0000-0000-0000-000000000001') as fixture_created_booking_rows,
 (select count(*) from public.ops_staff where user_id='d1000000-0000-0000-0000-000000000001') as synthetic_staff_rows,
 (select count(*) from auth.users where id='d1000000-0000-0000-0000-000000000001') as synthetic_auth_user_rows,
 (select count(*) from auth.sessions where id='d2000000-0000-0000-0000-000000000001') as synthetic_session_rows,
 (select count(*) from public.ops_events where actor_user_id='d1000000-0000-0000-0000-000000000001') as synthetic_actor_event_rows;
