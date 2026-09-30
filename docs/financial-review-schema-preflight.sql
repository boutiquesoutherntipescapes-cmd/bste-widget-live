-- READ ONLY. Complete review column comparison plus current constraints/RLS.
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
select * from comparison order by column_name;
-- Catalog-only constraint/policy inspection. No application function is executed.
select conname,contype,convalidated,pg_get_constraintdef(oid) as definition
from pg_constraint where conrelid=to_regclass('public.ops_stay_financial_reviews') order by conname;
select relrowsecurity as rls_enabled,relforcerowsecurity as force_rls
from pg_class where oid=to_regclass('public.ops_stay_financial_reviews');
select policyname,roles,cmd,qual,with_check from pg_policies
where schemaname='public' and tablename='ops_stay_financial_reviews' order by policyname;
