# September opening-period correction (local, not applied)

Staging diagnostics confirmed a legacy settlement-only apply function. The three
bookings and original batch/result are valid evidence and must be retained.
Migration `202609240001_fix_opening_period_backfill.sql` replaces the function,
adds counters, and installs `ops_repair_september_openings(uuid,text)`. Applying
this migration does not run the repair or import anything.

## State and counters

New qualifying guest imports create an opening-period row even with settle=false:
open, owner outstanding, cleaner outstanding, both paid amounts zero. No funds
review is created. The date cutoff establishes eligibility, never settlement.
Existing administrator revisions are preserved. The postcondition requires one
root and one current decision per booking, allowing legitimate revision history.
An old result with missing opening rows raises an explicit error instead of
silently returning success. Do not retry the original import to repair it.

`newly_created_opening_count` counts all newly inserted opening rows;
`settlement_count` counts the explicitly settled subset. `preserved_opening_count`
counts retained decisions. `retained_opening_count` remains for compatibility.
Old results get NULL for the two new fields (unknown, not zero); their original
values are never updated, even after repair. Repair has its own return counters
and append-only per-booking audit events with actor, time, reason and batch ID.

The repair accepts only a committed legacy 3/0/0 batch whose three immutable
source IDs match the approved property/room/date/channel tuples. All booking rows
are locked and checked before writes. Compatible existing unpaid opening rows
are preserved; revisions or paid/conflicting decisions stop the entire repair.
The repair writes only opening rows and audit events. It never updates bookings,
batches/results, payments, financial reviews, expenses, receipts or sync state.
Expected eventual totals: 17 bookings, 1 batch, 1 result, 3 unpaid opening rows.

## Schema prerequisite discovered after corrective function installation

Staging has the older opening-position table. Follow
`docs/opening-position-schema-alignment.md`: apply 240002, verify columns, run
rollback tests, confirm 17/1/1/0, then authorize a protected MFA repair action.
Do not reapply 240001 or retry the import. The sequence below describes its original
installation only.

## Later manual staging steps — separate authorization required

1. Confirm SQL Editor is BSTE Operations Staging (never production). Save current
   schema/function diagnostics and counts. Check migration 240001 has not already
   been applied by inspecting its new columns/functions; do not blindly rerun it.
2. Run the complete corrective migration once in SQL Editor. Verify completion,
   new function definitions and service-only apply / authenticated-only repair
   grants. No repair is invoked by this script.
3. Run complete transactionally rolled-back SQL test files:
   `tests/operations-rls.sql`, `tests/operations-dashboard-rls.sql`,
   `tests/stay-finances-rls.sql`, `tests/historical-backfill-rls.sql`, and
   `tests/opening-period-correction-rls.sql`. Stop at any error; roll back an open
   failed test transaction. Verify no test accounts or fixtures remain.
4. Stop for approval before touching the three real opening positions.
5. The repair RPC must be invoked with Bond/Leah's real, live Administrator AAL2
   session and the exact existing batch UUID plus a reason. A normal SQL Editor
   connection has no Supabase Auth user and will correctly be rejected by this
   function. Do not fabricate JWT claims, impersonate a staff member, copy tokens
   into SQL Editor, or grant the importer repair authority. A protected local
   MFA-cookie repair action is a separate next step, not included here. No new
   preview or Beds24 call is needed for repair.
6. After that separately authorized repair, verify 3 created/0 preserved/0 settled
   (rerun: 0/3/0), all unpaid/open, and unchanged original bookings/batch/result,
   finance records and normal sync. Do not record received funds in this repair.

Migrations 230001/230002 were manually applied through SQL Editor. Staging has no
`supabase_migrations.schema_migrations` table. Do not invent CLI migration history
or create that table. Record this corrective migration's manual execution in the
same change log when it is actually applied.

Local Node/static checks do not execute PostgreSQL or prove staging RLS behavior.
The SQL regression scripts must pass in isolated staging after applying the new
migration, before authorization of a real repair.
