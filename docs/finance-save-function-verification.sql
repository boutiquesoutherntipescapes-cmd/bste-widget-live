-- READ ONLY: metadata only, no function execution or guest/session data.
with installed as (
 select p.prosrc,p.prosecdef from pg_proc p
 where p.oid=to_regprocedure('public.ops_finance_write(text,jsonb)')
)
select exists(select 1 from installed) as installed,
 coalesce((select prosecdef from installed),false) as security_definer,
 (select md5(prosrc) from installed) as installed_body_hash,
 '464751f58bbd8a94554fe55131f9fcc1' as expected_body_hash,
 coalesce((select md5(prosrc)='464751f58bbd8a94554fe55131f9fcc1' from installed),false) as exact_local_match,
 coalesce((select md5(regexp_replace(lower(prosrc),'\s+','','g'))='f23e9e9e0ba23b36314ef8249dee740b' from installed),false) as normalized_local_match,
 coalesce((select position('nights:=public.ops_owner_nights(booking)' in prosrc)>0 from installed),false) as computes_standard_and_agreed_nights,
 coalesce((select position('input ? ''owner_nights''' in prosrc)>0 from installed),false) as validates_owner_nights_payload,
 coalesce((select position('Standard rates changed or night invalid; reload before saving' in prosrc)>0 from installed),false) as checks_stale_defaults,
 coalesce((select position('Reason required for agreed rate adjustment' in prosrc)>0 from installed),false) as requires_adjustment_reason,
 coalesce((select position('nights:=adjusted' in prosrc)>0 from installed),false) as persists_agreed_nights,
 to_regprocedure('public.ops_owner_nights(uuid)') is not null as nightly_helper_installed;
