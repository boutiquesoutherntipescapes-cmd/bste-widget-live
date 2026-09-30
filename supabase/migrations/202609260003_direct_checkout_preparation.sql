-- Phase 1B: sandbox checkout preparation ONLY. Unapplied; no inventory/payment writes.
begin;
create table public.direct_checkout_preparations (
 checkout_id uuid primary key references public.direct_checkouts(id),
 quote_reference uuid not null unique,
 request_fingerprint text not null check(request_fingerprint ~ '^[0-9a-f]{64}$'),
 access_hash text not null unique check(access_hash ~ '^[0-9a-f]{64}$'),
 first_name text not null check(length(trim(first_name)) between 1 and 100),
 surname text not null check(length(trim(surname)) between 1 and 100),
 email text not null check(length(email) between 3 and 254),
 mobile text not null check(length(mobile) between 7 and 16),
 quote_snapshot jsonb not null check(jsonb_typeof(quote_snapshot)='object'),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.direct_checkout_preparations enable row level security;
revoke all on public.direct_checkout_preparations from public,anon,authenticated,service_role;
-- No guest/finance browser table access. Future guest-detail access needs its own reviewed boundary.
create trigger immutable_preparation before update or delete on public.direct_checkout_preparations
 for each row execute function public.ops_no_change();
create function public.direct_prepared_response(target uuid) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('checkout_id',c.id,'reference',c.reservation_reference,'state',c.state,
 'quote',p.quote_snapshot,'inventory_protected',false,'payment_enabled',false,
 'notice','Preparation only. Availability is preliminary; dates are not reserved and payment is unavailable.')
 from public.direct_checkouts c join public.direct_checkout_preparations p on p.checkout_id=c.id
 where c.id=target and c.environment='sandbox'
$$;
revoke all on function public.direct_prepared_response(uuid) from public,anon,authenticated,service_role;
create function public.direct_prepare_checkout(prepared jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q jsonb; g jsonb; c public.direct_checkouts; fingerprint text; result_id uuid; now_at timestamptz:=clock_timestamp();
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'SERVER_PREPARATION_ONLY';end if;
 if jsonb_typeof(prepared) is distinct from 'object' or (prepared-array['quote','quote_reference','quote_created_at','quote_expires_at','hold_minutes','idempotency_key','guest','access_hash'])<>'{}'::jsonb then raise exception 'INVALID_PREPARATION';end if;
 q=prepared->'quote';g=prepared->'guest';
 if jsonb_typeof(q) is distinct from 'object' or jsonb_typeof(g) is distinct from 'object'
  or (g-array['first_name','surname','email','mobile'])<>'{}'::jsonb
  or (q-array['property_slug','arrival','departure','adults','children','currency','nights','breakdown','accommodation_cents','cleaning_cents','total_cents','min_stay_required','min_stay_ok','due_now_cents','balance_cents','balance_due_date','balance_deadline','schedule_date','pricing_version','terms_version','terms_url'])<>'{}'::jsonb then raise exception 'INVALID_PREPARATION';end if;
 fingerprint=encode(sha256(convert_to(prepared::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('sandbox-checkout:'||(prepared->>'idempotency_key'),0));
 select * into c from public.direct_checkouts where environment='sandbox' and idempotency_key=(prepared->>'idempotency_key')::uuid for update;
 if c.id is not null then
  if not exists(select 1 from public.direct_checkout_preparations p where p.checkout_id=c.id and p.request_fingerprint=fingerprint and p.access_hash=prepared->>'access_hash') then raise exception 'CHECKOUT_IDEMPOTENCY_CONFLICT';end if;
  return public.direct_prepared_response(c.id);
 end if;
 if exists(select 1 from public.direct_checkout_preparations where quote_reference=(prepared->>'quote_reference')::uuid) then raise exception 'QUOTE_ALREADY_PREPARED';end if;
 if (prepared->>'quote_expires_at')::timestamptz is null or (prepared->>'quote_expires_at')::timestamptz<=now_at
  or (prepared->>'quote_created_at')::timestamptz>now_at+interval '1 minute'
  or (prepared->>'quote_expires_at')::timestamptz-(prepared->>'quote_created_at')::timestamptz<>interval '30 minutes' then raise exception 'QUOTE_EXPIRED';end if;
 if (q->>'schedule_date')::date is distinct from (now_at at time zone 'Africa/Johannesburg')::date
  or (q->>'arrival')::date<(now_at at time zone 'Africa/Johannesburg')::date
  or (q->>'departure')::date-(q->>'arrival')::date is distinct from (q->>'nights')::integer
  or (q->>'min_stay_ok')::boolean is distinct from true
  or (q->>'total_cents')::bigint is distinct from (q->>'accommodation_cents')::bigint+(q->>'cleaning_cents')::bigint
  or jsonb_typeof(q->'breakdown') is distinct from 'array'
  or jsonb_array_length(q->'breakdown') is distinct from (q->>'nights')::integer then raise exception 'INVALID_QUOTE';end if;
 insert into public.direct_checkouts(environment,idempotency_key,property_slug,arrival,departure,adults,children,
 quote_reference,quote_version,quote_created_at,quote_expires_at,total_cents,currency,schedule_date,due_now_cents,balance_cents,balance_due_date,
 terms_version,terms_accepted_at,terms_acceptance_reference,hold_minutes)
 values('sandbox',(prepared->>'idempotency_key')::uuid,q->>'property_slug',(q->>'arrival')::date,(q->>'departure')::date,(q->>'adults')::integer,(q->>'children')::integer,
 (prepared->>'quote_reference')::uuid,q->>'pricing_version',(prepared->>'quote_created_at')::timestamptz,(prepared->>'quote_expires_at')::timestamptz,
 (q->>'total_cents')::bigint,q->>'currency',(q->>'schedule_date')::date,(q->>'due_now_cents')::bigint,(q->>'balance_cents')::bigint,(q->>'balance_due_date')::date,
 q->>'terms_version',now_at,gen_random_uuid(),(prepared->>'hold_minutes')::integer) returning id into result_id;
 insert into public.direct_checkout_preparations(checkout_id,quote_reference,request_fingerprint,access_hash,first_name,surname,email,mobile,quote_snapshot)
 values(result_id,(prepared->>'quote_reference')::uuid,fingerprint,prepared->>'access_hash',g->>'first_name',g->>'surname',g->>'email',g->>'mobile',q);
 update public.direct_checkouts set state='preparing' where id=result_id;
 return public.direct_prepared_response(result_id);
end $$;
create function public.direct_checkout_status(target uuid,access_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' or auth.uid() is not null then raise exception 'SERVER_PREPARATION_ONLY';end if;
 if not exists(select 1 from public.direct_checkout_preparations p where p.checkout_id=target and p.access_hash=direct_checkout_status.access_hash) then raise exception 'CHECKOUT_NOT_FOUND';end if;
 return public.direct_prepared_response(target);
end $$;
revoke all on function public.direct_prepare_checkout(jsonb),public.direct_checkout_status(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.direct_prepare_checkout(jsonb),public.direct_checkout_status(uuid,text) to service_role;
-- Existing Phase 1A table grants, protection-disabled gate and financial ledgers unchanged.
commit;
