-- Phase 1A only. No provider calls, existing-row changes or write RPCs.
-- Unapplied: review and validate in isolated staging before later phases.
-- Phase 1C must replace the disabled-protection gate with evidence-checked narrow
-- RPCs and environment-specific inventory allowlists. No real held state yet.
begin;
create table public.direct_checkouts (
 id uuid primary key default gen_random_uuid(),
 environment text not null check(environment in ('sandbox','production')),
 idempotency_key uuid not null,
 property_slug text not null references public.ops_properties(property_slug),
 arrival date not null, departure date not null check(departure>arrival),
 adults integer not null check(adults>0), children integer not null check(children>=0),
 quote_reference uuid not null, quote_version text not null check(length(quote_version) between 1 and 100),
 quote_created_at timestamptz not null, quote_expires_at timestamptz not null check(quote_expires_at>quote_created_at),
 total_cents bigint not null check(total_cents between 1 and 9007199254740991),
 currency text not null default 'ZAR' check(currency='ZAR'),
 schedule_date date not null check(schedule_date<=arrival),
 due_now_cents bigint not null,
 balance_cents bigint not null check(balance_cents>=0),
 balance_due_date date not null,
 terms_version text not null check(length(terms_version) between 1 and 100),
 terms_accepted_at timestamptz not null,
 terms_acceptance_reference uuid not null,
 state text not null default 'quoted' check(state in ('quoted','preparing','held','confirmed','cancelling','cancelled','expired')),
 review_required boolean not null default false,
 recovery_code text check(recovery_code in ('inventory_uncertain','payment_uncertain','confirmation_failed','release_failed','late_payment','storage_recovery')),
 hold_minutes integer not null default 30 check(hold_minutes between 1 and 1440),
 -- Pending timestamps/references are not proof of external protection.
 protected_at timestamptz, hold_expires_at timestamptz,
 inventory_scope text generated always as (case when environment='sandbox' then 'isolated_test' else 'live' end) stored,
 protection_verified boolean not null default false,
 constraint direct_protection_disabled_phase1a check(protection_verified=false),
 reservation_reference uuid not null default gen_random_uuid(),
 beds24_account text, beds24_reservation_id bigint check(beds24_reservation_id>0),
 ops_booking_id uuid references public.ops_bookings(id),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 unique(environment,idempotency_key),unique(environment,reservation_reference),unique(id,environment),
 unique(environment,beds24_account,beds24_reservation_id), unique(ops_booking_id),
 check(due_now_cents=case when arrival-schedule_date>7 then total_cents/2+total_cents%2 else total_cents end),
 check(balance_cents=total_cents-due_now_cents and balance_due_date=arrival-7),
 check((protected_at is null and hold_expires_at is null) or
  (protected_at is not null and hold_expires_at is not null and hold_expires_at>protected_at
   and hold_expires_at=protected_at+hold_minutes*interval '1 minute')),
 check(state not in ('held','confirmed') or (protection_verified and protected_at is not null and hold_expires_at is not null and beds24_reservation_id is not null)),
 check((beds24_account is null)=(beds24_reservation_id is null)),
 check(beds24_account is null or length(trim(beds24_account)) between 1 and 120)
);
create table public.payment_attempts (
 id uuid primary key default gen_random_uuid(),
 checkout_id uuid not null, environment text not null,
 provider text not null default 'payfast' check(provider='payfast'),
 merchant_scope text not null check(length(trim(merchant_scope)) between 1 and 100), -- non-secret logical merchant identifier
 initiation_key uuid not null,
 purpose text not null check(purpose in ('deposit','balance','full')),
 expected_cents bigint not null check(expected_cents between 1 and 9007199254740991),
 currency text not null default 'ZAR' check(currency='ZAR'),
 provider_reference text check(length(provider_reference) between 1 and 120),
 state text not null default 'created' check(state in ('created','pending','verified','failed','cancelled','review')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 foreign key(checkout_id,environment) references public.direct_checkouts(id,environment),
 unique(environment,provider,merchant_scope,initiation_key),
 unique(environment,provider,merchant_scope,provider_reference),
 unique(id,environment,provider,merchant_scope)
);
create table public.payment_events (
 id uuid primary key default gen_random_uuid(),
 attempt_id uuid not null,environment text not null,provider text not null,merchant_scope text not null,
 event_key text not null check(length(event_key) between 1 and 128), -- deterministic safe hash, never raw request
 provider_transaction_id text check(length(provider_transaction_id) between 1 and 120),
 verification_result text not null check(verification_result in ('accepted','rejected','uncertain')),
 provider_status text not null check(provider_status in ('complete','failed','cancelled','pending','unknown','refunded')), -- refund recording disabled below
 amount_cents bigint check(amount_cents between 0 and 9007199254740991),
 currency text check(currency ~ '^[A-Z]{3}$'),
 signature_valid boolean not null,source_valid boolean not null,merchant_valid boolean not null,identity_valid boolean not null,amount_valid boolean not null,
 reason_code text not null check(reason_code in ('verified','signature_mismatch','source_mismatch','merchant_mismatch','identity_mismatch','amount_mismatch','status_rejected','verification_unavailable')),
 received_at timestamptz not null default clock_timestamp(),processed_at timestamptz not null default clock_timestamp(),
 foreign key(attempt_id,environment,provider,merchant_scope) references public.payment_attempts(id,environment,provider,merchant_scope),
 unique(environment,provider,merchant_scope,event_key),
 check(provider_status<>'refunded'),
 check(verification_result<>'accepted' or (provider_status='complete' and provider_transaction_id is not null and amount_cents is not null and amount_cents>0 and currency is not null and currency='ZAR'
 and signature_valid and source_valid and merchant_valid and identity_valid and amount_valid and reason_code='verified'))
);
-- Rejected/uncertain observations do not consume the once-only successful receipt key.
create unique index payment_transaction_once on public.payment_events(environment,provider,merchant_scope,provider_transaction_id) where verification_result='accepted';
create table public.checkout_actions (
 id uuid primary key default gen_random_uuid(),checkout_id uuid not null,environment text not null,
 action text not null check(action in ('protect','confirm','release','reconcile')),
 idempotency_key uuid not null,
 state text not null default 'pending' check(state in ('pending','running','retry','succeeded','review')),
 retry_count integer not null default 0 check(retry_count>=0),
 next_attempt_at timestamptz,lease_expires_at timestamptz,
 error_code text check(error_code in ('provider_unavailable','inventory_conflict','outcome_uncertain','verification_failed','storage_failure')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 foreign key(checkout_id,environment) references public.direct_checkouts(id,environment),
 unique(environment,idempotency_key),unique(checkout_id,action)
);
create function public.direct_checkout_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'Checkout history cannot be deleted'; end if;
 if tg_op='INSERT' and new.state<>'quoted' then raise exception 'Checkout starts quoted'; end if;
 if tg_op='UPDATE' then
  -- Generated inventory_scope is recomputed AFTER BEFORE triggers; environment itself remains immutable.
  if (to_jsonb(new)-array['inventory_scope','state','review_required','recovery_code','protected_at','hold_expires_at','beds24_account','beds24_reservation_id','ops_booking_id','updated_at'])
   is distinct from (to_jsonb(old)-array['inventory_scope','state','review_required','recovery_code','protected_at','hold_expires_at','beds24_account','beds24_reservation_id','ops_booking_id','updated_at']) then raise exception 'Checkout agreement is immutable'; end if;
  if old.beds24_reservation_id is not null and (new.beds24_account,new.beds24_reservation_id) is distinct from (old.beds24_account,old.beds24_reservation_id) then raise exception 'Reservation link is immutable'; end if;
  if old.ops_booking_id is not null and new.ops_booking_id is distinct from old.ops_booking_id then raise exception 'Operations link is immutable'; end if;
  if old.protected_at is not null and (new.protected_at,new.hold_expires_at) is distinct from (old.protected_at,old.hold_expires_at) then raise exception 'Hold cannot restart or extend'; end if;
  if new.state<>old.state and not (
(old.state='quoted' and new.state in ('preparing','expired','cancelled'))
   or (old.state='preparing' and new.state in ('held','quoted','cancelling'))
   or (old.state='held' and new.state in ('confirmed','cancelling'))
   or (old.state='confirmed' and new.state in ('cancelling'))
   or (old.state='cancelling' and new.state in ('cancelled','expired'))
  ) then raise exception 'Invalid reservation transition'; end if;
 end if;
 if new.ops_booking_id is not null and not exists(select 1 from public.ops_bookings b where b.id=new.ops_booking_id and b.source_environment=new.environment
  and b.property_slug=new.property_slug and b.arrival=new.arrival and b.departure=new.departure
  and b.beds24_booking_id=new.beds24_reservation_id and b.source_account=new.beds24_account) then raise exception 'Operations link/environment mismatch'; end if;
 new.updated_at=clock_timestamp();return new;
end $$;
create trigger direct_checkout_guard before insert or update or delete on public.direct_checkouts for each row execute function public.direct_checkout_guard();
create function public.payment_event_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'INSERT' then raise exception 'Payment events are append-only'; end if;
 if new.verification_result='accepted' and not exists(select 1 from public.payment_attempts a where a.id=new.attempt_id and a.expected_cents=new.amount_cents and a.currency=new.currency) then raise exception 'Verified amount does not match attempt'; end if;
 return new;
end $$;
create trigger payment_event_guard before insert or update or delete on public.payment_events for each row execute function public.payment_event_guard();
create function public.checkout_work_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception 'Payment work history cannot be deleted'; end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-array['state','provider_reference','retry_count','next_attempt_at','lease_expires_at','error_code','updated_at'])
   is distinct from (to_jsonb(old)-array['state','provider_reference','retry_count','next_attempt_at','lease_expires_at','error_code','updated_at']) then raise exception 'Work identity is immutable'; end if;
  if tg_table_name='payment_attempts' then
   if old.provider_reference is not null and new.provider_reference is distinct from old.provider_reference then raise exception 'Provider reference is immutable'; end if;
   if new.state<>old.state and not (
    (old.state='created' and new.state in ('pending','failed','cancelled','review')) or
    (old.state='pending' and new.state in ('verified','failed','cancelled','review')) or
    (old.state='review' and new.state in ('verified','failed','cancelled'))
   ) then raise exception 'Invalid attempt transition'; end if;
  else
   if new.retry_count<old.retry_count then raise exception 'Retry counter cannot decrease'; end if;
   if new.state<>old.state and not (
    (old.state in ('pending','retry') and new.state in ('running','review')) or
    (old.state='running' and new.state in ('retry','succeeded','review')) or
    (old.state='review' and new.state='retry')
   ) then raise exception 'Invalid action transition'; end if;
  end if;
 end if;
 if tg_table_name='payment_attempts' then
  if tg_op='INSERT' and new.state<>'created' then raise exception 'Attempt starts created'; end if;
  if not exists(select 1 from public.direct_checkouts c where c.id=new.checkout_id and
   ((new.purpose='deposit' and c.due_now_cents<c.total_cents and new.expected_cents=c.due_now_cents)
    or (new.purpose='full' and new.expected_cents=c.total_cents)
    or (new.purpose='balance' and new.expected_cents<=c.balance_cents))) then raise exception 'Attempt amount/purpose does not match checkout'; end if;
  if new.state='verified' and not exists(select 1 from public.payment_events e where e.attempt_id=new.id and e.verification_result='accepted') then raise exception 'Verified receipt required'; end if;
 else
  if tg_op='INSERT' and new.state<>'pending' then raise exception 'Action starts pending'; end if;
 end if;
 new.updated_at=clock_timestamp();return new;
end $$;
create trigger checkout_work_guard before insert or update or delete on public.payment_attempts for each row execute function public.checkout_work_guard();
create trigger checkout_work_guard before insert or update or delete on public.checkout_actions for each row execute function public.checkout_work_guard();
revoke all on function public.checkout_work_guard() from public,anon,authenticated,service_role;
-- Reuse the existing append-only audit ledger, without touching financial ledgers.
create function public.direct_payment_audit() returns trigger language plpgsql security definer set search_path='' as $$
declare prior jsonb:='{}'; actor_label text;
begin
 if tg_op='UPDATE' then prior=to_jsonb(old); if to_jsonb(new)-'updated_at'=prior-'updated_at' then return new; end if; end if;
 if auth.uid() is not null then
  select display_name into actor_label from public.ops_staff where user_id=auth.uid();
  if actor_label is null then raise exception 'Unknown audit actor'; end if;
 else actor_label='Database/system boundary'; end if;
 insert into public.ops_events(actor_user_id,actor_name,actor_role,action,entity_table,entity_id,detail)
 values(auth.uid(),actor_label,coalesce(auth.role(),'database_owner'),'direct_payment.'||lower(tg_op),tg_table_name,new.id::text,
 jsonb_build_object('previous_state',prior->>'state','state',to_jsonb(new)->>'state','environment',new.environment,
 'verification_result',to_jsonb(new)->>'verification_result','review_required',to_jsonb(new)->'review_required',
 'recovery_code',to_jsonb(new)->>'recovery_code','retry_count',to_jsonb(new)->'retry_count'));
 return new;
end $$;
revoke all on function public.direct_payment_audit() from public,anon,authenticated,service_role;
-- No provider processing capability is granted in Phase 1A. Future narrow RPCs
-- must validate evidence, lock checkout/attempt, and atomically append receipt + job.
-- Refund state is reserved, not enabled; no ownership/cleaner ledger writes exist.
alter table public.direct_checkouts enable row level security;
revoke all on public.direct_checkouts from public,anon,authenticated,service_role;
grant select on public.direct_checkouts to authenticated;
create policy direct_checkouts_finance_read on public.direct_checkouts for select to authenticated using(public.ops_can('finance.read'));
alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from public,anon,authenticated,service_role;
grant select on public.payment_attempts to authenticated;
create policy payment_attempts_finance_read on public.payment_attempts for select to authenticated using(public.ops_can('finance.read'));
alter table public.payment_events enable row level security;
revoke all on public.payment_events from public,anon,authenticated,service_role;
grant select on public.payment_events to authenticated;
create policy payment_events_finance_read on public.payment_events for select to authenticated using(public.ops_can('finance.read'));
alter table public.checkout_actions enable row level security;
revoke all on public.checkout_actions from public,anon,authenticated,service_role;
grant select on public.checkout_actions to authenticated;
create policy checkout_actions_finance_read on public.checkout_actions for select to authenticated using(public.ops_can('finance.read'));
revoke all on function public.direct_checkout_guard(),public.payment_event_guard() from public,anon,authenticated,service_role;
create trigger direct_payment_audit after insert or update on public.direct_checkouts for each row execute function public.direct_payment_audit();
create trigger direct_payment_audit after insert or update on public.payment_attempts for each row execute function public.direct_payment_audit();
create trigger direct_payment_audit after insert or update on public.payment_events for each row execute function public.direct_payment_audit();
create trigger direct_payment_audit after insert or update on public.checkout_actions for each row execute function public.direct_payment_audit();
commit;
