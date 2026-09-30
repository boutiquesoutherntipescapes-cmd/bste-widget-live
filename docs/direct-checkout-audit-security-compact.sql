-- READ ONLY. ONE statement / ONE result table (16 rows).
-- Metadata only: no guest rows, provider calls, trigger execution or writes.
-- postgres privileges are expected; application roles must have no write/execute path.
-- SELECT reports ACL capability, not RLS row visibility. Authenticated reads still require finance/MFA.
with expected_tables(tab) as (values
 ('direct_checkouts'),('payment_attempts'),('payment_events'),('checkout_actions')),
expected_roles(role_name) as (values ('anon'),('authenticated'),('service_role'),('postgres')),
audit_function as (
 select p.oid,p.proowner,p.prosecdef,p.proconfig,
  pg_get_userbyid(p.proowner) as owner,
  md5(p.prosrc)='0ae002026745b883705e735ac480b2ed' as body_matches_local,
  exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from (select 1) seed left join pg_proc p on p.oid=to_regprocedure('public.direct_payment_audit()')
), audit_bindings as (
 select t.* from pg_trigger t where not t.tgisinternal
  and t.tgfoid=to_regprocedure('public.direct_payment_audit()')
), inspected as (
 select e.tab,er.role_name,r.oid as role_oid,c.oid as table_oid,
  pg_get_userbyid(c.relowner) as table_owner,c.relrowsecurity as rls_enabled,
  f.owner as function_owner,f.prosecdef as security_definer,
  (select x from unnest(f.proconfig) x where x like 'search_path=%' limit 1) as search_path,
  f.oid is not null and f.owner='postgres' and f.prosecdef and f.body_matches_local
   and (f.proconfig=array['search_path=""']::text[] or f.proconfig=array['search_path=']::text[])
   and not f.public_execute as function_safe,
  f.body_matches_local,f.public_execute,
  has_function_privilege(r.oid,f.oid,'EXECUTE') as can_execute,
  pg_has_role(r.oid,f.proowner,'MEMBER') as member_of_function_owner,
  t.tgname as trigger_name,t.tgenabled as trigger_enabled,
  t.tgfoid::regprocedure::text as trigger_function,
  t.oid is not null and t.tgname='direct_payment_audit' and t.tgenabled='O'
   and t.tgtype=21 and t.tgqual is null as trigger_safe,
  (has_table_privilege(r.oid,c.oid,'SELECT') or has_any_column_privilege(r.oid,c.oid,'SELECT')) as can_select,
  (has_table_privilege(r.oid,c.oid,'INSERT') or has_any_column_privilege(r.oid,c.oid,'INSERT')) as can_insert,
  (has_table_privilege(r.oid,c.oid,'UPDATE') or has_any_column_privilege(r.oid,c.oid,'UPDATE')) as can_update,
  has_table_privilege(r.oid,c.oid,'DELETE') as can_delete,
  has_table_privilege(r.oid,c.oid,'TRUNCATE') as can_truncate,
  has_table_privilege(r.oid,c.oid,'TRIGGER') as can_create_trigger
 from expected_tables e cross join expected_roles er cross join audit_function f
 left join pg_roles r on r.rolname=er.role_name
 left join pg_class c on c.oid=to_regclass('public.'||e.tab)
 left join audit_bindings t on t.tgrelid=c.oid
), assessed as (
 select i.*,coalesce(function_safe and trigger_safe and table_oid is not null and role_oid is not null
  and table_owner='postgres' and rls_enabled
  and case when role_name='postgres' then can_execute
   else not can_execute and not member_of_function_owner
    and not can_insert and not can_update and not can_delete and not can_truncate and not can_create_trigger
    and can_select=(role_name='authenticated') end,false) as row_safe
 from inspected i
), summary as (
 select count(*)=16 and bool_and(row_safe) and (select count(*) from audit_bindings)=4 as safe
 from assessed
)
select case when summary.safe then 'SAFE' else 'REVIEW REQUIRED' end as summary_verdict,
 case when a.row_safe then 'SAFE' else 'REVIEW REQUIRED' end as row_verdict,
 'public.direct_payment_audit()' as function_signature,
 a.function_owner,a.security_definer,a.search_path,a.body_matches_local,
 a.role_name,a.can_execute,a.public_execute,a.member_of_function_owner,
 a.tab as table_name,a.table_owner,a.rls_enabled,
 a.trigger_name,a.trigger_enabled,a.trigger_function,
 a.can_select,a.can_insert,a.can_update,a.can_delete,a.can_truncate,a.can_create_trigger,
 (select count(*) from audit_bindings) as total_audit_bindings
from assessed a cross join summary order by a.tab,a.role_name;
