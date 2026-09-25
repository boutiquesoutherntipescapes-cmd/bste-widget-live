-- Separate correction; never edit/reapply the previously installed migrations.
-- Does not create opening positions or payments. Existing rows are not rewritten.
begin;
-- NULL on existing/imported rows means knowledge was not recorded by that writer.
-- For new finance-write rows false explicitly means unknown, not zero paid.
alter table public.ops_stay_opening_positions
 add column if not exists owner_settled_amount_known boolean,
 add column if not exists cleaner_settled_amount_known boolean;
create or replace function public.ops_finance_write(action_name text, input jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); result uuid; prior uuid; booking uuid; b public.ops_bookings;
 p public.ops_stay_expenses; rate public.ops_owner_rate_periods; nights jsonb; basis jsonb;
 owner_c bigint; guest_c bigint; bste_c bigint; amount bigint; status_value text; t text;
 opening_state text; owner_state text; cleaner_state text; owner_paid bigint; cleaner_paid bigint;
 owner_known boolean; cleaner_known boolean; period_value boolean; bond_value boolean;
begin
 if not public.ops_can('finance.write') then raise exception 'Financial MFA access required'; end if;
 if action_name='opening' and (not public.ops_can('finance.cutover') or not exists(select 1 from public.ops_staff where user_id=actor and role='administrator' and is_active)) then raise exception 'Cutover authority required (administrator only)'; end if;
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
  opening_state:=input->>'state';
  if opening_state is null or opening_state not in ('open','fully_settled_historical') then raise exception 'Invalid opening state'; end if;
  owner_state:=coalesce(input->>'owner_settlement_state',case when opening_state='fully_settled_historical' then 'fully_settled' else 'outstanding' end);
  cleaner_state:=coalesce(input->>'cleaner_settlement_state',case when opening_state='fully_settled_historical' then 'fully_settled' else 'outstanding' end);
  if owner_state not in ('outstanding','partially_settled','fully_settled') or cleaner_state not in ('outstanding','partially_settled','fully_settled') then raise exception 'Invalid obligation state'; end if;
  if (opening_state='fully_settled_historical') is distinct from (owner_state='fully_settled' and cleaner_state='fully_settled') then raise exception 'Opening state contradicts obligation states'; end if;
  period_value:=coalesce((input->>'opening_period')::boolean,true);
  bond_value:=coalesce((input->>'confirmed_by_bond')::boolean,false);
  if (period_value or opening_state='fully_settled_historical') and b.departure>'2026-09-23'::date then raise exception 'Opening-period eligibility requires checkout on or before 2026-09-23'; end if;
  -- Amounts must be integer cents, never rounded, inferred from revenue or invented.
  if (input->>'owner_settled_cents' is not null and input->>'owner_settled_cents' !~ '^[0-9]+$')
   or (input->>'cleaner_settled_cents' is not null and input->>'cleaner_settled_cents' !~ '^[0-9]+$') then raise exception 'Settled amounts must be non-negative integer cents'; end if;
  owner_paid:=coalesce((input->>'owner_settled_cents')::bigint,0);
  cleaner_paid:=coalesce((input->>'cleaner_settled_cents')::bigint,0);
  owner_known:=owner_state='outstanding' or input->>'owner_settled_cents' is not null;
  cleaner_known:=cleaner_state='outstanding' or input->>'cleaner_settled_cents' is not null;
  if owner_paid>1000000000 or cleaner_paid>1000000000 then raise exception 'Settled amount exceeds limit'; end if;
  if (owner_state='outstanding' and owner_paid<>0) or (cleaner_state='outstanding' and cleaner_paid<>0) then raise exception 'Outstanding obligation cannot include prior paid amount'; end if;
  if (owner_state='partially_settled' and (not owner_known or owner_paid<=0)) or (cleaner_state='partially_settled' and (not cleaner_known or cleaner_paid<=0)) then raise exception 'Partial settlement requires a known positive paid amount'; end if;
  if (owner_state<>'outstanding' or cleaner_state<>'outstanding') and not bond_value then raise exception 'Bond confirmation required for prior settlement'; end if;
  -- Unknown historical cash amounts retain a zero storage placeholder ONLY with
  -- amount_known=false. This is an opening attestation, never a payment ledger entry.
  insert into public.ops_stay_opening_positions(booking_id,previous_id,request_key,state,reason,confirmed_by_bond,created_by,opening_period,
   owner_settlement_state,cleaner_settlement_state,owner_settled_cents,cleaner_settled_cents,owner_settled_amount_known,cleaner_settled_amount_known)
  values(booking,prior,(input->>'request_key')::uuid,opening_state,input->>'reason',bond_value,actor,period_value,
   owner_state,cleaner_state,owner_paid,cleaner_paid,owner_known,cleaner_known) returning id into result;
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

revoke all on function public.ops_finance_write(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ops_finance_write(text,jsonb) to authenticated;
commit;
