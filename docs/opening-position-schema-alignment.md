# Opening-position schema alignment

Local only: `202609240002_align_opening_position_schema.sql` is not applied.
230001, 230002 and 240001 are left unchanged. Staging reportedly has 17 bookings,
1 historical batch, 1 historical result and zero opening positions. The installed
corrective apply function references columns absent from the supplied live table.

## Complete opening-table difference

Five columns are missing:

| Column | Type | New-row default |
|---|---|---|
| opening_period | boolean NOT NULL | true |
| owner_settlement_state | text NOT NULL | outstanding |
| cleaner_settlement_state | text NOT NULL | outstanding |
| owner_settled_cents | bigint NOT NULL | 0 |
| cleaner_settled_cents | bigint NOT NULL | 0 |

New defaults describe an explicit newly created opening decision. No booking is
classified, settled, or paid merely by applying schema changes or by checkout date.

There are no additional reconciliation/payable, funds-received or repair fields
on this table in current code. Reconciliation/payable eligibility is calculated
in `lib/stay-finances.js`; funds reviews live in `ops_stay_financial_reviews`.
Existing created_by/created_at/reason retain attribution; repair batch references
are recorded in the existing reason and `ops_events` detail/system_run_id fields.
Previous_id and request_key preserve revision and request identities.

The supplied column list cannot establish live constraints, indexes, grants,
policies or triggers. Alignment adds 13 named compatible CHECKs: owner/cleaner
allowed states; owner/cleaner amount bounds 0–1,000,000,000 cents; agreement of
fully-settled marker with both obligations; outstanding implies zero (two checks);
partial implies positive (two checks); Bond attestation for any non-outstanding
obligation; allowed overall state; reason length; exact cutoff date.
These supplement existing compatible unnamed checks, which are retained.

It ensures uniqueness for id, request_key and previous_id, adding supporting
unique/primary-key indexes only if equivalent constraints are missing. It ensures
foreign keys for booking_id → ops_bookings.id, previous_id → this table.id and
created_by → ops_staff.user_id. Existing foreign keys/indexes are not dropped.
No extra booking/date/reconciliation index is required by current logic.

## Preservation and backward compatibility

The table is locked for the atomic upgrade. Missing columns are added only if
there are no existing rows. If a non-empty legacy/partial schema lacks ANY of the
five fields, the migration aborts before alteration: an old open marker cannot
prove zero prior payments, and a settled marker cannot supply exact paid amounts.
Such a database needs a separately reviewed per-row mapping; this migration never
silently converts those records. This is a deliberate safe-stop, not automatic
support for non-empty legacy backfilling.

Already complete schemas preserve every row and value. Wrong types, NULLs,
conflicting values or duplicate keys fail validation and roll the migration back.
Reruns on a compatible schema are safe. Column defaults affect future inserts,
not existing values. No UPDATE, DELETE, trigger disabling or table recreation occurs.

No RLS/policy/grant changes are needed. The migration verifies RLS, the existing
finance_read policy, no anonymous/service-role table access, authenticated SELECT
only, and enabled immutable/audit_change triggers. Unexpected security drift
aborts instead of guessing permissions. Corrected apply/repair functions can use
all five fields after alignment; their grants and function bodies are unchanged.

## Exact later staging sequence

A. Verify SQL Editor is BSTE Operations Staging and apply the complete 240002
   migration, once authorized. Applying it performs no import or repair.
B. Verify the live columns using the query below. The five new fields must be
   present with correct types, NOT NULL and defaults; confirm RLS remains enabled.
   Any failed migration/test means STOP and ROLLBACK the failed transaction.
C. Run the complete `tests/opening-position-schema-upgrade.sql` (temporary tables;
   tests empty legacy, non-empty legacy safe-stop, fresh/current, rerun and policy
   drift) and `tests/opening-period-correction-rls.sql` (rolled-back fixture tests).
   Also rerun `tests/stay-finances-rls.sql` and `tests/historical-backfill-rls.sql`.
D. Confirm real counts remain 17 / 1 / 1 / 0 and no test fixtures remain.
E. Only then build/use the separately authorized protected MFA repair action.
   Do not retry the historical import, fabricate JWT claims, or run repair in an
   ordinary SQL Editor session without real staff authentication.

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='ops_stay_opening_positions'
order by ordinal_position;
select relrowsecurity from pg_class
where oid='public.ops_stay_opening_positions'::regclass;
select (select count(*) from public.ops_bookings) as bookings,
       (select count(*) from public.ops_historical_batches) as batches,
       (select count(*) from public.ops_historical_results) as results,
       (select count(*) from public.ops_stay_opening_positions) as openings;
```

Migration history is manual SQL Editor history; this project has no
supabase_migrations.schema_migrations table. Do not create one or assume CLI state.
Local static/Node tests are not PostgreSQL execution. SQL regression files still
require manual isolated staging execution. Schema facts for other finance tables
and installed finance-function bodies were not supplied and are not claimed to
have been verified live by this opening-table alignment.
