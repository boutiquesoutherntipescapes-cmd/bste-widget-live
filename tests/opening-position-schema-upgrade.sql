-- Run in isolated staging after alignment. Temporary tables only; no real stay is changed.
-- The embedded migration body is checked against the real migration by Node tests.
begin;
-- PostgreSQL requires TEMP foreign keys to reference TEMP relations. Only the
-- three table identities are remapped; Node checks the remaining migration body
-- byte-for-byte. No data is copied from permanent booking or staff tables.
create temporary table ops_alignment_bookings (id uuid primary key);
create temporary table ops_alignment_staff (user_id uuid primary key);
-- Policies/grants on TEMP tables are supported. Permanent policy/trigger FUNCTIONS
-- can be referenced; they are not permanent FK relations. Security is inspected
-- structurally here, not presented as a real-role RLS execution test.
-- Seed legacy rows BEFORE installing triggers; no DML fires the real audit function.
create function pg_temp.alignment_ok(v boolean,label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception '%',label; end if; end $$;
create function pg_temp.align_fixture() returns void language plpgsql as $runner$
begin execute $alignment$
lock table pg_temp.ops_opening_alignment_fixture in access exclusive mode;
-- Old 'open' cannot prove zero prior payments. Never manufacture opening balances.
do $$
declare missing boolean; col record;
begin
 select count(*)<>5 into missing from pg_attribute where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass
 and not attisdropped and attname in ('opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents');
 if missing and exists(select 1 from pg_temp.ops_opening_alignment_fixture) then
  raise exception 'Non-empty legacy opening table: explicit reviewed per-row mapping required; no defaults/backfill applied';
 end if;
 -- Refuse unexpected types instead of coercing financial history.
 for col in select * from (values ('opening_period','boolean'),('owner_settlement_state','text'),('cleaner_settlement_state','text'),
 ('owner_settled_cents','bigint'),('cleaner_settled_cents','bigint')) v(name,typ) loop
  if exists(select 1 from pg_attribute where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and attname=col.name and not attisdropped
   and atttypid<>to_regtype(col.typ)) then raise exception 'Opening column type mismatch: %',col.name; end if;
 end loop;
end $$;
alter table pg_temp.ops_opening_alignment_fixture
 add column if not exists opening_period boolean not null default true,
 add column if not exists owner_settlement_state text not null default 'outstanding',
 add column if not exists cleaner_settlement_state text not null default 'outstanding',
 add column if not exists owner_settled_cents bigint not null default 0,
 add column if not exists cleaner_settled_cents bigint not null default 0;
-- Existing NULLs fail validation; no historical values are overwritten.
alter table pg_temp.ops_opening_alignment_fixture
 alter column opening_period set not null, alter column opening_period set default true,
 alter column owner_settlement_state set not null, alter column owner_settlement_state set default 'outstanding',
 alter column cleaner_settlement_state set not null, alter column cleaner_settlement_state set default 'outstanding',
 alter column owner_settled_cents set not null, alter column owner_settled_cents set default 0,
 alter column cleaner_settled_cents set not null, alter column cleaner_settled_cents set default 0;
-- Named checks are repeatable. On a fresh schema they supplement compatible
-- unnamed checks; no existing constraint is removed or weakened.
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_owner_state') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_owner_state check (owner_settlement_state in ('outstanding','partially_settled','fully_settled'));
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_owner_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_cleaner_state') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_cleaner_state check (cleaner_settlement_state in ('outstanding','partially_settled','fully_settled'));
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_cleaner_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_owner_amount') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_owner_amount check (owner_settled_cents between 0 and 1000000000);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_owner_amount;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_cleaner_amount') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_cleaner_amount check (cleaner_settled_cents between 0 and 1000000000);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_cleaner_amount;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_state_agreement') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_state_agreement check ((state='fully_settled_historical')=(owner_settlement_state='fully_settled' and cleaner_settlement_state='fully_settled'));
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_state_agreement;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_owner_outstanding') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_owner_outstanding check (owner_settlement_state<>'outstanding' or owner_settled_cents=0);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_owner_outstanding;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_cleaner_outstanding') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_cleaner_outstanding check (cleaner_settlement_state<>'outstanding' or cleaner_settled_cents=0);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_cleaner_outstanding;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_owner_partial') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_owner_partial check (owner_settlement_state<>'partially_settled' or owner_settled_cents>0);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_owner_partial;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_cleaner_partial') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_cleaner_partial check (cleaner_settlement_state<>'partially_settled' or cleaner_settled_cents>0);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_cleaner_partial;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_attestation') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_attestation check ((owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding') or confirmed_by_bond);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_attestation;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_state') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_state check (state in ('fully_settled_historical','open'));
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_state;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_reason') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_reason check (length(trim(reason)) between 1 and 2000);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_reason;
end $$;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname='ops_opening_align_cutoff') then
  alter table pg_temp.ops_opening_alignment_fixture add constraint ops_opening_align_cutoff check (cutoff='2026-09-23'::date);
 end if;
 alter table pg_temp.ops_opening_alignment_fixture validate constraint ops_opening_align_cutoff;
end $$;
-- Restore baseline identity/revision protections only if equivalent ones are absent.
do $$ declare col text; keynum smallint; target regclass; targetcol smallint; cname text;
begin
 foreach col in array array['id','request_key','previous_id'] loop
  select attnum into keynum from pg_attribute where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and attname=col and not attisdropped;
  if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and contype in ('p','u') and conkey=array[keynum]) then
   cname:='ops_opening_align_'||col||'_unique';
   if col='id' then
    execute format('alter table pg_temp.ops_opening_alignment_fixture add constraint %I primary key (%I)',cname,col);
   else
    execute format('alter table pg_temp.ops_opening_alignment_fixture add constraint %I unique (%I)',cname,col);
   end if;
  end if;
 end loop;
 foreach col in array array['booking_id','previous_id','created_by'] loop
  target:=case col when 'booking_id' then 'pg_temp.ops_alignment_bookings'::regclass when 'previous_id' then 'pg_temp.ops_opening_alignment_fixture'::regclass else 'pg_temp.ops_alignment_staff'::regclass end;
  select attnum into keynum from pg_attribute where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and attname=col and not attisdropped;
  select attnum into targetcol from pg_attribute where attrelid=target and attname=case when col='created_by' then 'user_id' else 'id' end and not attisdropped;
  if not exists(select 1 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and contype='f' and conkey=array[keynum] and confrelid=target and confkey=array[targetcol] and convalidated) then
   cname:='ops_opening_align_'||col||'_fk';
   execute format('alter table pg_temp.ops_opening_alignment_fixture add constraint %I foreign key (%I) references %s (%I)',cname,col,target,case when col='created_by' then 'user_id' else 'id' end);
  end if;
 end loop;
end $$;
-- Security is preserved, not guessed. Unexpected policy/grant/trigger drift stops
-- the whole transaction for a separate review. No GRANT, policy or trigger changes.
do $$ begin
 if not (select relrowsecurity from pg_class where oid='pg_temp.ops_opening_alignment_fixture'::regclass)
 or (select count(*) from pg_policy where polrelid='pg_temp.ops_opening_alignment_fixture'::regclass)<>1
 or not exists(select 1 from pg_policy where polrelid='pg_temp.ops_opening_alignment_fixture'::regclass
  and polname='finance_read' and polcmd='r' and polroles=array['authenticated'::regrole::oid]
  and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g') in ('ops_can''finance.read''::text','public.ops_can''finance.read''::text')) then
  raise exception 'Opening RLS/policy drift: review separately; alignment rolled back'; end if;
 if has_table_privilege('anon','pg_temp.ops_opening_alignment_fixture','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 or has_table_privilege('service_role','pg_temp.ops_opening_alignment_fixture','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 or not has_table_privilege('authenticated','pg_temp.ops_opening_alignment_fixture','SELECT')
 or has_table_privilege('authenticated','pg_temp.ops_opening_alignment_fixture','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
  raise exception 'Opening privilege drift: review separately; alignment rolled back'; end if;
 if not exists(select 1 from pg_trigger where tgrelid='pg_temp.ops_opening_alignment_fixture'::regclass and tgname='immutable'
  and tgfoid='public.ops_no_change()'::regprocedure and tgenabled in ('O','A') and tgtype=27)
 or not exists(select 1 from pg_trigger where tgrelid='pg_temp.ops_opening_alignment_fixture'::regclass and tgname='audit_change'
  and tgfoid='public.ops_audit_change()'::regprocedure and tgenabled in ('O','A') and tgtype=5) then
  raise exception 'Opening audit/immutability trigger drift: review separately; alignment rolled back'; end if;
end $$;
$alignment$; end $runner$;
create function pg_temp.fixture_security() returns void language plpgsql as $$
begin
 alter table pg_temp.ops_opening_alignment_fixture enable row level security;
 revoke all on pg_temp.ops_opening_alignment_fixture from public,anon,authenticated,service_role;
 grant select on pg_temp.ops_opening_alignment_fixture to authenticated;
 create policy finance_read on pg_temp.ops_opening_alignment_fixture for select to authenticated using(public.ops_can('finance.read'));
 create trigger immutable before update or delete on pg_temp.ops_opening_alignment_fixture for each row execute function public.ops_no_change();
 create trigger audit_change after insert on pg_temp.ops_opening_alignment_fixture for each row execute function public.ops_audit_change();
end $$;
-- Legacy EMPTY schema: exact supplied columns, including no assumptions about indexes.
create temporary table ops_opening_alignment_fixture (
 id uuid not null default gen_random_uuid(),booking_id uuid not null,previous_id uuid,
 request_key uuid not null,state text not null,reason text not null,confirmed_by_bond boolean not null,
 cutoff date not null default '2026-09-23',created_by uuid not null,created_at timestamptz not null default clock_timestamp());
select pg_temp.fixture_security();
select pg_temp.align_fixture();
select pg_temp.align_fixture(); -- rerun
select pg_temp.alignment_ok((select count(*)=5 and bool_and(attnotnull) from pg_attribute
 where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and not attisdropped
 and attname in ('opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents')),'Missing aligned fields');
select pg_temp.alignment_ok((select count(*)=13 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and conname like 'ops_opening_align_%' and contype='c'),'Missing settlement constraints');
select pg_temp.alignment_ok((select count(*)=3 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and contype='f'),'Missing foreign keys');
select pg_temp.alignment_ok((select count(*)=3 and bool_and(c.convalidated and parent.relpersistence='t')
 from pg_constraint c join pg_class parent on parent.oid=c.confrelid
 where c.conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and c.contype='f'),'Foreign keys escape temporary fixtures');
select pg_temp.alignment_ok(not exists(
 select 1 from (values ('booking_id','pg_temp.ops_alignment_bookings'::regclass,'id'),
 ('previous_id','pg_temp.ops_opening_alignment_fixture'::regclass,'id'),
 ('created_by','pg_temp.ops_alignment_staff'::regclass,'user_id')) v(child_name,parent_table,parent_name)
 where not exists(select 1 from pg_constraint c
 join pg_attribute child on child.attrelid=c.conrelid and c.conkey=array[child.attnum]
 join pg_attribute parent on parent.attrelid=c.confrelid and c.confkey=array[parent.attnum]
 where c.conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and c.contype='f' and c.convalidated
 and child.attname=v.child_name and c.confrelid=v.parent_table and parent.attname=v.parent_name)), 'Incorrect FK column mapping');
select pg_temp.alignment_ok((select count(*)=5 and bool_and(case a.attname
 when 'opening_period' then pg_get_expr(d.adbin,d.adrelid)='true'
 when 'owner_settlement_state' then pg_get_expr(d.adbin,d.adrelid)='''outstanding''::text'
 when 'cleaner_settlement_state' then pg_get_expr(d.adbin,d.adrelid)='''outstanding''::text'
 else pg_get_expr(d.adbin,d.adrelid) in ('0','0::bigint') end)
 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where a.attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and a.attname in
 ('opening_period','owner_settlement_state','cleaner_settlement_state','owner_settled_cents','cleaner_settled_cents')), 'Incorrect opening defaults');

select pg_temp.alignment_ok((select count(*)=3 from pg_constraint where conrelid='pg_temp.ops_opening_alignment_fixture'::regclass and contype in ('p','u')),'Missing identity uniqueness');
drop table pg_temp.ops_opening_alignment_fixture;
-- Non-empty legacy schema: financial meaning is unknown, so stop with NO changes.
create temporary table ops_opening_alignment_fixture (
 id uuid not null default gen_random_uuid(),booking_id uuid not null,previous_id uuid,
 request_key uuid not null,state text not null,reason text not null,confirmed_by_bond boolean not null,
 cutoff date not null default '2026-09-23',created_by uuid not null,created_at timestamptz not null default clock_timestamp());
insert into pg_temp.ops_opening_alignment_fixture(booking_id,request_key,state,reason,confirmed_by_bond,created_by)
 values(gen_random_uuid(),gen_random_uuid(),'open','Unknown past payments',false,gen_random_uuid()),
 (gen_random_uuid(),gen_random_uuid(),'fully_settled_historical','Known marker; unknown cash amounts',true,gen_random_uuid());
select pg_temp.fixture_security();
select set_config('test.legacy_rows',(select jsonb_agg(to_jsonb(t) order by id)::text from pg_temp.ops_opening_alignment_fixture t),true);
do $$ begin
 begin perform pg_temp.align_fixture();raise exception 'Expected legacy refusal';
 exception when others then if sqlerrm not like 'Non-empty legacy opening table:%' then raise; end if;end;
end $$;
select pg_temp.alignment_ok((select jsonb_agg(to_jsonb(t) order by id) from pg_temp.ops_opening_alignment_fixture t)=current_setting('test.legacy_rows')::jsonb,'Legacy rows changed');
select pg_temp.alignment_ok(not exists(select 1 from pg_attribute where attrelid='pg_temp.ops_opening_alignment_fixture'::regclass and attname='opening_period' and not attisdropped),'Failed upgrade changed schema');
drop table pg_temp.ops_opening_alignment_fixture;
-- Fresh/current schema: exact original local 230001 definition, no real rows.
create temporary table ops_opening_alignment_fixture (
 id uuid primary key default gen_random_uuid(),booking_id uuid not null references pg_temp.ops_alignment_bookings,
 previous_id uuid unique references pg_temp.ops_opening_alignment_fixture, request_key uuid not null unique,
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
 created_by uuid not null references pg_temp.ops_alignment_staff(user_id),created_at timestamptz not null default clock_timestamp(),
 check((owner_settlement_state='outstanding' and cleaner_settlement_state='outstanding') or confirmed_by_bond)
);
select pg_temp.fixture_security();
select pg_temp.align_fixture();
select pg_temp.align_fixture();
select pg_temp.alignment_ok((select relrowsecurity from pg_class where oid='pg_temp.ops_opening_alignment_fixture'::regclass),'RLS disabled');
select pg_temp.alignment_ok(not has_table_privilege('anon','pg_temp.ops_opening_alignment_fixture','SELECT'),'Anonymous financial access');
select pg_temp.alignment_ok(not has_table_privilege('authenticated','pg_temp.ops_opening_alignment_fixture','INSERT,UPDATE,DELETE'),'Direct financial writes');
-- Security drift is rejected instead of silently replacing policies.
create policy test_bad_read on pg_temp.ops_opening_alignment_fixture for select to anon using(true);
do $$ begin
 begin perform pg_temp.align_fixture();raise exception 'Expected security refusal';
 exception when others then if sqlerrm not like 'Opening RLS/policy drift:%' then raise; end if;end;
end $$;
rollback;
