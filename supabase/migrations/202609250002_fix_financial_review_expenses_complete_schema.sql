-- Additive correction for confirmed staging schema drift. No finance DML or RPCs.
-- Canonical definition: 202609230001_stay_finances.sql.
-- Any other column/default/nullability drift stops this transaction for review.
begin;
set local lock_timeout='5s';
lock table public.ops_stay_financial_reviews in access exclusive mode;
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
 where a.attrelid=to_regclass('public.ops_stay_financial_reviews') and a.attnum>0 and not a.attisdropped
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
 if not exists(select 1 from pg_class where oid='public.ops_stay_financial_reviews'::regclass and relrowsecurity) then
  raise exception 'Financial review RLS is not enabled; no changes applied';
 end if;
end $preflight$;
alter table public.ops_stay_financial_reviews
 add column if not exists expenses_complete boolean not null default false;
-- Existing rows gain the conservative canonical false; no UPDATE or history rewrite.
-- A present incompatible column is rejected above, never silently repaired.
do $verify$
begin
 if not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid='public.ops_stay_financial_reviews'::regclass and a.attname='expenses_complete'
  and a.atttypid='boolean'::regtype and a.attnotnull and not a.attisdropped
  and pg_get_expr(d.adbin,d.adrelid)='false') then
  raise exception 'expenses_complete postcondition failed';
 end if;
end $verify$;
commit;
