-- Step 2 only. REVIEW AND TEST BEFORE APPLYING. No Beds24/communication actions.
-- Requires Supabase Auth (auth.users/auth.uid/auth.role). Leaves owner tables alone.
begin;

create table public.ops_staff (
  user_id uuid primary key references auth.users(id),
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  role text not null check (role in ('administrator', 'operations', 'finance')),
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.ops_role_permissions (
  role text not null,
  permission text not null,
  primary key (role, permission)
);
insert into public.ops_role_permissions values
  ('administrator', 'operations.read'), ('administrator', 'operations.write'),
  ('administrator', 'finance.read'), ('administrator', 'finance.write'),
  ('administrator', 'arrangements.approve'), ('administrator', 'audit.read'),
  ('operations', 'operations.read'), ('operations', 'operations.write'),
  ('finance', 'operations.read'), ('finance', 'finance.read'), ('finance', 'finance.write');

-- Auth session existence makes a provider-terminated session unusable even while
-- its signed access token has not expired. Supabase auth.sessions is a prerequisite.
create function public.ops_session_valid() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.sessions
    where id::text = auth.jwt()->>'session_id' and user_id = auth.uid()
      and created_at > now() - interval '1 hour');
$$;

-- Unknown/new permissions fail closed: only these ordinary operations grants
-- are allowed without MFA. Any new authority therefore requires AAL2 by default.
create function public.ops_mfa_required(staff_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select staff_role in ('administrator', 'finance') or exists (
    select 1 from public.ops_role_permissions where role = staff_role
      and permission not in ('operations.read', 'operations.write'));
$$;
create function public.ops_can(required_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.ops_session_valid() and exists (
    select 1 from public.ops_staff s
    join public.ops_role_permissions p on p.role = s.role
    where s.user_id = auth.uid() and s.is_active and p.permission = required_permission
      and (not public.ops_mfa_required(s.role) or auth.jwt()->>'aal' = 'aal2')
  );
$$;
-- Minimal pre-MFA result; no operational or financial data is returned.
create function public.ops_staff_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object(
    'active', true, 'user_id', s.user_id, 'display_name', s.display_name, 'role', s.role,
    'mfa_required', public.ops_mfa_required(s.role),
    'mfa_satisfied', coalesce(auth.jwt()->>'aal' = 'aal2', false),
    'permissions', coalesce((select jsonb_agg(p.permission) from public.ops_role_permissions p
      where p.role = s.role and public.ops_can(p.permission)), '[]'::jsonb))
    from public.ops_staff s where s.user_id = auth.uid() and s.is_active
      and public.ops_session_valid()), '{"active":false}'::jsonb);
$$;
revoke all on function public.ops_session_valid(), public.ops_mfa_required(text),
  public.ops_can(text), public.ops_staff_access() from public, anon;
grant execute on function public.ops_session_valid(), public.ops_mfa_required(text),
  public.ops_can(text), public.ops_staff_access() to authenticated;

create table public.ops_properties (
  property_slug text primary key,
  display_name text not null,
  beds24_property_id bigint not null unique check (beds24_property_id > 0),
  beds24_room_id bigint not null unique check (beds24_room_id > 0),
  unique (property_slug, beds24_property_id, beds24_room_id)
);
insert into public.ops_properties values
  ('legacy-suiderstrand', 'Legacy Beach Villa', 351452, 724919),
  ('kalay-ridge-villa-struisbaai', 'Kalaya Ridge Villa', 352005, 726060),
  ('the-pearl-beach-villa-agulhas', 'The Pearl Beach Villa', 352276, 726696);

create table public.ops_bookings (
  id uuid primary key default gen_random_uuid(),
  source_environment text not null check (source_environment in ('production', 'sandbox')),
  source_account text not null check (length(trim(source_account)) > 0),
  beds24_booking_id bigint not null check (beds24_booking_id > 0),
  property_slug text not null references public.ops_properties(property_slug),
  beds24_property_id bigint not null,
  beds24_room_id bigint not null,
  arrival date not null,
  departure date not null check (departure > arrival),
  source_status text not null, -- Preserve new/confirmed/request; never infer paid/invalid.
  source_channel text, -- Preserve raw channel; routing classification belongs to importer.
  guest_name text,
  guest_email text,
  guest_mobile text,
  adults integer check (adults >= 0),
  children integer check (children >= 0),
  source_modified_at timestamptz,
  source_observed_at timestamptz not null,
  first_imported_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  policy_basis text not null default 'existing_booking_original_terms'
    check (policy_basis = 'existing_booking_original_terms'),
  automation_enrolled_at timestamptz, -- NULL: not enrolled; import must not send anything.
  unique (source_environment, source_account, beds24_booking_id),
  foreign key (property_slug, beds24_property_id, beds24_room_id)
    references public.ops_properties(property_slug, beds24_property_id, beds24_room_id)
);
create index ops_bookings_dates on public.ops_bookings(arrival, departure);
create index ops_bookings_property on public.ops_bookings(property_slug);

create function public.ops_guard_snapshot() returns trigger
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
     (to_jsonb(new) - array['last_synced_at','first_imported_at']) is distinct from
     (to_jsonb(old) - array['last_synced_at','first_imported_at']) then
    raise exception 'Conflicting snapshot at same observation time';
  end if;
  if old.source_modified_at is not null and new.source_modified_at = old.source_modified_at and
     (to_jsonb(new) - array['source_observed_at','last_synced_at','first_imported_at']) is distinct from
     (to_jsonb(old) - array['source_observed_at','last_synced_at','first_imported_at']) then
    raise exception 'Conflicting data at same source revision';
  end if;
  new.first_imported_at := old.first_imported_at;
  new.policy_basis := old.policy_basis;
  if old.automation_enrolled_at is not null and new.automation_enrolled_at is distinct from old.automation_enrolled_at then
    raise exception 'Automation enrollment cannot be reset';
  end if;
  return new;
end;
$$;
create trigger guard_snapshot before update on public.ops_bookings
  for each row execute function public.ops_guard_snapshot();
revoke all on function public.ops_guard_snapshot() from public, anon, authenticated;

-- Financial data is deliberately NOT in the operations-visible snapshot.
create table public.ops_booking_financial_snapshots (
  booking_id uuid primary key references public.ops_bookings(id),
  source_price numeric, -- Raw decimal fact, not yet an approved total or receipt.
  source_currency text,
  source_deposit jsonb, -- Uninterpreted API value, never money received by assumption.
  source_invoice_items jsonb,
  source_modified_at timestamptz,
  source_observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create function public.ops_guard_financial_snapshot() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.booking_id <> old.booking_id then raise exception 'Financial identity cannot change'; end if;
  if new.source_observed_at < old.source_observed_at
    or (old.source_modified_at is not null and
      (new.source_modified_at is null or new.source_modified_at < old.source_modified_at)) then
    raise exception 'Stale financial snapshot';
  end if;
  if new.source_observed_at = old.source_observed_at and
    (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'Conflicting financial snapshot';
  end if;
  if old.source_modified_at is not null and new.source_modified_at = old.source_modified_at and
    (to_jsonb(new) - array['source_observed_at','updated_at']) is distinct from
    (to_jsonb(old) - array['source_observed_at','updated_at']) then
    raise exception 'Conflicting financial data at same source revision';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger guard_financial_snapshot before update on public.ops_booking_financial_snapshots
  for each row execute function public.ops_guard_financial_snapshot();
revoke all on function public.ops_guard_financial_snapshot() from public, anon, authenticated;

create table public.ops_tasks (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ops_bookings(id),
  task_key text not null, -- Stable e.g. prep/check_in/check_out/cleaning; safe repeated creation.
  title text not null check (length(trim(title)) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'skipped')),
  due_at timestamptz,
  assigned_to uuid references public.ops_staff(user_id),
  created_by_system text,
  updated_by_system text,
  created_by uuid references public.ops_staff(user_id),
  updated_by uuid references public.ops_staff(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, task_key)
);

create table public.ops_notes (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ops_bookings(id),
  body text not null check (length(trim(body)) between 1 and 10000),
  supersedes_id uuid references public.ops_notes(id), -- Corrections append, never erase.
  created_by uuid not null references public.ops_staff(user_id),
  created_at timestamptz not null default now()
);

create table public.ops_payment_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ops_bookings(id),
  entry_kind text not null check (entry_kind in ('review', 'receipt', 'correction')),
  review_status text check (review_status in ('not_reviewed', 'unknown', 'unpaid', 'part_paid', 'paid', 'channel_managed')),
  amount_cents bigint check (amount_cents >= 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  payment_method text,
  payment_date date,
  evidence_reference text,
  receipt_scope text not null, -- Derived from booking environment/account, never staff-supplied.
  receipt_key text, -- Stable non-secret key for a receipt; separate from PayFast.
  note text not null check (length(trim(note)) between 1 and 10000),
  supersedes_id uuid references public.ops_payment_records(id),
  created_by uuid not null references public.ops_staff(user_id),
  created_at timestamptz not null default now(),
  check (entry_kind <> 'review' or review_status is not null),
  check (entry_kind <> 'correction' or supersedes_id is not null),
  check (entry_kind <> 'receipt' or
    (amount_cents is not null and amount_cents > 0 and currency is not null and payment_date is not null
     and length(trim(payment_method)) > 0 and length(trim(evidence_reference)) > 0
     and length(trim(receipt_key)) > 0 and payment_method is not null
     and evidence_reference is not null and receipt_key is not null))
);
create unique index ops_receipt_once on public.ops_payment_records(receipt_scope, receipt_key)
  where receipt_key is not null;

create table public.ops_payment_arrangements (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ops_bookings(id),
  revised_deadline timestamptz not null,
  reason text not null check (length(trim(reason)) between 1 and 10000),
  status text not null default 'active' check (status in ('active', 'fulfilled', 'withdrawn', 'missed')),
  created_by uuid not null references public.ops_staff(user_id), -- Approver, not user-supplied.
  updated_by uuid not null references public.ops_staff(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ops_one_active_arrangement on public.ops_payment_arrangements(booking_id)
  where status = 'active';

create table public.ops_communications (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.ops_bookings(id),
  message_key text not null,
  route text not null check (route in ('direct_email', 'direct_whatsapp', 'beds24_airbnb', 'beds24_bookingcom', 'beds24_other', 'unresolved')),
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'failed', 'skipped')),
  automation_enabled boolean not null default false check (automation_enabled = false),
  provider_message_id text,
  sent_at timestamptz,
  reason text,
  updated_at timestamptz not null default now(),
  unique (booking_id, message_key)
  -- Step 2 cannot enable sending. Later migration required after safe delivery design.
);

create table public.ops_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  event_origin text not null default 'database_change'
    check (event_origin in ('database_change', 'application_report')),
  system_run_id uuid,
  actor_name text not null,
  actor_role text not null,
  action text not null,
  entity_table text not null,
  entity_id text,
  booking_id uuid references public.ops_bookings(id),
  detail jsonb not null default '{}'::jsonb
);
create index ops_events_booking on public.ops_events(booking_id, occurred_at);

-- Stamps actor/time from verified Auth context; rejects attribution spoofing.
create function public.ops_stamp_staff() returns trigger
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if auth.role() = 'service_role' and actor is null and TG_TABLE_NAME = 'ops_tasks'
     and TG_OP = 'INSERT' and current_setting('bste.system_actor', true) = 'beds24_importer' then
    new.created_by := null; new.updated_by := null;
    new.created_by_system := 'beds24_importer'; new.updated_by_system := 'beds24_importer';
    new.created_at := clock_timestamp(); new.updated_at := new.created_at;
    return new;
  end if;
  if actor is null or not public.ops_can(case when TG_TABLE_NAME = 'ops_payment_records' then 'finance.write'
      when TG_TABLE_NAME = 'ops_payment_arrangements' then 'arrangements.approve' else 'operations.write' end) then
    raise exception 'Named active staff required';
  end if;
  if TG_OP = 'UPDATE' then
    if new.id <> old.id or new.booking_id <> old.booking_id then
      raise exception 'Record identity cannot change';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  else
    new.created_by := actor;
    new.created_at := clock_timestamp();
  end if;
  if TG_TABLE_NAME in ('ops_tasks', 'ops_payment_arrangements') then
    new.updated_by := actor;
    new.updated_at := clock_timestamp();
  end if;
  if TG_TABLE_NAME = 'ops_tasks' then
    if TG_OP = 'UPDATE' and new.task_key is distinct from old.task_key then
      raise exception 'Stable task identity cannot change';
    end if;
    new.created_by_system := case when TG_OP = 'UPDATE' then old.created_by_system else null end;
    new.updated_by_system := null;
  end if;
  if TG_TABLE_NAME = 'ops_notes' then
    if new.supersedes_id is not null and not exists
      (select 1 from public.ops_notes where id = new.supersedes_id and booking_id = new.booking_id) then
      raise exception 'Correction must belong to same booking';
    end if;
  end if;
  if TG_TABLE_NAME = 'ops_payment_records' then
    select jsonb_build_array(source_environment, source_account)::text into new.receipt_scope
      from public.ops_bookings where id = new.booking_id;
    new.receipt_key := nullif(trim(new.receipt_key), '');
    if new.supersedes_id is not null and not exists
      (select 1 from public.ops_payment_records where id = new.supersedes_id and booking_id = new.booking_id) then
      raise exception 'Correction must belong to same booking';
    end if;
  end if;
  return new;
end;
$$;

create function public.ops_audit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); actor_label text; actor_role_name text;
  row_data jsonb := to_jsonb(new); old_data jsonb := case when TG_OP = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  target_booking uuid;
begin
  if TG_OP = 'UPDATE' and
    (row_data - array['source_observed_at','last_synced_at','updated_at']) =
    (old_data - array['source_observed_at','last_synced_at','updated_at']) then return new; end if;
  if actor is not null then
    select display_name, role into actor_label, actor_role_name from public.ops_staff where user_id = actor;
    if actor_label is null then raise exception 'Unknown staff actor'; end if;
  else
    actor_label := case when auth.role() = 'service_role'
      and current_setting('bste.system_actor', true) = 'beds24_importer'
      then 'system/beds24_importer' else 'system/database' end;
    actor_role_name := coalesce(auth.role(), session_user);
  end if;
  target_booking := case when TG_TABLE_NAME = 'ops_bookings' then (row_data->>'id')::uuid
    else (row_data->>'booking_id')::uuid end;
  insert into public.ops_events(actor_user_id, actor_name, actor_role, action, entity_table, entity_id, booking_id, detail, system_run_id)
  values (actor, actor_label, actor_role_name, lower(TG_OP), TG_TABLE_NAME,
    coalesce(row_data->>'id', row_data->>'user_id', row_data->>'booking_id', row_data->>'role'),
    target_booking, jsonb_build_object('before', old_data, 'after', row_data),
    case when actor_label = 'system/beds24_importer' then nullif(current_setting('bste.system_run_id', true),'')::uuid end);
  return new;
end;
$$;

-- Audit contains guest/financial facts, so only administrators can read it.
create function public.ops_no_change() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Append-only history: add a correction instead'; end;
$$;

do $$
declare t text;
begin
  foreach t in array array['ops_tasks','ops_notes','ops_payment_records','ops_payment_arrangements'] loop
    execute format('create trigger stamp_staff before insert or update on public.%I for each row execute function public.ops_stamp_staff()', t);
  end loop;
  foreach t in array array['ops_staff','ops_role_permissions','ops_bookings','ops_booking_financial_snapshots','ops_tasks','ops_notes','ops_payment_records','ops_payment_arrangements','ops_communications'] loop
    execute format('create trigger audit_change after insert or update on public.%I for each row execute function public.ops_audit_change()', t);
  end loop;
  foreach t in array array['ops_notes','ops_payment_records','ops_events'] loop
    execute format('create trigger immutable_history before update or delete on public.%I for each row execute function public.ops_no_change()', t);
  end loop;
  foreach t in array array['ops_staff','ops_role_permissions','ops_properties','ops_bookings','ops_booking_financial_snapshots','ops_tasks','ops_notes','ops_payment_records','ops_payment_arrangements','ops_communications','ops_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select, insert, update on public.%I to service_role', t);
  end loop;
end;
$$;

create policy staff_self on public.ops_staff for select to authenticated using (user_id = auth.uid() and public.ops_session_valid());
create policy staff_permissions on public.ops_role_permissions for select to authenticated
  using (public.ops_can('operations.read'));
create policy property_read on public.ops_properties for select to authenticated using (public.ops_can('operations.read'));
create policy booking_read on public.ops_bookings for select to authenticated using (public.ops_can('operations.read'));
create policy tasks_read on public.ops_tasks for select to authenticated using (public.ops_can('operations.read'));
create policy notes_read on public.ops_notes for select to authenticated using (public.ops_can('operations.read'));
create policy communications_read on public.ops_communications for select to authenticated using (public.ops_can('operations.read'));
create policy finance_snapshot_read on public.ops_booking_financial_snapshots for select to authenticated using (public.ops_can('finance.read'));
create policy payments_read on public.ops_payment_records for select to authenticated using (public.ops_can('finance.read'));
create policy arrangements_read on public.ops_payment_arrangements for select to authenticated using (public.ops_can('finance.read'));
create policy events_read on public.ops_events for select to authenticated using (public.ops_can('audit.read'));

grant insert, update on public.ops_tasks, public.ops_payment_arrangements to authenticated;
grant insert on public.ops_notes, public.ops_payment_records to authenticated;
create policy task_insert on public.ops_tasks for insert to authenticated with check (public.ops_can('operations.write'));
create policy task_update on public.ops_tasks for update to authenticated using (public.ops_can('operations.write')) with check (public.ops_can('operations.write'));
create policy note_insert on public.ops_notes for insert to authenticated with check (public.ops_can('operations.write'));
create policy payment_insert on public.ops_payment_records for insert to authenticated with check (public.ops_can('finance.write'));
create policy arrangement_insert on public.ops_payment_arrangements for insert to authenticated with check (public.ops_can('arrangements.approve'));
create policy arrangement_update on public.ops_payment_arrangements for update to authenticated using (public.ops_can('arrangements.approve')) with check (public.ops_can('arrangements.approve'));

create function public.ops_record_session(event_name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare staff public.ops_staff;
begin
  if event_name not in ('application.session_started', 'application.sign_out_requested') then raise exception 'Invalid event'; end if;
  select * into staff from public.ops_staff where user_id = auth.uid() and is_active;
  if staff.user_id is null or not public.ops_session_valid() then raise exception 'Active staff required'; end if;
  if event_name = 'application.session_started' and not public.ops_can('operations.read') then
    raise exception 'MFA required';
  end if;
  insert into public.ops_events(actor_user_id, actor_name, actor_role, action, entity_table, entity_id, event_origin)
    values (staff.user_id, staff.display_name, staff.role, event_name, 'ops_staff', staff.user_id::text, 'application_report');
  return true;
end;
$$;
revoke all on function public.ops_record_session(text) from public, anon;
grant execute on function public.ops_record_session(text) to authenticated;
revoke all on function public.ops_stamp_staff(), public.ops_audit_change(), public.ops_no_change() from public, anon, authenticated;

-- No staff mutation of source snapshots or schedule; no deletes on any table.
-- Service-role calls are reserved for a later server-only importer, not staff actions.
revoke insert, update on public.ops_events from service_role;
revoke all on sequence public.ops_events_id_seq from public, anon, authenticated, service_role;
revoke update on public.ops_notes, public.ops_payment_records from service_role;

-- Import RPC is the only service-role source write path. It accepts selected
-- source facts, not full source JSON, and never calls an external service.
revoke insert, update on public.ops_bookings, public.ops_booking_financial_snapshots,
  public.ops_tasks from service_role;

create function public.ops_sync_booking(snapshot jsonb, financial jsonb, run_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare b public.ops_bookings; f public.ops_booking_financial_snapshots; result_id uuid;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null or run_id is null then
    raise exception 'System importer only';
  end if;
  if snapshot is null or jsonb_typeof(snapshot) <> 'object'
    or (financial is not null and jsonb_typeof(financial) <> 'object') then
    raise exception 'Snapshot object required';
  end if;
  perform set_config('bste.system_actor', 'beds24_importer', true);
  perform set_config('bste.system_run_id', run_id::text, true);
  b := jsonb_populate_record(null::public.ops_bookings, snapshot);
  -- Concurrent calls serialize via the unique source key and ON CONFLICT row lock.
  insert into public.ops_bookings(source_environment, source_account, beds24_booking_id,
    property_slug, beds24_property_id, beds24_room_id, arrival, departure, source_status,
    source_channel, guest_name, guest_email, guest_mobile, adults, children,
    source_modified_at, source_observed_at)
  values (b.source_environment, b.source_account, b.beds24_booking_id, b.property_slug,
    b.beds24_property_id, b.beds24_room_id, b.arrival, b.departure, b.source_status,
    b.source_channel, b.guest_name, b.guest_email, b.guest_mobile, b.adults, b.children,
    b.source_modified_at, b.source_observed_at)
  on conflict (source_environment, source_account, beds24_booking_id) do update set
    property_slug = excluded.property_slug, beds24_property_id = excluded.beds24_property_id,
    beds24_room_id = excluded.beds24_room_id, arrival = excluded.arrival, departure = excluded.departure,
    source_status = excluded.source_status, source_channel = excluded.source_channel,
    guest_name = excluded.guest_name, guest_email = excluded.guest_email, guest_mobile = excluded.guest_mobile,
    adults = excluded.adults, children = excluded.children,
    source_modified_at = excluded.source_modified_at, source_observed_at = excluded.source_observed_at,
    last_synced_at = clock_timestamp()
  returning id into result_id;
  -- NULL financial means not fetched: preserve previous financial data.
  if financial is not null then
    f := jsonb_populate_record(null::public.ops_booking_financial_snapshots, financial);
    if f.source_observed_at is distinct from b.source_observed_at
      or f.source_modified_at is distinct from b.source_modified_at then
      raise exception 'Financial snapshot must come from the same source observation';
    end if;
    insert into public.ops_booking_financial_snapshots(booking_id, source_price, source_currency,
      source_deposit, source_invoice_items, source_modified_at, source_observed_at)
    values (result_id, f.source_price, f.source_currency, f.source_deposit, f.source_invoice_items,
      f.source_modified_at, f.source_observed_at)
    on conflict (booking_id) do update set source_price = excluded.source_price,
      source_currency = excluded.source_currency, source_deposit = excluded.source_deposit,
      source_invoice_items = excluded.source_invoice_items, source_modified_at = excluded.source_modified_at,
      source_observed_at = excluded.source_observed_at;
  end if;
  perform set_config('bste.system_actor', '', true);
  perform set_config('bste.system_run_id', '', true);
  return result_id;
end;
$$;
create function public.ops_ensure_system_task(target_booking uuid, stable_key text,
  task_title text, task_due_at timestamptz, run_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  if auth.role() is distinct from 'service_role' or auth.uid() is not null or run_id is null then
    raise exception 'System importer only';
  end if;
  if stable_key is null or length(trim(stable_key)) = 0 then raise exception 'Task key required'; end if;
  perform set_config('bste.system_actor', 'beds24_importer', true);
  perform set_config('bste.system_run_id', run_id::text, true);
  insert into public.ops_tasks(booking_id, task_key, title, due_at)
    values (target_booking, stable_key, task_title, task_due_at)
    on conflict (booking_id, task_key) do nothing returning id into result_id;
  if result_id is null then
    select id into result_id from public.ops_tasks where booking_id = target_booking and task_key = stable_key;
  end if;
  perform set_config('bste.system_actor', '', true);
  perform set_config('bste.system_run_id', '', true);
  return result_id;
end;
$$;
revoke all on function public.ops_sync_booking(jsonb,jsonb,uuid),
  public.ops_ensure_system_task(uuid,text,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.ops_sync_booking(jsonb,jsonb,uuid),
  public.ops_ensure_system_task(uuid,text,text,timestamptz,uuid) to service_role;

commit;
