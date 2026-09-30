-- READ ONLY: catalog metadata only; no function execution or guest data.
-- Run complete query. Any result other than UNCHANGED requires inspection, not a retry.
with checks(name,present,detail) as (
 select 'column:'||v.name,a.attname is not null,
  coalesce(format('type=%s; nullable=%s; default=%s',format_type(a.atttypid,a.atttypmod),not a.attnotnull,pg_get_expr(d.adbin,d.adrelid)),'absent')
 from (values ('source_kind'),('manual_reference'),('manual_booked_on'),('manual_note'),('manual_created_by')) v(name)
 left join pg_attribute a on a.attrelid=to_regclass('public.ops_bookings') and a.attname=v.name and not a.attisdropped
 left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
 union all
 select 'nullable:'||v.name,coalesce(not a.attnotnull,true),case when a.attname is null then 'COLUMN MISSING' else 'nullable='||(not a.attnotnull)::text end
 from (values ('beds24_booking_id'),('first_imported_at'),('last_synced_at')) v(name)
 left join pg_attribute a on a.attrelid=to_regclass('public.ops_bookings') and a.attname=v.name and not a.attisdropped
 union all
 select 'constraint:'||v.name,c.oid is not null,coalesce(pg_get_constraintdef(c.oid),'absent')
 from (values ('ops_booking_source_identity'),('ops_bookings_manual_created_by_fkey')) v(name)
 left join pg_constraint c on c.conrelid=to_regclass('public.ops_bookings') and c.conname=v.name
 union all
 select 'index:ops_manual_booking_reference',to_regclass('public.ops_manual_booking_reference') is not null,coalesce(pg_get_indexdef(to_regclass('public.ops_manual_booking_reference')),'absent')
 union all
 select 'trigger:guard_manual_source',t.oid is not null,coalesce(pg_get_triggerdef(t.oid),'absent')
 from (select 1) x left join pg_trigger t on t.tgrelid=to_regclass('public.ops_bookings') and t.tgname='guard_manual_source'
 union all
 select 'function:'||v.sig,p.oid is not null,coalesce('installed; definer='||p.prosecdef::text,'absent')
 from (values ('public.ops_guard_manual_source()'),('public.ops_create_charl_historical_direct(uuid[],boolean)')) v(sig)
 left join pg_proc p on p.oid=to_regprocedure(v.sig)
 union all
 select 'replaced:'||v.sig,p.oid is null or md5(p.prosrc)<>v.expected_hash,
 coalesce('body_hash='||md5(p.prosrc)||'; original_match='||(md5(p.prosrc)=v.expected_hash)::text,'FUNCTION MISSING')
 from (values ('public.ops_sync_booking(jsonb,jsonb,uuid)','d26ccd60f8f14bc113c73e84faea1836'),('public.ops_dashboard_rows(text)','28562577ed991f47fe51d6ff2d60b540')) v(sig,expected_hash)
 left join pg_proc p on p.oid=to_regprocedure(v.sig)
), output(section,name,present,detail) as (
 select '0 SUMMARY','migration_state',bool_or(present),case when bool_or(present) then 'MODIFIED / PARTIAL OR INSTALLED: do not rerun; inspect rows below' else 'UNCHANGED: no 202609260001 artifacts; original function hashes and NOT NULL flags match' end from checks
 union all select '1 ARTIFACT',name,present,detail from checks
 union all
 select '2 SECURITY','ops_bookings RLS',relrowsecurity,'force_rls='||relforcerowsecurity::text from pg_class where oid=to_regclass('public.ops_bookings')
 union all
 select '2 SECURITY','policy:'||polname,true,pg_get_expr(polqual,polrelid)||coalesce('; check='||pg_get_expr(polwithcheck,polrelid),'') from pg_policy where polrelid=to_regclass('public.ops_bookings')
 union all
 select '2 SECURITY','grant:'||v.sig||':'||r.rolname,
 has_function_privilege(r.oid,p.oid,'EXECUTE'),'effective EXECUTE privilege (includes PUBLIC grants)'
 from (values ('public.ops_create_charl_historical_direct(uuid[],boolean)'),('public.ops_guard_manual_source()'),('public.ops_sync_booking(jsonb,jsonb,uuid)'),('public.ops_dashboard_rows(text)')) v(sig)
 join pg_proc p on p.oid=to_regprocedure(v.sig)
 cross join pg_roles r where r.rolname in ('anon','authenticated','service_role')
 union all
 select '2 SECURITY','table_grant:'||grantee||':'||privilege_type,true,'ops_bookings' from information_schema.table_privileges where table_schema='public' and table_name='ops_bookings'
)
select section,name,present,detail from output order by section,name;
