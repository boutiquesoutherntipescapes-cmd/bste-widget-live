# Controlled local September import

No import was executed during implementation. Separate authorization is required before live use.

Page: `https://localhost:3443/staff-september-import.html`. POST endpoint: `/local/september-import`. Neither is deployed; files remain under scripts.

1. Restart the local staging runner from the permanent Developer checkout. Sign in as the existing MFA Administrator.
2. Under the appropriate read authorization, run the protected September preview once in the same browser. The old preview predates the server-memory selection feature; it cannot be reconstructed from masked IDs. A fresh preview is required after restart.
3. Open the import page. It displays only the three uniquely matched approved property/date/channel stays. All identities and raw source payloads are held server-side and bound to the same user/session for 25 minutes. Nothing is written while loading the selection.
4. After separate import authorization, tick Bond’s confirmation and click **Import 3 September stays** once. The request contains no booking IDs, financial amounts or settlement choices.
5. Expect three imported, three opening-period records and 17 total bookings if staging still has the reported 14 and all three are missing. On uncertainty/failure, stop and inspect staging; do not automatically retry.

Only existing historical approval/apply RPCs may write. Selection uses production Beds24 source environment + configured source account + exact previewed booking ID. `settle_ids` is always empty. Source financial fields, including deposit, remain source data only. No funds-received staff review, expenses, receipts, payments, payouts, communications, normal sync or Beds24 requests occur during apply.

The existing SQL functions create audited open opening-period records with owner and cleaner outstanding. Existing opening decisions are verified and never overwritten. Successful repeat clicks return the recorded result; a fresh preview/rerun verifies existing records and skips writes. A staging importer credential must already be configured server-side; it is never exposed. Administrator requires AAL2 plus sync.run, finance.write, finance.read and finance.cutover.

The harness reads booking counts before/after and checks that previously stored booking rows remain unchanged. It reports masked results only. A post-apply verification failure cannot undo an already committed RPC; inspect staging before any new attempt. Existing SQL idempotency and source-conflict checks remain authoritative.

Migrations were manually applied via SQL Editor; no CLI migration-history table exists. See staging/backfill documentation.
