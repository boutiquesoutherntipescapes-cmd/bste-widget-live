# Stay finances — Phase 1 staging

Local implementation only. Apply `202609230001_stay_finances.sql` manually to the isolated BSTE Operations Staging project after SQL review. Never edit/reapply earlier migrations. No PayFast, Beds24 write, communication, bank transfer, monthly finalization or payout-recording action exists in this phase.

## Before using

- Confirm the staging project pin and normal staff MFA access already configured for the dashboard. No new real keys are required. The staff JWT, not the service key, handles financial writes and private storage.
- Run the rollback SQL test in an isolated test database with all migrations. Then verify Storage policies and actual uploads/downloads under Administrator, Finance, Operations, anonymous and AAL1 sessions.
- Configure actual Low/High rate date periods for each property using the finance panel. End dates are exclusive. Periods cannot overlap; every stay night must be covered. Rates have no global default. A correction appends a new period version. Each financial review freezes every nightly rate, its record ID, season and date.
- The existing importer fetches current/future stays only. The completed-stay view can retrieve past bookings already stored in the operations database; it does not backfill historical Beds24 bookings. No importer scope was changed.

## Business rules implemented

All values in this first release are ZAR cents. Defaults per stay: R1,000 guest cleaning charge and R800 cleaner cost. Both are independently editable. Accommodation revenue and channel fees require explicit entry; the imported total is shown as evidence but never assumed to be accommodation-only. No Beds24 deposit or payment-review label is counted as receipts.

Owner gross = sum of configured rates for the stay nights. Owner draft payout = owner gross minus approved owner allocations. Stocking and laundry have their own lines. Unusual costs require explicit Owner/BSTE/Guest/Split/Needs-review allocation; split uses exact rand amounts, not percentages. Unresolved or unapproved entries block readiness and are not deducted. Only the latest expense version contributes; void revisions remove the expense from current totals without deleting it.

Accommodation contribution = accommodation revenue − channel fees − owner gross. Cleaning contribution = guest cleaning charge − cleaner cost. Total stay contribution is those two contributions added. Other BSTE expenses and contribution after those costs are displayed separately. Recovery of owner costs is not income. Cleaner cost belongs in the financial review, not another expense category.

Funds received is an explicit cumulative evidence-backed staff assessment, not another additive receipt ledger. Positive amounts require an evidence reference and as-of date. Expected net BSTE funds = accommodation + guest cleaning − channel fees. This simple gate does not cover extras, refunds or guest recoveries; guest-recoverable allocations block readiness for further review. Never treat `draft_ready` as payment authorization. Owner/guest/unpaid funding of owner allocations is flagged for cash review rather than silently deducting twice.

A completed and reviewed stay with the necessary funds and resolved expenses can show `draft_ready`. Upcoming stays show `awaiting_checkout`; insufficient funds show `awaiting_funds` when other review requirements are satisfied. Unreviewed inputs show `needs_review`. Source date/property/status or booking-price changes flag the review, never overwrite it. Owner and cleaner monthly grouping uses checkout month, with no prorating. No monthly payment is created.

Opening-period means a pre-system stay (checkout on or before 23 September 2026); it is NOT a settlement classification. Administrator opening revisions record `opening_period`, independent owner/cleaner states (`outstanding`, `partially_settled`, `fully_settled`) and prior paid amounts. Channel/guest funds are separately evidenced in financial reviews and never mark either creditor paid. Partial prior payments reduce only that creditor’s remaining obligation. Fully-settled historical exclusion requires an explicit administrator attestation, Bond confirmation and both obligations fully settled. Corrections/reopening remain audited append-only revisions. Dates, expenses, receipts and source refreshes never settle obligations.

The three Bond-confirmed stays (Legacy 5–13 September, Kalaya 8–11 September, Pearl 6–13 September 2026) are completed opening-period stays with BSTE funds received and BOTH owner and cleaner outstanding. They belong in September reconciliation. Actual received amounts/evidence must be entered after import; no live records are created by this local change. Stocking/laundry allocated to owner reduce owner entitlement; cleaner cost remains a September payable. Expense capture/reconciliation must explicitly be complete before owner payout readiness. Phase 1 still initiates no payments.

## Access and history

- Administrator and Finance need existing AAL2 MFA. Operations cannot read financial tables, private receipt metadata, financial history or storage objects.
- Administrators configure rates, mark reviews reviewed, approve expenses and attest cutover. Finance may enter draft/review records but cannot approve or perform cutover. This retains the existing conservative Finance role limits.
- Financial writes go through `ops_finance_write`; actors/timestamps come from the database. App roles have no direct expense, review, rate, attachment or opening-position write grants. New records are immutable; corrections are new records linked to the previous revision.
- Unique request keys serialize retries and reject a reused key with different content/actor/action. Booking locks and previous-revision checks reject stale edits. Invoice-reference/category/date/supplier/amount duplicates are rejected within a booking. Reference-free or differently-described duplicates still require staff review.
- Finance history exposes only financial events for the selected booking, not the full administrator audit log. Existing general operational notes remain unsuitable for confidential financial notes; finance forms use audited reasons instead.

## Receipts

Private bucket: `ops-stay-receipts`, limit 2 MiB, JPG/PNG/PDF. Metadata records random immutable path, uploader/time, media type, byte length and SHA-256. Upload endpoint checks size and file signature; download revalidates content/hash and returns an attachment through the staff endpoint. No service-role credential or public receipt URL reaches the browser. The application never embeds uploaded PDFs or images as active page content. File signature checks are not malware scanning.

Metadata is created before storage upload. If upload fails, the metadata is retained and the UI reports failure; retry with the same selected file succeeds without overwriting existing evidence. Metadata alone does not prove a successful upload. A changed file requires a new upload request. Old attachments remain available after expense correction. Receipts are preferred, optional, and missing-receipt reasons are optional.

## Validation and remaining staging work

Node tests cover calculations, access guards, receipts, disabled actions and UI permission gating. SQL regression tests are separate and require PostgreSQL/Supabase; static checks cannot replace executing them. Storage policies must be checked for conflicts with any existing broad Storage policies. Use synthetic files for first storage tests.

Final monthly owner statements, cleaner payment batches, actual owner/cleaner payment records and payout authorization remain disabled. The pre-existing monthly tables are unchanged inactive foundations. Later phases must freeze approved monthly lines and use payment allocation records, not infer paid status from an entitlement or funds review.
