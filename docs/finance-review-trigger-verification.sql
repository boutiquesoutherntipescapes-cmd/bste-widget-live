-- READ ONLY: catalog metadata only. Does not execute a trigger or application RPC.
-- Direct NEW/OLD extraction is a lexical aid, not a PL/pgSQL parser: inspect any
-- flagged reference against the supplied source for comments/conditional branches.
with expected_functions(signature,local_hash) as (values
 ('public.ops_audit_change()','11946854650b8cd263dee4471a866587'),
 ('public.ops_no_change()','dc2204c8ea7d89b748b9668930d165ad')
), target_tables(table_name) as (values
 ('ops_stay_financial_reviews'),('ops_events'),('ops_staff')
), table_columns as (
 select tt.table_name,to_regclass('public.'||tt.table_name) as table_oid,
  coalesce(array_agg(a.attname::text order by a.attnum)
   filter(where a.attnum>0 and not a.attisdropped),'{}'::text[]) as columns
 from target_tables tt
 left join pg_attribute a on a.attrelid=to_regclass('public.'||tt.table_name)
 group by tt.table_name
), triggers as (
 select c.table_name,c.columns,t.oid,t.tgname,t.tgtype,t.tgenabled,
  t.tgfoid,p.prosrc,p.proconfig,p.prosecdef,ef.local_hash
 from table_columns c join pg_trigger t on t.tgrelid=c.table_oid
 join pg_proc p on p.oid=t.tgfoid
 left join expected_functions ef on to_regprocedure(ef.signature)=t.tgfoid
 where not t.tgisinternal
  and c.table_name in ('ops_stay_financial_reviews','ops_events')
), direct_refs as (
 select distinct t.oid,lower(m.parts[1]) as record_name,m.parts[2] as field_name
 from triggers t cross join lateral regexp_matches(
  t.prosrc,'\m(NEW|OLD)\s*\.\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?','gi'
 ) as m(parts)
), event_insert_columns as (
 -- Extract ordinary explicit ops_events INSERT target lists from installed code.
 select distinct t.oid,trim(both '"' from btrim(col.name)) as field_name
 from triggers t cross join lateral regexp_matches(t.prosrc,
  '\minsert\s+into\s+(?:public\.)?ops_events\s*\(([^)]*)\)','gi') as m(parts)
 cross join lateral regexp_split_to_table(m.parts[1],',') as col(name)
), output as (
 select 'table'::text as kind,c.table_name as name,jsonb_build_object(
  'installed',c.table_oid is not null,'current_columns',c.columns,
  'missing_expected_staff_lookup_columns',case when c.table_name='ops_staff'
    then to_jsonb(array(select x from unnest(array['user_id','display_name','role']) x where not x=any(c.columns))) else null end,
  'missing_expected_audit_target_columns',case when c.table_name='ops_events'
    then to_jsonb(array(select x from unnest(array['actor_user_id','actor_name','actor_role','action','entity_table','entity_id','booking_id','detail','system_run_id']) x where not x=any(c.columns))) else null end
 ) as diagnostic from table_columns c
 union all
 select 'trigger',t.table_name||'.'||t.tgname,jsonb_build_object(
  'definition',pg_get_triggerdef(t.oid,true),
  'fires_on_insert',(t.tgtype::integer & 4)<>0,
  'enabled',t.tgenabled,
  'function_signature',t.tgfoid::regprocedure::text,
  'function_owner',pg_get_userbyid(p.proowner),
  'security_definer',t.prosecdef,'configuration',t.proconfig,
  'installed_body_hash',md5(t.prosrc),'expected_local_hash',t.local_hash,
  'matches_local_body',case when t.local_hash is null then null else md5(t.prosrc)=t.local_hash end,
  'direct_new_old_references',coalesce((select jsonb_agg(jsonb_build_object('record',d.record_name,'field',d.field_name,'exists_on_trigger_table',d.field_name=any(t.columns))) from direct_refs d where d.oid=t.oid),'[]'::jsonb),
  'possibly_missing_direct_fields',array(select distinct d.field_name from direct_refs d where d.oid=t.oid and not d.field_name=any(t.columns)),
  'events_insert_target_columns',array(select e.field_name from event_insert_columns e where e.oid=t.oid order by e.field_name),
  'missing_events_insert_columns',array(select e.field_name from event_insert_columns e where e.oid=t.oid and not e.field_name=any((select c.columns from table_columns c where c.table_name='ops_events')::text[])),
  'uses_json_new',position('to_jsonb(new)' in lower(t.prosrc))>0,
  'uses_json_old',position('to_jsonb(old)' in lower(t.prosrc))>0,
  'installed_function_body',t.prosrc
 ) from triggers t join pg_proc p on p.oid=t.tgfoid
)
select kind,name,diagnostic from output order by kind,name;
