# Local/staging operations dashboard and Beds24 read-only import

## Verified starting point

Bond reports real staging password sign-in, first TOTP enrollment, AAL2 access, logout and repeat authenticator sign-in have succeeded. The foundation migration and rollback suite were previously verified in isolated BSTE Operations Staging. This phase adds local files and a **new unapplied migration**; it makes no live calls, imports, configuration changes or deployments.

## Staff routes

- `/staff-dashboard.html`: dashboard page. The local runner checks the existing staff session before serving it. A successful login now offers a dashboard link.
- `/api/staff-operations` GET: authorized staff reads, under the user's JWT/RLS. Lists all current/future saved records from the configured account, with dates evaluated in South Africa. No Beds24 call occurs on page load.
- `/api/staff-operations` POST `{action:"sync"}`: Administrator-only manual read/import. Requires `sync.run` and existing AAL2 enforcement.
- The same POST endpoint accepts `action:"operational"` (Operations/Admin permission) or `action:"payment"` (Finance/Admin permission), with booking UUID, supported status and required reason/evidence note. These append staff reviews and audit entries, never update Beds24.
- `/staff-dashboard.js` and `/staff-dashboard.css`: presentation assets only, no keys/data embedded. The current Vercel configuration is unchanged; no deployed route/protection is claimed. The dashboard is for the local staff runner in this phase.

The dashboard shows the three property counts, arrival ordering, in-house/upcoming/departure-day groups, guest names/counts, raw channel/status, operational/payment review, booking ID, attention flags and synchronization health. All dynamic guest text uses text content, not HTML. There is no messaging scheduler, calendar sender, PayFast dependency or iCal fallback.

## Separate meanings of status

| Record | Meaning |
| --- | --- |
| `ops_bookings.source_status` | Unchanged raw Beds24 value; includes `new`, `confirmed`, `request`. |
| `ops_booking_overrides` | Append-only named staff decisions: confirmed, review required, checked in or checked out. Latest review wins; reason/time/actor remain recorded. |
| `ops_payment_records` review entries | Named Finance/Admin assessment: unknown, unpaid, part paid, deposit paid, paid, channel managed. Not a payment transaction or automatically derived receipt. |

Without a manual operational review, raw `confirmed` displays as confirmed and raw `new` displays as active from source (not inactive or unconfirmed). This avoids inventing a staff confirmation for every `new` record. Raw `request` and other raw statuses display as review required. The display identifies derived versus staff-reviewed status. A request can therefore remain `request` at Beds24 while a staff review says `confirmed` and a separate financial review says `deposit_paid`. The known booking is **not automatically identified or changed**; staff must select it and record their evidence later.

Raw cancellation/block/inquiry states are collected too so a status change does not silently disappear. They get attention flags and no automatic confirmation. If a manual confirmation conflicts with the source, both remain visible and the source warning remains. There is no cancellation action or inventory release in this dashboard.

Every import retains `existing_booking_original_terms`. No new deposit deadline, cancellation eligibility, buffer, preparation task, communication enrollment or check-in payment gate is imposed.

## Import and failure behaviour

The importer is separate from the existing Beds24 helper, which has refresh-token/write paths. It uses a dedicated read-only long-life token and hardcodes only `GET https://beds24.com/api/v2/bookings`. Redirects are rejected. It has no method/path parameter that could select a write endpoint, no token-refresh logic and no fallback source.

Explicit mappings:

| Property | Property ID | Room ID |
| --- | --- | --- |
| Legacy Beach Villa | 351452 | 724919 |
| Kalaya Ridge Villa | 352005 | 726060 |
| The Pearl Beach Villa | 352276 | 726696 |

The importer requests all pages for each room, with a one-day departure overlap and a final SAST-date filter. There is no future end-date cutoff. Required pagination metadata is checked; the importer fails rather than treating a missing/invalid response as an empty property. Limits are 100 pages/property and 2,000 records/batch. These are explicit error limits, not silent truncation.

Stable identity remains `(source_environment, source_account, beds24_booking_id)`. The database is staging, but the source environment is `production` because the read-only Beds24 inventory represents real reservations. Never rename the stable account key between refreshes.

All pages and mappings are validated **before** the batch is stored. Identical duplicate rows are collapsed; conflicting duplicates abort. `ops_apply_sync` wraps the foundation's `ops_sync_booking` calls and full raw payload storage in one transaction. A bad record or stale source snapshot rolls back the entire batch. Existing staff notes, tasks, overrides, payment records and arrangements are never part of that write. Booking UUIDs stay stable and unchanged source observations do not produce repeated booking audit events. A separate sync-attempt record is intentionally retained each time for diagnostics.

`source_observed_at` is the timestamp at the start of collecting the source, not database completion. Foundation guards reject older observations and protect financial snapshot freshness. The database permits up to one minute of client/database clock skew relative to the recorded run start. **No provider modification timestamp is invented.** Its actual Beds24 field/timezone/revision precision still needs verification; until then `source_modified_at` is null. If an existing snapshot has a known revision, this importer will fail closed rather than erase that revision. Observation ordering cannot prove a provider cache is fresh; the first real read must verify response semantics. Raw provider fields are retained for that investigation.

The raw payload is in `ops_beds24_raw_snapshots`, Administrator/audit-access only. It can contain guest contacts, notes and financial fields and must be treated as sensitive. The normal booking snapshot holds selected operational fields only; price/currency/uninterpreted deposit/invoiceItems remain in the restricted financial snapshot. Missing currency/contact values stay unknown. Raw source channel is selected from `channel`, then `referer`, then `apiSource` without inferring “Direct” from absence; the original fields remain in the restricted payload.

One running import per account is enforced in the database. Runs older than ten minutes are marked interrupted when another authorized attempt starts; they cannot subsequently commit. `ops_sync_members` records membership of each successful batch. If a previously saved current/future reservation is absent later, it stays visible with a warning—absence is not a cancellation. Date changes into the past/removal need a later targeted-ID reconciliation before such a record can be treated as resolved.

Diagnostics distinguish the latest attempt, successful import time, Beds24 read outcome, number imported and each property's counts (including zero for Pearl). Data older than **30 minutes** is labelled stale; this is a conservative display warning, not a booking/business rule. Failed imports display errors and saved data remains visible. If storage is unavailable, the UI says it cannot load the dashboard rather than displaying an empty success. If recording failure itself fails, the run stays visibly running/interrupted until reconciled. Provider response bodies/tokens never become UI errors.

## New migration and expense hooks

`202609220001_operations_dashboard.sql` adds eight RLS-protected tables:

- `ops_booking_overrides`: audited append-only operational reviews.
- `ops_sync_runs`, `ops_sync_members`: durable import diagnostics, initiator and batch coverage.
- `ops_beds24_raw_snapshots`: restricted complete source payload.
- `ops_stay_expenses`: stay/property, category, date, cents/currency, private receipt-object reference, owner/BSTE/split allocation, draft/review/approved state and approval identity.
- `ops_month_reconciliations`: property/month completeness gate (“Have all expenses been logged?”), reviewer and time.
- `ops_owner_statement_snapshots`: immutable finalized statement snapshot linked to a completed gate. A database guard rejects finalization while that month contains unapproved expenses.
- `ops_owner_statement_adjustments`: append-only links for later expenses/adjustments against finalized statements.

The migration adds `deposit_paid` as an explicit manual-review value to the existing payment table. It adds Administrator `sync.run` and `expenses.approve` permissions, which retain MFA enforcement. The already-applied foundation migration is untouched.

Expense hooks deliberately grant **no application/service-role expense writes**, upload bucket or payout API. No expense affects any calculated payout yet. A future reviewed implementation must calculate deductions from approved expenses only, freeze statement lines/totals at finalization, and route late expense impact through an authorized adjustment instead of rewriting the statement. Receipt access, statement currency/owner attribution, accounting period rules, approval RPCs, adjustment authorization and concurrency-safe finalization remain work for that phase. No receipt OCR is included.

## Staging variables needed later

Do not populate these as part of this coding phase. Use `.env.staff.local` only after checking that the project is **BSTE Operations Staging**. Never copy the entire production `.env.local`.

Existing staff runner settings remain:

```dotenv
BSTE_STAFF_ENV=staging
BSTE_STAFF_SUPABASE_URL=https://YOUR-STAGING-PROJECT-REF.supabase.co
BSTE_STAFF_SUPABASE_PUBLIC_KEY=YOUR-STAGING-PUBLISHABLE-OR-ANON-KEY
BSTE_STAFF_ORIGIN=https://localhost:3443
BSTE_STAFF_TLS_CERT_FILE=.local/staff-tls/localhost-cert.pem
BSTE_STAFF_TLS_KEY_FILE=.local/staff-tls/localhost-key.pem
```

New settings (placeholders only):

```dotenv
BSTE_OPERATIONS_ENABLED=true
BSTE_OPERATIONS_STAGING_PROJECT_REF=YOUR-STAGING-PROJECT-REF
BSTE_BEDS24_ACCOUNT_KEY=bste-main
BSTE_BEDS24_IMPORT_ENABLED=false
BSTE_STAGING_SUPABASE_SERVICE_ROLE_KEY=YOUR-STAGING-ONLY-SERVICE-ROLE-OR-SECRET-KEY
BEDS24_LONG_LIFE_TOKEN=YOUR-DEDICATED-BEDS24-READ-ONLY-TOKEN
```

The project reference must exactly match the staff Supabase URL. Production Vercel environments are rejected by this operations path. A legacy service-role JWT must also contain that project reference; a modern `sb_secret_` key must be copied from the staging project and will be rejected by Supabase if it belongs elsewhere. The browser receives neither privileged key nor Beds24 token. Staff reads/manual reviews always use the staff JWT and public key, not service credentials.

The importer uses the staging service key only for atomic import/failure-recording RPCs. `BSTE_BEDS24_IMPORT_ENABLED` must be changed to `true` **only when the first live read/import is separately authorized**. The UI button never runs automatically. There are no cron jobs.

## Exact next safe step

1. Review the new migration and apply **only it** to BSTE Operations Staging after separate approval. Do not rerun the original foundation migration.
2. Run `tests/operations-dashboard-rls.sql` in that isolated staging database with stop-on-error, then verify its fixtures rolled back. Keep import disabled. The older foundation suite also remains available for regression checks.
3. Configure the staging-only variables above and verify the project reference independently in the Supabase dashboard. Keep the import flag false initially; authenticate as Bond and open `/staff-dashboard.html` to verify empty/stale diagnostics and financial permission handling.
4. When explicitly authorized, add/verify the dedicated read-only Beds24 token and staging-only service key, enable the import flag, restart the local runner and press **Refresh from Beds24 once**. This performs Beds24 GETs and staging database writes; no production database writes or Beds24 writes occur.
5. Inspect restricted raw responses for actual pagination/date/channel/currency/revision fields, compare property counts/statuses with Beds24, check in-house/upcoming coverage, and refresh again to check stable UUIDs. Reconcile against current data, not the older 10-booking baseline.
6. Manually identify the known request booking. Record operational confirmation and the independently verified deposit review with reasons using Bond's named account. Refresh once more and check both decisions survive. This changes staging staff records only.

Local automated tests use mocked HTTP and simulated DOM. The new migration and new SQL suite have **not** been executed during this task. No real source-field compatibility, live import, browser rendering or database concurrency validation is claimed from those mocks.
