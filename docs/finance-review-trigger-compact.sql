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
)
select t.tgname as trigger_name,
 pg_get_triggerdef(t.oid,true) as trigger_definition,
 t.tgfoid::regprocedure::text as trigger_function_signature,
 md5(t.prosrc) as trigger_function_hash,
 t.local_hash as expected_local_hash,
 coalesce(md5(t.prosrc)=t.local_hash,false) as exact_local_match,
 array(select d.record_name||'.'||d.field_name from direct_refs d where d.oid=t.oid order by 1) as direct_new_old_column_refs,
 array(select d.record_name||'.'||d.field_name from direct_refs d where d.oid=t.oid and not d.field_name=any(t.columns) order by 1) as missing_direct_column_refs,
 array(select x from unnest(array['id','booking_id','previous_id','request_key','status','accommodation_cents','cleaning_charge_cents','channel_fees_cents','cleaner_cost_cents','cleaner_supplier','funds_received_cents','funds_evidence','funds_as_of','reason','source_basis','rate_nights','checkout_month','created_by','created_at','expenses_complete']) x where not x=any(t.columns)) as review_missing_required_columns,
 array(select x from (
  select unnest(array['actor_user_id','actor_name','actor_role','action','entity_table','entity_id','booking_id','detail','system_run_id']) as x
  union select e.field_name from event_insert_columns e where e.oid=t.oid
 ) required where not x=any((select c.columns from table_columns c where c.table_name='ops_events')::text[]) order by x) as ops_events_missing_required_columns,
 array(select x from unnest(array['user_id','display_name','role']) x where not x=any((select c.columns from table_columns c where c.table_name='ops_staff')::text[])) as ops_staff_missing_required_columns
from triggers t
where t.table_name='ops_stay_financial_reviews' and t.tgname='audit_change' and (t.tgtype::integer & 4)<>0;
