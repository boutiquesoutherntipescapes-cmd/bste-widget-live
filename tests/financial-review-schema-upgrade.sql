-- Isolated staging rollback test ONLY. Temporary tables; no real financial row changes.
begin;
create temp table review_schema_fixture (

 id uuid primary key default gen_random_uuid(),booking_id uuid not null,
 previous_id uuid unique,
 request_key uuid not null unique, status text not null check(status in ('draft','reviewed')),
 accommodation_cents bigint not null check(accommodation_cents between 0 and 1000000000),
 cleaning_charge_cents bigint not null default 100000 check(cleaning_charge_cents between 0 and 1000000000),
 channel_fees_cents bigint not null check(channel_fees_cents between 0 and 1000000000),
 cleaner_cost_cents bigint not null default 80000 check(cleaner_cost_cents between 0 and 1000000000),
 cleaner_supplier text not null check(length(trim(cleaner_supplier)) between 1 and 200),
 -- Explicit cumulative evidence-backed assessment, not a sum of payment review labels.
 funds_received_cents bigint not null check(funds_received_cents between 0 and 1000000000),
 funds_evidence text, funds_as_of date not null,
 reason text not null check(length(trim(reason)) between 1 and 2000),currency text not null default 'ZAR' check(currency='ZAR'),
 source_basis jsonb not null,rate_nights jsonb not null,checkout_month date not null,
 created_by uuid not null,created_at timestamptz not null default clock_timestamp(),
 check(funds_received_cents=0 or length(trim(funds_evidence))>0 and funds_evidence is not null)
);
alter table pg_temp.review_schema_fixture enable row level security;
insert into pg_temp.review_schema_fixture(booking_id,request_key,status,accommodation_cents,channel_fees_cents,cleaner_supplier,funds_received_cents,funds_as_of,reason,source_basis,rate_nights,checkout_month,created_by)
values(gen_random_uuid(),gen_random_uuid(),'draft',5148000,938576,'Synthetic cleaner',0,'2026-09-11','Synthetic preserved history','{}','[]','2026-09-01',gen_random_uuid());
create temp table original_review_snapshot as select to_jsonb(f) as original from pg_temp.review_schema_fixture f;
create function pg_temp.apply_review_schema_fixture() returns void language plpgsql as $runner$
begin execute $alignment$
set local lock_timeout='5s';
lock table pg_temp.review_schema_fixture in access exclusive mode;
do $preflight$
declare mismatches text;
begin
with expected(column_name,type_name,required,default_expression) as (values
('id','uuid',true,'gen_random_uuid()'),
 ('booking_id','uuid',true,null),
 ('previous_id','uuid',false,null),
 ('request_key','uuid',true,null),
 ('status','text',true,null),
 ('accommodation_cents','bigint',true,null),
 ('cleaning_charge_cents','bigint',true,'100000'),
 ('channel_fees_cents','bigint',true,null),
 ('cleaner_cost_cents','bigint',true,'80000'),
 ('cleaner_supplier','text',true,null),
 ('funds_received_cents','bigint',true,null),
 ('funds_evidence','text',false,null),
 ('funds_as_of','date',true,null),
 ('expenses_complete','boolean',true,'false'),
 ('reason','text',true,null),
 ('currency','text',true,'''ZAR''::text'),
 ('source_basis','jsonb',true,null),
 ('rate_nights','jsonb',true,null),
 ('checkout_month','date',true,null),
 ('created_by','uuid',true,null),
 ('created_at','timestamp with time zone',true,'clock_timestamp()')
), actual as (
 select a.attname::text as column_name,format_type(a.atttypid,a.atttypmod) as type_name,
  a.attnotnull as required,pg_get_expr(d.adbin,d.adrelid) as default_expression,
  a.attgenerated,a.attidentity
 from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 where a.attrelid=to_regclass('pg_temp.review_schema_fixture') and a.attnum>0 and not a.attisdropped
), comparison as (
 select coalesce(e.column_name,a.column_name) as column_name,
  e.type_name as expected_type,a.type_name as actual_type,
  e.required as expected_not_null,a.required as actual_not_null,
  e.default_expression as expected_default,a.default_expression as actual_default,
  case when e.column_name is null then 'unexpected_column'
   when a.column_name is null then 'missing'
   when e.type_name is distinct from a.type_name then 'type_mismatch'
   when e.required is distinct from a.required then 'nullability_mismatch'
   when e.default_expression is distinct from a.default_expression then 'default_mismatch'
   when a.attgenerated<>'' or a.attidentity<>'' then 'unexpected_generated_column'
   else 'matches' end as result
 from expected e full join actual a using(column_name)
)
 select string_agg(column_name||':'||result,', ' order by column_name) into mismatches
 from comparison where result<>'matches' and not(column_name='expenses_complete' and result='missing');
 if mismatches is not null then raise exception 'Additional financial review schema drift; no changes applied: %',mismatches; end if;
 if not exists(select 1 from pg_class where oid='pg_temp.review_schema_fixture'::regclass and relrowsecurity) then
  raise exception 'Financial review RLS is not enabled; no changes applied';
 end if;
end $preflight$;
alter table pg_temp.review_schema_fixture
 add column if not exists expenses_complete boolean not null default false;
-- Existing rows gain the conservative canonical false; no UPDATE or history rewrite.
-- A present incompatible column is rejected above, never silently repaired.
do $verify$
begin
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='pg_temp.review_schema_fixture'::regclass and a.attname='expenses_complete'
  and a.atttypid='boolean'::regtype and a.attnotnull and not a.attisdropped
  and pg_get_expr(d.adbin,d.adrelid)='false') then
  raise exception 'expenses_complete postcondition failed';
 end if;
end $verify$;
$alignment$; end $runner$;
select pg_temp.apply_review_schema_fixture();
select pg_temp.apply_review_schema_fixture();
do $assert$
begin
 if (select count(*) from pg_temp.review_schema_fixture)<>1
  or exists(select 1 from pg_temp.review_schema_fixture where expenses_complete is distinct from false)
  or not exists(select 1 from pg_temp.review_schema_fixture f cross join pg_temp.original_review_snapshot s where to_jsonb(f)-'expenses_complete'=s.original) then
  raise exception 'Alignment changed historical data or failed canonical default'; end if;
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='pg_temp.review_schema_fixture'::regclass and a.attname='expenses_complete'
  and a.atttypid='boolean'::regtype and a.attnotnull and pg_get_expr(d.adbin,d.adrelid)='false') then
  raise exception 'Canonical column definition not installed'; end if;
end $assert$;
-- Existing incompatible column must be refused rather than silently changed.
alter table pg_temp.review_schema_fixture alter column expenses_complete set default true;
do $reject$
begin
 begin
  perform pg_temp.apply_review_schema_fixture();
 exception when others then
  if sqlerrm not like 'Additional financial review schema drift%' then raise; end if;
  return;
 end;
 raise exception 'Incompatible default was not rejected';
end $reject$;
rollback;
