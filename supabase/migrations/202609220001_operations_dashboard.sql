-- NEW migration, staging review only. Do not reapply/edit the foundation migration.
-- No external services, automation, inventory or payment provider actions.
begin;
insert into public.ops_role_permissions values ('administrator','sync.run'), ('administrator','expenses.approve');

create table public.ops_booking_overrides (
 id uuid primary key default gen_random_uuid(),
 booking_id uuid not null references public.ops_bookings(id),
 operational_status text not null check (operational_status in ('confirmed','review_required','checked_in','checked_out')),
 reason text not null check(length(trim(reason)) between 1 and 2000),
 created_by uuid not null references public.ops_staff(user_id),
 created_at timestamptz not null default clock_timestamp()
);
create index ops_override_latest on public.ops_booking_overrides(booking_id,created_at desc,id desc);
create function public.ops_stamp_override() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not public.ops_can('operations.write') then raise exception 'Operational permission required'; end if;
 new.created_by := auth.uid(); new.created_at := clock_timestamp(); return new;
end $$;
create trigger stamp_override before insert on public.ops_booking_overrides for each row execute function public.ops_stamp_override();
create trigger immutable_override before update or delete on public.ops_booking_overrides for each row execute function public.ops_no_change();
create trigger audit_override after insert on public.ops_booking_overrides for each row execute function public.ops_audit_change();
revoke all on function public.ops_stamp_override() from public,anon,authenticated;

-- Explicit staff review only. No source deposit is converted into this state.
alter table public.ops_payment_records drop constraint ops_payment_records_review_status_check;
alter table public.ops_payment_records add constraint ops_payment_records_review_status_check
 check(review_status in ('not_reviewed','unknown','unpaid','part_paid','deposit_paid','paid','channel_managed'));
create index ops_payment_review_latest on public.ops_payment_records(booking_id,created_at desc,id desc) where entry_kind='review';

create table public.ops_sync_runs (
 id uuid primary key default gen_random_uuid(),
 source_environment text not null check(source_environment='production'),
 source_account text not null check(length(trim(source_account)) between 1 and 120),
 initiated_by uuid not null references public.ops_staff(user_id),
 started_at timestamptz not null default clock_timestamp(),
 completed_at timestamptz,
 status text not null default 'running' check(status in ('running','succeeded','failed')),
 source_read_status text not null default 'not_started' check(source_read_status in ('not_started','succeeded','failed','unknown')),
 imported_count integer not null default 0,
 property_counts jsonb not null default '{}'::jsonb,
 error_code text,
 check ((status='running' and completed_at is null) or (status<>'running' and completed_at is not null))
);
create unique index ops_one_running_sync on public.ops_sync_runs(source_environment,source_account) where status='running';
create table public.ops_sync_members (
 run_id uuid not null references public.ops_sync_runs(id),
 booking_id uuid not null references public.ops_bookings(id),
 primary key(run_id,booking_id)
);
-- Full source payload is sensitive, including financial fields. Never operations-visible.
create table public.ops_beds24_raw_snapshots (
 booking_id uuid primary key references public.ops_bookings(id),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 source_observed_at timestamptz not null
);

create function public.ops_begin_sync(account_key text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 if not public.ops_can('sync.run') then raise exception 'Sync permission required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('bste-ops-sync:'||account_key,0));
 update public.ops_sync_runs set status='failed',source_read_status='unknown',error_code='interrupted',completed_at=clock_timestamp()
 where source_account=account_key and status='running' and started_at < clock_timestamp()-interval '10 minutes';
 insert into public.ops_sync_runs(source_environment,source_account,initiated_by)
 values('production',account_key,auth.uid()) returning id into result;
 return result;
end $$;
create function public.ops_fail_sync(target_run uuid, failure_code text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'Importer only'; end if;
 update public.ops_sync_runs set status='failed', completed_at=clock_timestamp(),
 source_read_status=case when failure_code='storage_failed' then 'succeeded' else 'failed' end,error_code=
 case when failure_code in ('beds24_read_failed','invalid_beds24_response','unmapped_source_booking',
 'invalid_source_dates','invalid_source_booking','invalid_source_price','invalid_guest_count',
 'conflicting_duplicate_booking','booking_limit_exceeded','pagination_limit_exceeded','storage_failed')
 then failure_code else 'import_failed' end
 where id=target_run and status='running';
end $$;

-- Entire fetch is gathered and validated before this atomic transaction. A failed
-- source page or stale record cannot leave a partially updated property set.
create function public.ops_apply_sync(target_run uuid, items jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare run public.ops_sync_runs; item jsonb; booking uuid; n integer:=0;
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'Importer only'; end if;
 select * into run from public.ops_sync_runs where id=target_run for update;
 if run.id is null or run.status<>'running' or run.started_at < clock_timestamp()-interval '10 minutes' then
   raise exception 'Inactive sync run'; end if;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)>2000 then raise exception 'Invalid import batch'; end if;
 for item in select value from jsonb_array_elements(items) loop
   if item->'snapshot'->>'source_account' is distinct from run.source_account
     or item->'snapshot'->>'source_environment' is distinct from run.source_environment
     or (item->'snapshot'->>'source_observed_at')::timestamptz < run.started_at-interval '1 minute'
     or (item->'snapshot'->>'source_observed_at')::timestamptz > clock_timestamp()+interval '1 minute' then
       raise exception 'Wrong import scope or observation'; end if;
   booking := public.ops_sync_booking(item->'snapshot',nullif(item->'financial','null'::jsonb),target_run);
   -- Existing snapshot guards already reject stale observations for this UUID.
   insert into public.ops_beds24_raw_snapshots values(booking,item->'raw',(item->'snapshot'->>'source_observed_at')::timestamptz)
    on conflict(booking_id) do update set payload=excluded.payload,source_observed_at=excluded.source_observed_at;
   insert into public.ops_sync_members values(target_run,booking); -- duplicate keys abort the whole batch
   n := n+1;
 end loop;
 update public.ops_sync_runs set status='succeeded',source_read_status='succeeded',completed_at=clock_timestamp(),imported_count=n,
 property_counts=(select jsonb_object_agg(p.property_slug,(select count(*) from public.ops_sync_members m
   join public.ops_bookings b on b.id=m.booking_id where m.run_id=target_run and b.property_slug=p.property_slug))
   from public.ops_properties p)
 where id=target_run;
 return n;
end $$;

-- Read under the caller's RLS, never with the service key. Financial state is
-- conditionally exposed and raw financial snapshots/payloads never leave here.
create function public.ops_dashboard_rows(account_key text) returns jsonb
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
    exists(select 1 from public.ops_sync_runs where source_account=account_key and status='succeeded')
     and not exists(select 1 from public.ops_sync_members m where m.booking_id=b.id and m.run_id=
       (select id from public.ops_sync_runs where source_account=account_key and status='succeeded' order by started_at desc limit 1)) as not_seen_in_latest_sync
   from public.ops_bookings b
   left join lateral (select operational_status,reason from public.ops_booking_overrides where booking_id=b.id order by created_at desc,id desc limit 1) o on true
   left join lateral (select review_status,note,created_at from public.ops_payment_records where booking_id=b.id and entry_kind='review' order by created_at desc,id desc limit 1) p on true
   where b.source_environment='production' and b.source_account=account_key
    and b.departure >= (now() at time zone 'Africa/Johannesburg')::date
   order by b.arrival,b.id limit 2001
 ) rows;
 if jsonb_array_length(result)>2000 then raise exception 'Dashboard capacity exceeded'; end if;
 return result;
end $$;

-- Expense/payout foundations only: no UI, storage bucket, OCR, approval or payout
-- writer is enabled. Future audited RPCs must implement these operations.
create table public.ops_stay_expenses (
 id uuid primary key default gen_random_uuid(),
 booking_id uuid not null references public.ops_bookings(id),
 property_slug text not null references public.ops_properties(property_slug),
 incurred_on date not null, category text not null, description text not null,
 amount_cents bigint not null check(amount_cents>0), currency text not null check(currency ~ '^[A-Z]{3}$'),
 allocation text not null check(allocation in ('owner','bste','split')),
 owner_amount_cents bigint not null check(owner_amount_cents>=0 and owner_amount_cents<=amount_cents),
 receipt_private_object_key text, -- reference only; no public URL or uploads in this phase
 status text not null default 'draft' check(status in ('draft','review','approved')),
 created_by uuid not null references public.ops_staff(user_id), created_at timestamptz not null default now(),
 approved_by uuid references public.ops_staff(user_id), approved_at timestamptz,
 check((status='approved' and approved_by is not null and approved_at is not null) or
       (status<>'approved' and approved_by is null and approved_at is null)),
 check((allocation='owner' and owner_amount_cents=amount_cents) or (allocation='bste' and owner_amount_cents=0)
   or (allocation='split' and owner_amount_cents>0 and owner_amount_cents<amount_cents))
);
create function public.ops_check_expense_property() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.ops_bookings where id=new.booking_id and property_slug=new.property_slug) then
   raise exception 'Expense property must match stay at entry'; end if;
 return new;
end $$;
create trigger expense_property before insert or update on public.ops_stay_expenses for each row execute function public.ops_check_expense_property();
create table public.ops_month_reconciliations (
 id uuid primary key default gen_random_uuid(), property_slug text not null references public.ops_properties(property_slug),
 month date not null check(extract(day from month)=1), expenses_complete boolean not null default false,
 reviewed_by uuid references public.ops_staff(user_id), reviewed_at timestamptz,
 unique(property_slug,month), check(not expenses_complete or (reviewed_by is not null and reviewed_at is not null))
);
create table public.ops_owner_statement_snapshots (
 id uuid primary key default gen_random_uuid(), reconciliation_id uuid not null unique references public.ops_month_reconciliations(id),
 owner_reference text not null, statement jsonb not null, finalized_by uuid not null references public.ops_staff(user_id),
 finalized_at timestamptz not null default now()
);
create function public.ops_gate_statement() returns trigger language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.ops_month_reconciliations r where r.id=new.reconciliation_id and r.expenses_complete
   and not exists(select 1 from public.ops_stay_expenses e where e.property_slug=r.property_slug
     and e.incurred_on>=r.month and e.incurred_on<(r.month+interval '1 month') and e.status<>'approved')) then
   raise exception 'Expense reconciliation incomplete'; end if;
 return new;
end $$;
create trigger statement_gate before insert on public.ops_owner_statement_snapshots for each row execute function public.ops_gate_statement();
create trigger immutable_statement before update or delete on public.ops_owner_statement_snapshots for each row execute function public.ops_no_change();
create table public.ops_owner_statement_adjustments (
 id uuid primary key default gen_random_uuid(), statement_id uuid not null references public.ops_owner_statement_snapshots(id),
 expense_id uuid not null references public.ops_stay_expenses(id), reason text not null,
 amount_cents bigint not null, created_by uuid not null references public.ops_staff(user_id), created_at timestamptz not null default now(),
 unique(statement_id,expense_id)
);
create trigger immutable_adjustment before update or delete on public.ops_owner_statement_adjustments for each row execute function public.ops_no_change();

-- Explicit grants override Supabase defaults. No table writes by service or staff
-- beyond the narrow RPCs / append-only override; expense writes remain disabled.
do $$ declare t text; begin
 foreach t in array array['ops_booking_overrides','ops_sync_runs','ops_sync_members','ops_beds24_raw_snapshots',
  'ops_stay_expenses','ops_month_reconciliations','ops_owner_statement_snapshots','ops_owner_statement_adjustments'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
 foreach t in array array['ops_booking_overrides','ops_sync_runs','ops_sync_members'] loop
  execute format('create policy operations_read on public.%I for select to authenticated using(public.ops_can(''operations.read''))',t);
 end loop;
 foreach t in array array['ops_stay_expenses','ops_month_reconciliations','ops_owner_statement_snapshots','ops_owner_statement_adjustments'] loop
  execute format('create policy finance_read on public.%I for select to authenticated using(public.ops_can(''finance.read''))',t);
  execute format('create trigger audit_change after insert or update on public.%I for each row execute function public.ops_audit_change()',t);
 end loop;
end $$;
create policy raw_admin_read on public.ops_beds24_raw_snapshots for select to authenticated using(public.ops_can('audit.read'));
grant insert on public.ops_booking_overrides to authenticated;
create policy override_write on public.ops_booking_overrides for insert to authenticated with check(public.ops_can('operations.write'));
-- Reset each RPC's inherited/default grants before granting its intended caller.
-- PUBLIC is PostgreSQL's all-roles pseudo-role (not the public schema).
revoke all privileges on function public.ops_begin_sync(text) from public, anon, authenticated, service_role;
revoke all privileges on function public.ops_dashboard_rows(text) from public, anon, authenticated, service_role;
revoke all privileges on function public.ops_apply_sync(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all privileges on function public.ops_fail_sync(uuid,text) from public, anon, authenticated, service_role;

-- Staff JWTs remain subject to the functions' internal ops_can checks and MFA.
grant execute on function public.ops_begin_sync(text) to authenticated;
grant execute on function public.ops_dashboard_rows(text) to authenticated;
-- Import RPCs additionally verify service_role and reject a staff subject.
grant execute on function public.ops_apply_sync(uuid,jsonb) to service_role;
grant execute on function public.ops_fail_sync(uuid,text) to service_role;

-- Trigger helpers are not public RPCs; their installed triggers still run.
revoke all privileges on function public.ops_stamp_override() from public, anon, authenticated, service_role;
revoke all privileges on function public.ops_check_expense_property() from public, anon, authenticated, service_role;
revoke all privileges on function public.ops_gate_statement() from public, anon, authenticated, service_role;

commit;
