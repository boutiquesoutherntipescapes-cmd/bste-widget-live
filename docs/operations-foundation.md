# Step 2: staff access and operations storage

Staging status updated 21 September 2026: Bond reports the migration and rollback SQL suite passed in isolated BSTE Operations Staging, with all test fixtures removed. No production migration or deployment was performed by this task. No bookings were imported and no messages, inventory or calendar actions were added. PayFast is not required. See [staff staging setup and recovery](staff-staging-setup.md) for local configuration and first Administrator provisioning.

## Existing integration and chosen approach

Existing owner APIs call Supabase REST with `SUPABASE_URL` and a server service-role key. They assume `owner_access` and `owner_blocks` tables; no schema migrations were present. Keep those APIs/tables unchanged. Staff must not use owner URL tokens or service-role requests for ordinary actions.

Staff authentication uses Supabase Auth password sign-in over REST, then verifies the token through `/auth/v1/user` and checks an active `ops_staff` record. Authorization is stored in the database, not editable Auth metadata or a browser role flag. This follows Supabase's [Auth model](https://supabase.com/docs/guides/auth) and [row-level security model](https://supabase.com/docs/guides/database/postgres/row-level-security).

`staff-login.html` is a sign-in foundation, not a dashboard. The server holds the access token in a Secure, HttpOnly, SameSite=Strict host-only cookie. Tokens never go into browser storage or JSON responses. Both forms declare POST, omit input names, and start disabled; JavaScript enables them only after attaching the submission handlers. A script failure cannot fall back to sending credentials in a URL. The endpoint rejects native form encoding. Staff pages receive response-level `frame-ancestors 'none'` and `X-Frame-Options: DENY` through the local Vercel routing file; the session endpoint sets both too. Verify their actual HTTPS responses before release.

Mutating session requests require the exact configured HTTPS origin, without path, trailing slash, wildcard or request-header-derived trust. Preview authentication is disabled by default, including session reads. Enabling it requires the exact `VERCEL_URL` origin and an explicitly separate Supabase project. These checks rely on accurate administrator configuration; they are not an independent discovery of the production project.

Required settings, to configure later in an approved environment:

- `BSTE_STAFF_SUPABASE_PUBLIC_KEY`: the staff project's publishable or legacy anon public key, never a service-role key.
- `BSTE_STAFF_ORIGIN`: exact HTTPS origin without trailing slash.
- `BSTE_STAFF_SUPABASE_URL`: the isolated staff project URL. Staff requests do not fall back to the existing owner-portal `SUPABASE_URL` or use a service-role key.
- For preview only: `BSTE_STAFF_PREVIEW_ENABLED=true`, `BSTE_STAFF_PREVIEW_SUPABASE_URL` (canonical isolated project origin), and `BSTE_STAFF_PRODUCTION_SUPABASE_URL` (canonical production project origin, used only for comparison). The preview URL must match the configured Supabase URL and differ from production. Configure these only after an isolated project is approved. Do not copy production secrets into preview.

### Mandatory MFA

Bond and Leah use individually provisioned Supabase Auth accounts with the administrator role. Administrators and Finance require a verified second factor (`aal2`). The database additionally requires MFA for **any role with any permission beyond `operations.read` and `operations.write`**. New refund/cancellation/financial permissions therefore require MFA by default. Adding a new role still requires an explicit schema/permission review.

Password sign-in for a privileged user creates only a pending cookie (up to five minutes) and exposes no bookings/financial data. The page supports first-time TOTP enrollment with a QR code/manual setup key, plus challenging and verifying an already enrolled TOTP authenticator using Supabase Auth. The server rechecks Auth and database access after verification; only then does it report successful staff access. Privileged users without a verified factor enter enrollment and remain blocked from operational access until verification. Recovery instructions are displayed in the page; lost-factor recovery is staff-assisted with independent identity checks, not an email bypass. See the staging setup runbook.

`ops_can` enforces MFA in all operational/financial RLS policies and sensitive staff-write triggers. Direct database API access cannot bypass it. The `ops_staff_access` RPC returns only minimal own-account sign-in information before MFA. Roles and grants come from database records, never user-editable Auth metadata.

### Logout, expiry and evidence

Sign-out requests `/auth/v1/logout?scope=local`, terminating that provider session, and clears the browser cookie. Audit failure does not block that request; provider failure returns an error rather than claiming successful termination. Other devices are not signed out. No refresh token is retained or returned.

Protected access also checks that the token's `session_id` still belongs to the user in `auth.sessions`, and that the session was created within one hour. This blocks a logged-out session even if its signed access token has not expired, following [Supabase's session validation guidance](https://supabase.com/docs/guides/auth/sessions). The cookie has a maximum one-hour lifetime; MFA does not extend the database's one-hour limit measured from initial password sign-in. An expired/removed session requires sign-in again. Deactivating a staff record also denies protected access.

Application events are explicitly marked `event_origin=application_report`, with names `application.session_started` and `application.sign_out_requested`. They are caller reports and do not prove a provider authentication event or completed logout. Supabase Auth audit logs remain the authority for provider authentication; they are not copied or fabricated by this migration. A failed logout can leave the provider session alive until expiry/revocation, so the UI reports the failure.

No public self-signup UI. An unrelated authenticated Supabase user receives no staff access. Password recovery/account provisioning is an administrator-managed prerequisite, not an automatic email action in this code.

## Provisioning (not performed)

1. Review the migration against the real schema; run it on an isolated Supabase project and run the SQL security checks. Obtain approval before any production application.
2. Confirm Bond's and Leah's actual email identities. Provision individual Auth accounts using an approved administrative process; no identities/passwords are guessed or seeded.
3. For each verified Auth UUID, create an active `ops_staff` row with display name Bond or Leah and role `administrator`. Direct database provisioning is currently required; there is no self-service role mutation endpoint.
4. Enroll and verify individual TOTP authenticators through the staff login page. Verify password-only denial, MFA completion, lost-device recovery, HTTPS cookies, provider logout/session-row removal, one-hour expiry, and financial isolation before allowing real guest data.

## Tables and boundaries

| Table | Purpose |
| --- | --- |
| `ops_staff` | Named active staff linked to Supabase Auth UUIDs. |
| `ops_role_permissions` | Explicit role grants; only trusted database administration can alter them. |
| `ops_properties` | Verified property and room IDs. |
| `ops_bookings` | Selected operational source facts, raw status/channel, contacts and sync/enrollment timestamps. No inferred payment state. |
| `ops_booking_financial_snapshots` | Restricted raw price/currency/deposit/invoice fields, separate from operations-visible data. `deposit` remains uninterpreted. |
| `ops_tasks` | Persistent preparation/check-in/checkout/cleaning tasks, assignee and completion status. |
| `ops_notes` | Append-only notes and linked corrections. Do not put financial evidence in ordinary operational notes. |
| `ops_payment_records` | Append-only reviews, verified receipts and corrections; integer cents, currency, evidence and receipt key. No imported deposit-to-receipt conversion. |
| `ops_payment_arrangements` | Administrator-approved deadlines, reasons, status and attribution. No cancellation automation. |
| `ops_communications` | Future schedule/status foundation; `scheduled`, `sent`, `failed`, `skipped`. Sending is database-disabled in this migration. No content/sender/worker is implemented. |
| `ops_events` | Append-only timestamped before/after history with staff identity or explicit system/database actor. Contains sensitive facts; administrator-only read. |

All tables have RLS; anonymous access is denied. Operations staff can read operational snapshots and create/update tasks/add notes. Finance staff can read operational information and create financial records, but cannot approve arrangements or read the full audit stream. Administrators have both capabilities and arrangement/audit access. Neither ordinary users nor administrators can modify source snapshots, staff roles or the message schedule through authenticated REST. These are trusted provisioning/importer responsibilities, not staff-side shortcuts.

Staff record triggers override submitted actor/time fields, preserve original creation attribution, and log changes in the same transaction. Notes/payment records/audit cannot be updated or deleted; corrections append. No staff delete grants are present. A privileged database owner remains a trusted administrator, not a security boundary this migration can constrain. Audit copies include personal/financial information: approve retention/access before production and do not persist raw secrets or arbitrary full API responses.

## Idempotent synchronization contract for Step 3

- Use `(source_environment, source_account, beds24_booking_id)` as the unique source identity. Configure one stable account identifier; do not use guest email, property name or dates as identity. Internal UUID remains stable if dates/property change.
- Use service-only `ops_sync_booking(snapshot, financial, run_id)`. Its atomic upsert writes only approved source columns and preserves the internal UUID, `first_imported_at`, original-policy marker and enrollment state. Direct service-role writes to source tables are revoked. Concurrent imports serialize on the unique source key. The external read-only Beds24 fetching worker is not included in Step 2.
- Record `source_observed_at` when the source request **starts**, not when the database write completes. Preserve Beds24's revision timestamp when available; do not invent one. Database guards reject older observations, older or missing revisions after a known revision, conflicting data at an identical observation time, and differing facts at the same known source revision. Such conflicts require reconciliation, not an overwrite. Verify Beds24 revision precision/semantics before importing. Without a provider revision, observation ordering cannot detect an upstream cache serving old data; the importer must establish reliable uncached reads.
- Financial snapshots are written in the same transaction and must carry exactly the same observation/revision as the operational snapshot. Independent guards reject older/conflicting financial snapshots. Passing SQL/JSON `null` for the financial argument means “not fetched” and preserves existing finance data; a supplied object must be a complete selected financial snapshot, not a partial patch. Display its observation date so preserved older financial information is not presented as freshly checked. Never interpret `deposit` as a receipt.
- Audit ignores changes only to observation/sync/update timestamps. Real source changes generate before/after evidence. Duplicate imports do not create duplicate booking rows or unchanged audit entries.
- Property/room combinations must match verified `ops_properties` mappings. Legacy: 351452/724919; Kalaya: 352005/726060; Pearl: 352276/726696. Configuration also now contains these IDs; the existing helper therefore no longer needs name matching for these properties.
- Preserve raw `new`, `confirmed`, and `request`. `new` must not be treated as inactive: the supplied live verification includes Airbnb reservations in that state. `request` needs explicit review/classification; do not quietly promote it. Classification does not alter Beds24.
- Preserve records and flag an incomplete sync; disappearance from one result page never proves cancellation. Fetch known IDs/status changes explicitly. Apply South African local-date coverage for in-house, upcoming and departure-day records.
- Staff tasks, notes, reviews, arrangements and audit are separate rows. Snapshot refresh must not overwrite them. Stable task keys and message keys prevent duplicate logical entries. Service-only `ops_ensure_system_task` inserts missing tasks and leaves existing tasks completely untouched, including staff completion, title, due date and assignee. Automated task creation uses null staff UUIDs, explicit `beds24_importer` creation/update labels, and a run UUID in the audit. Later staff edits preserve the system creator and stamp the actual staff editor. Neither RPC can send messages or alter Beds24.
- All imports in this foundation use `existing_booking_original_terms`. Do not retrofit buffers, payment deadlines, check-in gates or cancellation eligibility. Missing payments mean not reviewed/unknown, not unpaid. Unknown contacts remain null; do not assume OTA email.
- The operations snapshot deliberately excludes full arbitrary source JSON. Store only necessary approved fields. Raw financial source values stay in the financial table. Preserve null versus an actual zero; do not invent currency.
- `automation_enrolled_at` starts null. A later explicit, future-only enrollment step records a fixed cutoff and skips passed windows. Importing data is not enrollment and cannot send. Scheduling/sending requires additional work and a reviewed migration to remove the disabled constraint.

The supplied verification is a point-in-time baseline: 10 upcoming (Kalaya 6, Legacy 4, Pearl 0), sources Airbnb 6/Booking.com 2/Direct 2, statuses new 6/confirmed 3/request 1. Reconciliation must use a fresh source snapshot, not hard-code these counts. Name/count/price fields were reported present; email only 2/10 and phone 8/10. No financial meaning is assumed for deposit/invoice fields.

## Before the first import

- Approve/apply this migration in the intended environment after isolated SQL/RLS validation; configure staff Auth and provision verified Bond/Leah accounts.
- Implement the dedicated read-only importer with a stable account/environment key, source freshness handling and explicit mapping. Use the dedicated long-life read credential, not the existing refresh-token workflow. Never invoke the booking-workflow endpoint.
- Verify local credential availability securely and actual currency/channel/payment field representations; confirm treatment of requests and account scope.
- Review existing automation ownership before future sending. The import must have no Beds24 writes, no `custom10` annotation, no Google/HighLevel calls and no messages.
- The intentional upstream `.gitignore` protection is now present locally (`.env`, `.env.*`, except `.env.example`). No commit, pull or merge was performed; branch ancestry is unchanged. Recheck ancestry before eventual deployment.
- The original migration is now applied in isolated staging per Bond’s verification. Do not edit or rerun it there. Future schema changes require a separate migration; enrollment adds none.

## Receipt identity and audit boundaries

Receipt keys are unique across all bookings within the same source account/environment. The database derives that scope from the booking and trims the key, so a staff-supplied scope cannot evade deduplication. Use a stable, canonical, non-secret identifier including its payment source namespace, such as `bank-account-alias:transaction-reference`. Do not generate a new key when retrying. A retry with the same key is rejected for review rather than silently recorded twice. Two genuinely different payment sources must have distinct namespaces. Database deduplication cannot detect the same payment deliberately entered under different identifiers. Corrections append and link to the original record; they are not new receipts.

Named-user attribution is enforced on staff writes. Importer RPCs require the service role, no user subject and a non-null run UUID; they set their own system identity. The server-only service credential remains highly privileged and must never reach the browser. A database owner can still administer the database; immutable-history protection is against application roles, not the database owner dropping triggers. No existing owner-portal table is altered.

## Verification

Run `node --test tests/staff-auth.test.js` with a suitable Node runtime. These tests mock all network traffic. They cover anonymous denial, origin/preview restrictions, admin/Finance MFA denial and successful challenge, Operations/Finance permission limits, provider logout, redacted failures, missing assurance metadata, no-JavaScript form structure, anti-framing configuration and explicit property mappings. The no-JavaScript check is a structural regression test; actual browser behavior and deployed response headers still need staging verification.

`tests/operations-rls.sql` is a rollback-only integration check for an **isolated Supabase test database after migration**. It must not be run against production as part of this task. Local SQL execution requires a PostgreSQL/Supabase test runtime, not just Node syntax checks. Do not describe the migration as database-tested until those checks actually pass.

The expanded rollback SQL suite covers anonymous denial, each role/MFA boundary, importer attribution, duplicate and repeated imports, staff-work preservation, receipt reuse across bookings, financial freshness, immutable audit history, future sensitive-permission MFA and session revocation. It is **not executed by the Node suite**. No SQL migration/test was applied during the local hardening or enrollment tasks. Bond subsequently reported the existing SQL suite passed in staging; the new browser enrollment still needs a live staging test. Validate `auth.sessions` schema compatibility, function ownership, grants/RLS, actual provider logout and concurrent-import races in the isolated environment before approving production.
