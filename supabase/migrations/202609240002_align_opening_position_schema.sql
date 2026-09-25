-- Additive alignment. No repair/import is executed. No applied migration is edited.
begin;
lock table public.ops_stay_opening_positions in access exclusive mode;
-- Old 'open' cannot prove zero prior payments. Never manufacture opening balances.
do $$
declare missing boolean; col record;
begin
 select count(*)<>5 into missing from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass
 and not attisdropped and attname in ('opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents');
 if missing and exists(select 1 from public.ops_stay_opening_positions) then
  raise exception 'Non-empty legacy opening table: explicit reviewed per-row mapping required; no defaults/backfill applied';
 end if;
 -- Refuse unexpected types instead of coercing financial history.
 for col in select * from (values ('opening_period','boolean'),('owner_settlement_state','text'),('cleaner_settlement_state','text'),
 ('owner_settled_cents','bigint'),('cleaner_settled_cents','bigint')) v(name,typ) loop
  if exists(select 1 from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass and attname=col.name and not attisdropped
   and atttypid<>to_regtype(col.typ)) then raise exception 'Opening column type mismatch: %',col.name; end if;
 end loop;
end $$;
alter table public.ops_stay_opening_positions
 add column if not exists opening_period boolean not null default true,
 add column if not exists owner_settlement_state text not null default 'outstanding',
 add column if not exists cleaner_settlement_state text not null default 'outstanding',
 add column if not exists owner_settled_cents bigint not null default 0,
 add column if not exists cleaner_settled_cents bigint not null default 0;
-- Existing NULLs fail validation; no historical values are overwritten.
alter table public.ops_stay_opening_positions
 alter column opening_period set not null, alter column opening_period set default true,
 alter column owner_settlement_state set not null, alter column owner_settlement_state set default 'outstanding',
 alter column cleaner_settlement_state set not null, alter column cleaner_settlement_state set default 'outstanding',
 alter column owner_settled_cents set not null, alter column owner_settled_cents set default 0,
 alter column cleaner_settled_cents set not null, alter column cleaner_settled_cents set default 0;
-- Named checks are repeatable. On a fresh schema they supplement compatible
-- unnamed checks; no existing constraint is removed or weakened.
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_owner_state') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_owner_state check (owner_settlement_state in ('outstanding','partially_settled','fully_settled'));
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_owner_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_cleaner_state') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_cleaner_state check (cleaner_settlement_state in ('outstanding','partially_settled','fully_settled'));
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_cleaner_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_owner_amount') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_owner_amount check (owner_settled_cents between 0 and 1000000000);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_owner_amount;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_cleaner_amount') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_cleaner_amount check (cleaner_settled_cents between 0 and 1000000000);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_cleaner_amount;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_state_agreement') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_state_agreement check ((state='fully_settled_historical')=(owner_settlement_state='fully_settled' and cleaner_settlement_state='fully_settled'));
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_state_agreement;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_owner_outstanding') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_owner_outstanding check (owner_settlement_state<>'outstanding' or owner_settled_cents=0);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_owner_outstanding;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_cleaner_outstanding') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_cleaner_outstanding check (cleaner_settlement_state<>'outstanding' or cleaner_settled_cents=0);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_cleaner_outstanding;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_owner_partial') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_owner_partial check (owner_settlement_state<>'partially_settled' or owner_settled_cents>0);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_owner_partial;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_cleaner_partial') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_cleaner_partial check (cleaner_settlement_state<>'partially_settled' or cleaner_settled_cents>0);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_cleaner_partial;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_attestation') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_attestation check ((owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding') or confirmed_by_bond);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_attestation;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_state') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_state check (state in ('fully_settled_historical','open'));
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_reason') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_reason check (length(trim(reason)) between 1 and 2000);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_reason;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and conname='ops_opening_align_cutoff') then
  alter table public.ops_stay_opening_positions add constraint ops_opening_align_cutoff check (cutoff='2026-09-23'::date);
 end if;
 alter table public.ops_stay_opening_positions validate constraint ops_opening_align_cutoff;
end $$;
-- Restore baseline identity/revision protections only if equivalent ones are absent.
do $$ declare col text; keynum smallint; target regclass; targetcol smallint; cname text;
begin
 foreach col in array array['id','request_key','previous_id'] loop
  select attnum into keynum from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass and attname=col and not attisdropped;
  if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and contype in ('p','u') and conkey=array[keynum]) then
   cname:='ops_opening_align_'||col||'_unique';
   if col='id' then
    execute format('alter table public.ops_stay_opening_positions add constraint %I primary key (%I)',cname,col);
   else
    execute format('alter table public.ops_stay_opening_positions add constraint %I unique (%I)',cname,col);
   end if;
  end if;
 end loop;
 foreach col in array array['booking_id','previous_id','created_by'] loop
  target:=case col when 'booking_id' then 'public.ops_bookings'::regclass when 'previous_id' then 'public.ops_stay_opening_positions'::regclass else 'public.ops_staff'::regclass end;
  select attnum into keynum from pg_attribute where attrelid='public.ops_stay_opening_positions'::regclass and attname=col and not attisdropped;
  select attnum into targetcol from pg_attribute where attrelid=target and attname=case when col='created_by' then 'user_id' else 'id' end and not attisdropped;
  if not exists(select 1 from pg_constraint where conrelid='public.ops_stay_opening_positions'::regclass and contype='f' and conkey=array[keynum] and confrelid=target and confkey=array[targetcol] and convalidated) then
   cname:='ops_opening_align_'||col||'_fk';
   execute format('alter table public.ops_stay_opening_positions add constraint %I foreign key (%I) references %s (%I)',cname,col,target,case when col='created_by' then 'user_id' else 'id' end);
  end if;
 end loop;
end $$;
-- Security is preserved, not guessed. Unexpected policy/grant/trigger drift stops
-- the whole transaction for a separate review. No GRANT, policy or trigger changes.
do $$ begin
 if not (select relrowsecurity from pg_class where oid='public.ops_stay_opening_positions'::regclass)
 or (select count(*) from pg_policy where polrelid='public.ops_stay_opening_positions'::regclass)<>1
 or not exists(select 1 from pg_policy where polrelid='public.ops_stay_opening_positions'::regclass
  and polname='finance_read' and polcmd='r' and polroles=array['authenticated'::regrole::oid]
  and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g') in ('ops_can''finance.read''::text','public.ops_can''finance.read''::text')) then
  raise exception 'Opening RLS/policy drift: review separately; alignment rolled back'; end if;
 if has_table_privilege('anon','public.ops_stay_opening_positions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 or has_table_privilege('service_role','public.ops_stay_opening_positions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 or not has_table_privilege('authenticated','public.ops_stay_opening_positions','SELECT')
 or has_table_privilege('authenticated','public.ops_stay_opening_positions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
  raise exception 'Opening privilege drift: review separately; alignment rolled back'; end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.ops_stay_opening_positions'::regclass and tgname='immutable'
  and tgfoid='public.ops_no_change()'::regprocedure and tgenabled in ('O','A') and tgtype=27)
 or not exists(select 1 from pg_trigger where tgrelid='public.ops_stay_opening_positions'::regclass and tgname='audit_change'
  and tgfoid='public.ops_audit_change()'::regprocedure and tgenabled in ('O','A') and tgtype=5) then
  raise exception 'Opening audit/immutability trigger drift: review separately; alignment rolled back'; end if;
end $$;
commit;
