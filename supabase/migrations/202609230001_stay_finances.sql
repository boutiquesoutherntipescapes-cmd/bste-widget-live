-- Phase 1: isolated staging only. Apply manually after review; no external calls.
-- Requires both preceding operations migrations. No payouts or finalization enabled.
begin;
insert into public.ops_role_permissions values
 ('administrator','finance.configure'),('administrator','finance.review'),('administrator','finance.cutover');

create table public.ops_owner_rate_periods (
 id uuid primary key default gen_random_uuid(), property_slug text not null references public.ops_properties,
 season text not null check(season in ('low','high')), starts_on date not null, ends_on date not null,
 rate_cents bigint not null check(rate_cents>0 and rate_cents<=100000000),
 created_by uuid not null references public.ops_staff(user_id),created_at timestamptz not null default clock_timestamp(),
 request_key uuid not null unique, reason text not null check(length(trim(reason)) between 1 and 2000),
 supersedes_id uuid unique references public.ops_owner_rate_periods, check(ends_on>starts_on)
);
create table public.ops_stay_financial_reviews (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references public.ops_bookings,
 previous_id uuid unique references public.ops_stay_financial_reviews,
 request_key uuid not null unique, status text not null check(status in ('draft','reviewed')),
 accommodation_cents bigint not null check(accommodation_cents between 0 and 1000000000),
 cleaning_charge_cents bigint not null default 100000 check(cleaning_charge_cents between 0 and 1000000000),
 channel_fees_cents bigint not null check(channel_fees_cents between 0 and 1000000000),
 cleaner_cost_cents bigint not null default 80000 check(cleaner_cost_cents between 0 and 1000000000),
 cleaner_supplier text not null check(length(trim(cleaner_supplier)) between 1 and 200),
 -- Explicit cumulative evidence-backed assessment, not a sum of payment review labels.
 funds_received_cents bigint not null check(funds_received_cents between 0 and 1000000000),
 funds_evidence text, funds_as_of date not null,
 expenses_complete boolean not null default false,
 reason text not null check(length(trim(reason)) between 1 and 2000),currency text not null default 'ZAR' check(currency='ZAR'),
 source_basis jsonb not null,rate_nights jsonb not null,checkout_month date not null,
 created_by uuid not null references public.ops_staff(user_id),created_at timestamptz not null default clock_timestamp(),
 check(funds_received_cents=0 or length(trim(funds_evidence))>0 and funds_evidence is not null)
);
create table public.ops_stay_opening_positions (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references public.ops_bookings,
 previous_id uuid unique references public.ops_stay_opening_positions, request_key uuid not null unique,
 -- Date eligibility is not settlement. These are administrator-attested opening balances.
 opening_period boolean not null default true,
 owner_settlement_state text not null default 'outstanding' check(owner_settlement_state in ('outstanding','partially_settled','fully_settled')),
 cleaner_settlement_state text not null default 'outstanding' check(cleaner_settlement_state in ('outstanding','partially_settled','fully_settled')),
 owner_settled_cents bigint not null default 0 check(owner_settled_cents between 0 and 1000000000),
 cleaner_settled_cents bigint not null default 0 check(cleaner_settled_cents between 0 and 1000000000),
 state text not null check(state in ('fully_settled_historical','open')),
 check((state='fully_settled_historical')=(owner_settlement_state='fully_settled' and cleaner_settlement_state='fully_settled')),
 check(owner_settlement_state<>'outstanding' or owner_settled_cents=0),
 check(cleaner_settlement_state<>'outstanding' or cleaner_settled_cents=0),
 check(owner_settlement_state<>'partially_settled' or owner_settled_cents>0),
 check(cleaner_settlement_state<>'partially_settled' or cleaner_settled_cents>0),
 reason text not null check(length(trim(reason)) between 1 and 2000),
 confirmed_by_bond boolean not null,cutoff date not null default '2026-09-23' check(cutoff='2026-09-23'),
 created_by uuid not null references public.ops_staff(user_id),created_at timestamptz not null default clock_timestamp(),
 check((owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding') or confirmed_by_bond)
);
-- Existing rows retain their existing allocation. New versions are append-only.
alter table public.ops_stay_expenses
 drop constraint ops_stay_expenses_allocation_check,
 drop constraint ops_stay_expenses_check,
 drop constraint ops_stay_expenses_check1;
-- Named checks below replace the two anonymous allocation/approval checks.
alter table public.ops_stay_expenses
 add column supplier text,
 add column supplier_reference text,
 add column payer text check(payer in ('bste','owner','guest','unpaid')),
 add column guest_amount_cents bigint not null default 0,
 add column bste_amount_cents bigint,
 add column no_receipt_reason text,
 add column previous_id uuid unique references public.ops_stay_expenses,
 add column request_key uuid unique,
 add column change_reason text,
 add column is_void boolean not null default false,
 add constraint ops_expense_allocation_kind check(allocation in ('owner','bste','guest','split','needs_review')),
 add constraint ops_expense_approval check((status='approved' and approved_by is not null and approved_at is not null)
 or(status<>'approved' and approved_by is null and approved_at is null)),
 add constraint ops_expense_allocation_totals check(guest_amount_cents>=0 and coalesce(bste_amount_cents,amount_cents-owner_amount_cents)>=0
 and case when allocation='needs_review' then owner_amount_cents=0 and guest_amount_cents=0 and coalesce(bste_amount_cents,0)=0
 else owner_amount_cents+guest_amount_cents+coalesce(bste_amount_cents,amount_cents-owner_amount_cents)=amount_cents end),
 add constraint ops_expense_allocation_matches check(
 (allocation='owner' and owner_amount_cents=amount_cents) or
 (allocation='bste' and coalesce(bste_amount_cents,amount_cents-owner_amount_cents)=amount_cents) or
 (allocation='guest' and guest_amount_cents=amount_cents) or allocation in ('split','needs_review'));
create trigger immutable_expense before update or delete on public.ops_stay_expenses for each row execute function public.ops_no_change();
create table public.ops_expense_attachments (
 id uuid primary key default gen_random_uuid(),expense_id uuid not null references public.ops_stay_expenses,
 object_key text not null unique,original_name text not null check(length(original_name) between 1 and 200),
 media_type text not null check(media_type in ('image/jpeg','image/png','application/pdf')),
 size_bytes integer not null check(size_bytes between 1 and 2097152),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),request_key uuid not null unique,
 created_by uuid not null references public.ops_staff(user_id),created_at timestamptz not null default clock_timestamp()
);
-- No payout table or writable monthly state is enabled by Phase 1.

create table public.ops_finance_requests (
 request_key uuid primary key,actor uuid not null references public.ops_staff(user_id),
 action_name text not null,fingerprint text not null
);
revoke all on public.ops_finance_requests from public,anon,authenticated,service_role;
alter table public.ops_finance_requests enable row level security;

create function public.ops_finance_write(action_name text, input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result uuid; prior uuid; booking uuid; b public.ops_bookings;
 p public.ops_stay_expenses; rate public.ops_owner_rate_periods; nights jsonb; basis jsonb;
 owner_c bigint; guest_c bigint; bste_c bigint; amount bigint; status_value text; t text;
begin
 if not public.ops_can('finance.write') then raise exception 'Financial MFA access required'; end if;
 if action_name not in ('rate','review','expense','opening','attachment') then raise exception 'Unsupported financial action'; end if;
 if octet_length(input::text)>32768 then raise exception 'Financial input too large'; end if;
 if jsonb_typeof(input) is distinct from 'object' or (input->>'request_key')::uuid is null then raise exception 'Request key required'; end if;
 -- Serialize retries and each booking. Stale edits fail instead of silently winning.
 perform pg_advisory_xact_lock(hashtextextended('finance-request:'||(input->>'request_key'),0));
 if exists(select 1 from public.ops_finance_requests req where req.request_key=(input->>'request_key')::uuid
  and (req.actor<>auth.uid() or req.action_name<>ops_finance_write.action_name or req.fingerprint<>md5(input::text))) then
  raise exception 'Request key already used with different content or actor'; end if;
 insert into public.ops_finance_requests values((input->>'request_key')::uuid,actor,action_name,md5(input::text)) on conflict do nothing;
 t:=case action_name when 'rate' then 'ops_owner_rate_periods' when 'review' then 'ops_stay_financial_reviews'
 when 'expense' then 'ops_stay_expenses' when 'opening' then 'ops_stay_opening_positions' else 'ops_expense_attachments' end;
 execute format('select id from public.%I where request_key=$1',t) into result using (input->>'request_key')::uuid;
 if result is not null then return result; end if;
 if action_name='rate' then
  if not public.ops_can('finance.configure') then raise exception 'Rate configuration authority required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('owner-rate:'||(input->>'property_slug'),0));
  prior:=nullif(input->>'previous_id','')::uuid;
  if prior is not null and not exists(select 1 from public.ops_owner_rate_periods r where r.id=prior and r.property_slug=input->>'property_slug'
    and not exists(select 1 from public.ops_owner_rate_periods n where n.supersedes_id=r.id)) then raise exception 'Stale rate revision'; end if;
  if exists(select 1 from public.ops_owner_rate_periods r where r.property_slug=input->>'property_slug' and r.id is distinct from prior
   and not exists(select 1 from public.ops_owner_rate_periods n where n.supersedes_id=r.id)
   and r.starts_on<(input->>'ends_on')::date and r.ends_on>(input->>'starts_on')::date) then raise exception 'Overlapping owner rate periods'; end if;
  insert into public.ops_owner_rate_periods(property_slug,season,starts_on,ends_on,rate_cents,created_by,request_key,reason,supersedes_id)
  values(input->>'property_slug',input->>'season',(input->>'starts_on')::date,(input->>'ends_on')::date,
   (input->>'rate_cents')::bigint,actor,(input->>'request_key')::uuid,input->>'reason',prior) returning id into result;
  return result;
 end if;
 if action_name='attachment' then
  select * into p from public.ops_stay_expenses where id=(input->>'expense_id')::uuid;
  if p.id is null then raise exception 'Unknown expense'; end if;
  result:=gen_random_uuid();
  insert into public.ops_expense_attachments(id,expense_id,object_key,original_name,media_type,size_bytes,sha256,request_key,created_by)
  values(result,p.id,p.booking_id::text||'/'||result::text,input->>'original_name',input->>'media_type',
   (input->>'size_bytes')::integer,input->>'sha256',(input->>'request_key')::uuid,actor);
  return result;
 end if;
 booking:=(input->>'booking_id')::uuid;
 select * into b from public.ops_bookings where id=booking for update;
 if b.id is null then raise exception 'Unknown booking'; end if;
 prior:=nullif(input->>'previous_id','')::uuid;
 if action_name in ('review','opening') then
  execute format('select id from public.%I where booking_id=$1 order by created_at desc,id desc limit 1',t) into result using booking;
  if result is distinct from prior then raise exception 'Stale financial revision; reload'; end if;
 elsif prior is not null then
  select * into p from public.ops_stay_expenses where id=prior and booking_id=booking;
  if p.id is null or exists(select 1 from public.ops_stay_expenses where previous_id=prior) then raise exception 'Stale expense revision'; end if;
  if p.status='approved' and not public.ops_can('expenses.approve') then raise exception 'Approved expense correction requires approval authority'; end if;
 end if;
 if action_name='opening' then
  if not public.ops_can('finance.cutover') or not exists(select 1 from public.ops_staff where user_id=auth.uid() and role='administrator') then raise exception 'Cutover authority required (administrator only)'; end if;
  if (coalesce((input->>'opening_period')::boolean,true) or input->>'state'='fully_settled_historical') and b.departure>'2026-09-23'::date then raise exception 'Opening-period eligibility requires checkout on or before 2026-09-23'; end if;
  insert into public.ops_stay_opening_positions(booking_id,previous_id,request_key,state,reason,confirmed_by_bond,created_by,opening_period,owner_settlement_state,cleaner_settlement_state,owner_settled_cents,cleaner_settled_cents)
  values(booking,prior,(input->>'request_key')::uuid,input->>'state',input->>'reason',coalesce((input->>'confirmed_by_bond')::boolean,false),actor,
   coalesce((input->>'opening_period')::boolean,true),
   coalesce(input->>'owner_settlement_state',case when input->>'state'='fully_settled_historical' then 'fully_settled' else 'outstanding' end),
   coalesce(input->>'cleaner_settlement_state',case when input->>'state'='fully_settled_historical' then 'fully_settled' else 'outstanding' end),
   coalesce((input->>'owner_settled_cents')::bigint,0),coalesce((input->>'cleaner_settled_cents')::bigint,0)) returning id into result;
 elsif action_name='review' then
  status_value:=input->>'status';
  if status_value='reviewed' and not public.ops_can('finance.review') then raise exception 'Review authority required'; end if;
  -- One configured rate for every stay night; no approximate/global defaults.
  perform pg_advisory_xact_lock(hashtextextended('owner-rate:'||b.property_slug,0));
  select jsonb_agg(jsonb_build_object('night',d::date,'rate_id',r.id,'season',r.season,'rate_cents',r.rate_cents) order by d)
   into nights from generate_series(b.arrival::timestamp,(b.departure-1)::timestamp,interval '1 day') d
   left join public.ops_owner_rate_periods r on r.property_slug=b.property_slug and d::date>=r.starts_on and d::date<r.ends_on
    and not exists(select 1 from public.ops_owner_rate_periods n where n.supersedes_id=r.id);
  if exists(select 1 from jsonb_array_elements(nights) n where n->>'rate_id' is null) then raise exception 'Configure owner rates for every stay night'; end if;
  select jsonb_build_object('booking',to_jsonb(b),'financial',to_jsonb(f)) into basis
   from public.ops_bookings bb left join public.ops_booking_financial_snapshots f on f.booking_id=bb.id where bb.id=booking;
  if (input->>'funds_as_of')::date>(now() at time zone 'Africa/Johannesburg')::date then raise exception 'Funds evidence date cannot be in future'; end if;
  insert into public.ops_stay_financial_reviews(booking_id,previous_id,request_key,status,accommodation_cents,cleaning_charge_cents,
    channel_fees_cents,cleaner_cost_cents,cleaner_supplier,funds_received_cents,funds_evidence,funds_as_of,reason,source_basis,rate_nights,checkout_month,created_by,expenses_complete)
  values(booking,prior,(input->>'request_key')::uuid,status_value,(input->>'accommodation_cents')::bigint,
   coalesce((input->>'cleaning_charge_cents')::bigint,100000),(input->>'channel_fees_cents')::bigint,
   coalesce((input->>'cleaner_cost_cents')::bigint,80000),input->>'cleaner_supplier',(input->>'funds_received_cents')::bigint,
   input->>'funds_evidence',(input->>'funds_as_of')::date,input->>'reason',basis,nights,date_trunc('month',b.departure)::date,actor,coalesce((input->>'expenses_complete')::boolean,false)) returning id into result;
 else
  amount:=(input->>'amount_cents')::bigint;
  if amount is null or amount<=0 or amount>1000000000 then raise exception 'Invalid expense amount'; end if;owner_c:=coalesce((input->>'owner_amount_cents')::bigint,0);
  guest_c:=coalesce((input->>'guest_amount_cents')::bigint,0);bste_c:=coalesce((input->>'bste_amount_cents')::bigint,0);
  status_value:=input->>'status';
  if status_value='approved' and not public.ops_can('expenses.approve') then raise exception 'Expense approval authority required'; end if;
  if input->>'allocation'='needs_review' and status_value='approved' then raise exception 'Resolve allocation before approval'; end if;
  if coalesce((input->>'is_void')::boolean,false) and prior is null then raise exception 'Void requires an existing expense'; end if;
  if input->>'category' not in ('stocking','laundry','maintenance','consumables','welcome_items','repairs','contractor','miscellaneous') then raise exception 'Unsupported expense category; cleaner cost belongs in finance review'; end if;
  if nullif(trim(input->>'supplier'),'') is null or input->>'payer' is null or nullif(trim(input->>'reason'),'') is null then raise exception 'Supplier, payer and reason required'; end if;
  if nullif(trim(input->>'supplier_reference'),'') is not null and exists(
   select 1 from public.ops_stay_expenses x where x.booking_id=booking and x.id is distinct from prior
   and not x.is_void and not exists(select 1 from public.ops_stay_expenses n where n.previous_id=x.id)
   and lower(trim(x.supplier))=lower(trim(input->>'supplier')) and trim(x.supplier_reference)=trim(input->>'supplier_reference')
   and x.amount_cents=amount and x.category=input->>'category' and x.incurred_on=(input->>'incurred_on')::date
  ) then raise exception 'Duplicate expense reference; correct the existing entry'; end if;
  insert into public.ops_stay_expenses(booking_id,property_slug,incurred_on,category,description,amount_cents,currency,allocation,
   owner_amount_cents,guest_amount_cents,bste_amount_cents,supplier,supplier_reference,payer,no_receipt_reason,previous_id,request_key,change_reason,is_void,
   status,created_by,approved_by,approved_at)
  values(booking,b.property_slug,(input->>'incurred_on')::date,input->>'category',input->>'description',amount,'ZAR',input->>'allocation',
   owner_c,guest_c,bste_c,input->>'supplier',input->>'supplier_reference',input->>'payer',input->>'no_receipt_reason',prior,(input->>'request_key')::uuid,
   input->>'reason',coalesce((input->>'is_void')::boolean,false),status_value,actor,
   case when status_value='approved' then actor end,case when status_value='approved' then clock_timestamp() end) returning id into result;
 end if;
 return result;
end $$;

-- Private evidence only, no public URLs and no overwrite/delete rights.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('ops-stay-receipts','ops-stay-receipts',false,2097152,array['image/jpeg','image/png','application/pdf']);
create policy ops_receipt_read on storage.objects for select to authenticated using(
 bucket_id='ops-stay-receipts' and public.ops_can('finance.read') and exists(select 1 from public.ops_expense_attachments a where a.object_key=name));
create policy ops_receipt_insert on storage.objects for insert to authenticated with check(
 bucket_id='ops-stay-receipts' and public.ops_can('finance.write') and exists(select 1 from public.ops_expense_attachments a where a.object_key=name and a.created_by=auth.uid()));

do $$ declare t text; begin
 foreach t in array array['ops_owner_rate_periods','ops_stay_financial_reviews','ops_stay_opening_positions','ops_expense_attachments'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy finance_read on public.%I for select to authenticated using(public.ops_can(''finance.read''))',t);
  execute format('create trigger immutable before update or delete on public.%I for each row execute function public.ops_no_change()',t);
  execute format('create trigger audit_change after insert on public.%I for each row execute function public.ops_audit_change()',t);
 end loop;
end $$;
revoke all on function public.ops_finance_write(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ops_finance_write(text,jsonb) to authenticated;
-- Restricted financial history; never grant Finance access to the whole audit log.
create function public.ops_finance_history(target_booking uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.ops_can('finance.read') then raise exception 'Financial MFA access required'; end if;
 select coalesce(jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id),'[]'::jsonb) into result
 from public.ops_events e where (e.booking_id=target_booking and e.entity_table in
 ('ops_stay_expenses','ops_stay_financial_reviews','ops_stay_opening_positions','ops_payment_records'))
 or (e.entity_table='ops_expense_attachments' and e.entity_id in
 (select a.id::text from public.ops_expense_attachments a join public.ops_stay_expenses x on x.id=a.expense_id where x.booking_id=target_booking));
 return result;
end $$;
revoke all on function public.ops_finance_history(uuid) from public,anon,authenticated,service_role;
grant execute on function public.ops_finance_history(uuid) to authenticated;
commit;
