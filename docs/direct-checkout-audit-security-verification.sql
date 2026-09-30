-- READ ONLY: catalog/privilege inspection only; no trigger/RPC execution.
-- Run COMPLETE file in BSTE Operations Staging. No guest/session/secret data.
-- Four compact result sets. Unexpected/missing items require review, not changes.

-- 1. Function ownership, configuration and effective EXECUTE (includes inherited/PUBLIC grants).
with expected(sig,expected_definer) as (values
 ('public.direct_payment_audit()',true),('public.direct_checkout_guard()',false),
 ('public.payment_event_guard()',false),('public.checkout_work_guard()',false))
select e.sig as function_signature,p.oid is not null as installed,
 pg_get_userbyid(p.proowner) as function_owner,p.prosecdef as security_definer,
 p.prosecdef=e.expected_definer as definer_matches,
 (select x from unnest(p.proconfig) x where x like 'search_path=%') as configured_search_path,
 p.proconfig as all_function_settings,
 p.proowner='postgres'::regrole as expected_staging_owner,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute,
 (pg_has_role('anon',p.proowner,'MEMBER') or pg_has_role('authenticated',p.proowner,'MEMBER') or pg_has_role('service_role',p.proowner,'MEMBER')) as app_role_member_of_owner,
 case when e.sig='public.direct_payment_audit()' then md5(p.prosrc)='0ae002026745b883705e735ac480b2ed' end as audit_body_matches_local
from expected e left join pg_proc p on p.oid=to_regprocedure(e.sig)
order by e.sig;

-- 2. Exactly four expected audit triggers; also reveals unexpected extra bindings.
with expected(tab) as (values ('direct_checkouts'),('payment_attempts'),('payment_events'),('checkout_actions')),
 bindings as (select t.*,c.relname,n.nspname,c.relowner from pg_trigger t
 join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where not t.tgisinternal and t.tgfoid=to_regprocedure('public.direct_payment_audit()'))
select coalesce(b.nspname,'public') as table_schema,coalesce(b.relname,e.tab) as trigger_table,
 b.tgname as trigger_name,b.tgenabled as enabled,
 b.tgfoid::regprocedure as trigger_function,
 pg_get_userbyid(b.relowner) as table_owner,
 b.relowner='postgres'::regrole as expected_staging_table_owner,
 e.tab is not null and b.oid is not null and b.nspname='public' and b.tgenabled='O'
  and b.tgtype=21 and b.tgqual is null as expected_after_insert_update_binding,
 pg_get_triggerdef(b.oid) as trigger_definition
from expected e full join bindings b on b.relname=e.tab and b.nspname='public'
order by trigger_table;

-- 3. The trigger cannot become an application write path via table/column privileges.
select t.tab,r.role_name,
 has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'SELECT') as select_privilege,
 (has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'INSERT') or has_any_column_privilege(r.role_name,to_regclass('public.'||t.tab),'INSERT')) as can_insert,
 (has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'UPDATE') or has_any_column_privilege(r.role_name,to_regclass('public.'||t.tab),'UPDATE')) as can_update,
 has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'DELETE') as can_delete,
 has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'TRUNCATE') as can_truncate,
 has_table_privilege(r.role_name,to_regclass('public.'||t.tab),'TRIGGER') as can_create_trigger,
 c.relrowsecurity as rls_enabled
from (values ('direct_checkouts'),('payment_attempts'),('payment_events'),('checkout_actions')) t(tab)
cross join (values ('anon'),('authenticated'),('service_role')) r(role_name)
left join pg_class c on c.oid=to_regclass('public.'||t.tab)
order by t.tab,r.role_name;

-- 4. Definer's downstream audit access and immutable-history binding.
select c.oid::regclass as dependency,pg_get_userbyid(c.relowner) as table_owner,
 pg_get_userbyid(p.proowner) as audit_function_owner,
 has_table_privilege(p.proowner,c.oid,'SELECT') as owner_can_select,
 has_table_privilege(p.proowner,c.oid,'INSERT') as owner_can_insert,
 c.relrowsecurity as rls_enabled,c.relforcerowsecurity as force_rls,
 o.rolsuper or o.rolbypassrls or (c.relowner=p.proowner and not c.relforcerowsecurity) as owner_bypasses_rls,
 case when c.relname='ops_events' then exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='immutable_history' and t.tgenabled='O' and t.tgfoid=to_regprocedure('public.ops_no_change()')) end as audit_immutability_trigger_present
from pg_class c join pg_namespace n on n.oid=c.relnamespace
left join pg_proc p on p.oid=to_regprocedure('public.direct_payment_audit()')
left join pg_roles o on o.oid=p.proowner
where n.nspname='public' and c.relname in ('ops_staff','ops_events')
order by c.relname;
