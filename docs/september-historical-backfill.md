# September historical backfill — local implementation, not executed

Scope: checkout **2026-09-01 through 2026-09-23 inclusive**, using the three existing explicit BSTE property/room mappings. The opening-period eligibility cutoff is checkout **on or before 2026-09-23**. No approximate owner rates, inferred receipts or source-status rewrites are introduced.

## Preview first (only after Bond authorizes reads)

From the repository, using the existing Node runtime:

```sh
node scripts/preview-september-backfill.mjs --preview
```

This command was NOT executed during implementation. It will make read-only calls to Beds24 and the isolated staging Supabase project. `--help` is offline. No other CLI mode, including `--apply`, is supported.

Configuration must already identify the isolated staging project through the existing operations settings. The account key MUST be the same as the normal importer. Supply `BEDS24_LONG_LIFE_TOKEN` and a current AAL2 administrator access token as `BSTE_BACKFILL_STAFF_ACCESS_TOKEN` through a secure local process environment. Do not put token values in command arguments, reports or committed files. The script does not load `.env` automatically or implement a new sign-in/MFA bypass; secure provisioning of the short-lived staff token must be arranged before the authorized run.

Preview needs the existing operations schema, not the new historical batch tables. It reads staff access, stored booking identities and restricted financial snapshots. It does not call any write RPC. It reads all relevant Beds24 pages via GET, without a status filter, across the three explicit room IDs. Requests use an overlapping departure window; the exact September 1–23 scope is enforced locally. Provider date-filter inclusivity, historical visibility, status conventions and token coverage must still be verified live. A successful response alone does not prove comprehensive history.

The report contains booking ID, property, arrival/departure, raw status, channel, stored/missing state and names of changed fields. Names, contact details, prices, deposit values and raw payloads are not printed. It includes:

- cancelled bookings, requests, inquiries and blocks;
- explicit non-guest indicators, and unsupported/unusual statuses;
- identical duplicate source rows, conflicting duplicates and local identity conflicts;
- stored September stays not returned by the source (never deleted or treated as cancelled).

Full source payloads exist only in process memory. The command prints only the masked report and digest, and does not persist a full manifest or upload a preview. Guest-candidate means only raw `new`/`confirmed` without an explicit non-guest indicator; it is NOT proof of a completed or settled stay. Owner/block metadata conventions remain a live verification item.

## Later approval/apply path — not exposed by the preview CLI

`applyApprovedHistorical` is a separate library entry point. It requires a fresh in-memory preview, exact preview digest, explicit `import_ids`, explicit `settle_ids`, Bond confirmation and an approval reason. A separate approved execution harness will be needed before invoking it; there is no apply dashboard button or automatic preview-to-apply transition.

An authorized apply first calls `ops_stage_historical_batch` under the named administrator's AAL2 JWT, storing the exact selected payload and approval immutably. Only the service importer can call `ops_apply_historical_batch`, and it can apply only a staged batch ID. It does not accept replacement payloads. Apply requires the administrator still be active, the approval session valid and the approval less than 30 minutes old. All source writes and opening positions occur atomically. Date classification alone never settles a payable.

The approval expires; a preview is not permission to apply indefinitely. If stored booking state changes since discovery, the entire apply fails and requires a fresh preview. Database write privileges and service-role execution are not substitutes for Bond's authorization to run this later.

## Identity, isolation and reruns

Identity remains `(source_environment, source_account, beds24_booking_id)`. Source environment `production` means the Beds24 source of the reservation; the storage destination remains the isolated staging project. Never invent a historical source account.

Historical batches/results use separate tables, not normal sync runs or membership. They cannot become the latest normal sync or cause missing-current-booking warnings. The historical apply coordinates with the normal account lock and refuses to run while a normal sync is running. It upserts through the existing source guard and stores the raw source payload separately. It does not synchronize staff expenses, attachments, financial reviews, payment records, communications or tasks.

Same-batch retries return the recorded result. A new approved preview may refresh the same booking UUID, but never duplicates the booking. It creates an initial opening-period position with outstanding obligations for guest candidates; only a separately selected `settle_ids` attestation can set both obligations fully settled. It creates a position only for selected guest candidates and only if the booking has **no opening-position history at all**. Any existing decision wins. In particular, reruns do not reverse an intentional administrator reopening. To intentionally settle a reopened stay again, the administrator must use the explicit audited opening-position revision workflow.

Historical records remain visible through the completed-stay finance view. Expenses and JPG/PNG/PDF receipt attachments remain editable through their existing append-only workflows. Neither reopens a stay. Historical-settled records remain excluded from new owner/cleaner payables and payout eligibility, regardless of later expenses or verified funds. No money is created or paid by this importer, and Beds24 deposit remains uninterpreted source data.

## Migration and verification

- Unapplied Phase 1 migration: inclusive cutoff and explicit administrator-only opening/reopening authority.
- New `202609230002_september_backfill.sql`: immutable batches, results, approval and importer RPCs; no changes to already-applied migrations.
- `tests/historical-backfill.test.js`: local mocks, masking, statuses, bounds, approvals, identity and isolation.
- `tests/historical-backfill-rls.sql`: isolated transactional SQL tests for actual database permissions, reruns, reopening, cutoff boundaries and staff-record preservation. Must be run separately with `psql -v ON_ERROR_STOP=1`; it rolls back its fixtures.

Neither migration nor SQL test has been executed by this implementation task. PostgreSQL execution, Storage access and real historical API coverage remain staging-verification prerequisites. Preview exceptions require review; blocked/cancelled/request records may be imported explicitly as source history but are never batch-settled. A record absent from Beds24 is reported, not fabricated or deleted.

## Corrected opening model (Bond decision)

The September 23 boundary means pre-system eligibility ONLY. Legacy September 5–13, Kalaya September 8–11 and Pearl September 6–13 have channel funds received but owners and cleaners unpaid. Import them without settlement selection. They must remain in September reconciliation with expense/receipt entry enabled. Record actual funds/evidence separately through the financial review; no amounts are inferred from Beds24 deposit or from dates. Do not use `settle_ids` for these three stays.

Owner and cleaner settlement are independent administrator-controlled opening attestations. Outstanding and partially settled stays retain remaining payables; only explicitly fully settled historical stays are excluded. Expense/receipt entry never marks either creditor paid. Monthly payment execution is outside Phase 1.

## Staging migration record — manually applied through SQL Editor

Bond reports that `202609230001_stay_finances.sql` and `202609230002_september_backfill.sql` were successfully applied through the authenticated **BSTE Operations Staging SQL Editor**, not Supabase CLI. This project has NO `supabase_migrations.schema_migrations` table. Do not infer unapplied migrations from absent CLI history, do not blindly rerun these SQL files, and do not create a history table merely to resolve this difference. Inspect actual schema/functions when checking installation.

Bond verified: 14 bookings; zero historical batches/results/opening positions; finance and backfill RLS tests passed; private receipt bucket verified; no persistent test data. These are user-reported staging results, not fresh external verification by the local harness implementation. No migration changes accompany this harness.
