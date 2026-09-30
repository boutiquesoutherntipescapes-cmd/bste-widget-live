-- READ ONLY. Catalog metadata and fixed synthetic JSON only. No application RPC execution.
with expected(table_name,required_columns) as (values
 ('ops_bookings',array['id','property_slug','arrival','departure']::text[]),
 ('ops_owner_rate_periods',array['id','property_slug','starts_on','ends_on','supersedes_id','season','rate_cents']::text[]),
 ('ops_stay_financial_reviews',array['id','booking_id','previous_id','request_key','status','accommodation_cents','cleaning_charge_cents','channel_fees_cents','cleaner_cost_cents','cleaner_supplier','funds_received_cents','funds_evidence','funds_as_of','reason','source_basis','rate_nights','checkout_month','created_by','created_at','expenses_complete']::text[]),
 ('ops_booking_financial_snapshots',array['booking_id']::text[]),
 ('ops_finance_requests',array['request_key','actor','action_name','fingerprint']::text[]),
 ('ops_staff',array['user_id','display_name','role']::text[]),
 ('ops_events',array['actor_user_id','actor_name','actor_role','action','entity_table','entity_id','booking_id','detail','system_run_id']::text[])
), columns as (
 select e.table_name,e.required_columns,
  coalesce(array_agg(a.attname::text order by a.attnum) filter(where a.attnum>0 and not a.attisdropped),'{}'::text[]) as actual_columns
 from expected e left join pg_attribute a on a.attrelid=to_regclass('public.'||e.table_name)
 group by e.table_name,e.required_columns
), functions(signature,expected_hash) as (values
 ('public.ops_owner_nights(uuid)','d5f5e25652e91bcc1f9d8ae34b22b1d8'),
 ('public.ops_finance_write(text,jsonb)','464751f58bbd8a94554fe55131f9fcc1')
), output as (
 select 'table'::text as kind,c.table_name as name,jsonb_build_object(
  'installed',to_regclass('public.'||c.table_name) is not null,
  'actual_columns',c.actual_columns,
  'missing_referenced_columns',array(select x from unnest(c.required_columns) x where not x=any(c.actual_columns)),
  'all_referenced_columns_present',c.required_columns<@c.actual_columns,
  'triggers',coalesce((select jsonb_agg(jsonb_build_object('trigger',t.tgname,'function',t.tgfoid::regprocedure::text,'enabled',t.tgenabled)) from pg_trigger t where t.tgrelid=to_regclass('public.'||c.table_name) and not t.tgisinternal),'[]'::jsonb)
 ) as diagnostic from columns c
 union all
 select 'function',f.signature,jsonb_build_object(
  'installed',p.oid is not null,'returns',pg_get_function_result(p.oid),
  'security_definer',p.prosecdef,'body_hash',md5(p.prosrc),'expected_hash',f.expected_hash,
  'exact_local_match',coalesce(md5(p.prosrc)=f.expected_hash,false),
  'uses_old_n',coalesce(position('old.n' in p.prosrc)>0,false),
  'lateral_select_n',coalesce(position('left join lateral (select n from jsonb_array_elements' in p.prosrc)>0,false),
  'calls_nightly_helper',coalesce(position('nights:=public.ops_owner_nights(booking)' in p.prosrc)>0,false),
  'validates_default_json',coalesce(position('submitted->''default_rate_cents''' in p.prosrc)>0,false),
  'inserts_review',coalesce(position('insert into public.ops_stay_financial_reviews' in p.prosrc)>0,false)
 ) from functions f left join pg_proc p on p.oid=to_regprocedure(f.signature)
 union all
 select 'synthetic_alias','lateral old.n',jsonb_build_object(
  'derived_column_names',array(select jsonb_object_keys(to_jsonb(old))),
  'n_field_exists',to_jsonb(old) ? 'n',
  'n_is_json_object',jsonb_typeof(to_jsonb(old)->'n')='object'
 ) from lateral (select n from jsonb_array_elements('[{"night":"2000-01-01","rate_cents":1}]'::jsonb) n) old
)
select kind,name,diagnostic from output order by kind,name;
