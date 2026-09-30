# Direct payments Phase 1A — local foundation only

No migration applied; no PayFast/Beds24 calls, booking creation or communications. The manual-direct baseline is complete as confirmed by Bond and is not reopened here.

Four additive tables: direct_checkouts (immutable quote/agreement and reservation state), payment_attempts (expected charge and initiation identity), payment_events (append-only typed verification facts), checkout_actions (one durable job per checkout/action). Existing ops_bookings is linked only after source identity/environment/date checks; historical manual-direct records are not repurposed.

All four tables have RLS. Anonymous and service roles have no direct access; authenticated Finance/Admin users may read only through existing finance.read and MFA/session checks. No role receives a write RPC in this phase. Future provider processing must use narrow, reviewed RPCs; do not grant generic service table writes. Database owners remain migration/test authority, not application credentials.

Schedule: more than seven SAST calendar days means ceil(total cents / 2) now; seven or fewer means full total. Balance date is arrival minus seven days at 23:59 SAST. Recalculate at hold preparation. Because quote money/schedule fields are immutable, changed terms require a new checkout/version rather than mutating an agreement. Store versioned quote/terms acceptance references; no guest identity documents, card data or unrestricted JSON provider payloads.

BSTE_CHECKOUT_HOLD_MINUTES is the only new environment variable; default 30, validated as integer 1–1440. Capture chosen duration on the checkout. Clock starts after verified protection; payment starts immediately. No refresh or automatic extension. Staff-authorized extension support remains a separate future audited action.

Reservation: quoted → preparing/expired/cancelled; preparing → held/quoted/cancelling; held → confirmed/cancelling; confirmed → cancelling; cancelling → cancelled/expired. Terminal states cannot resurrect. review_required/recovery_code are separate. Transition graph is not provider proof: future RPCs must verify inventory, payment and release evidence before changing states.

Attempt: created → pending/failed/cancelled/review; pending → verified/failed/cancelled/review; review → verified/failed/cancelled. Verified requires an accepted event. Failed/cancelled attempts receiving late success need an explicit reconciliation design; they must not silently reopen bookings.

Actions: pending/retry → running/review; running → retry/succeeded/review; review → retry. Reuse the same action row/key for retries; retain state/retry changes in existing ops_events through the new audit trigger. No worker or scheduler exists yet.

Payment facts use accepted/rejected/uncertain plus normalized provider status. Payment projection (awaiting, deposit/partial, fully paid) will be derived from accepted amounts, never balance_due or browser return. Refund status is reserved but a CHECK prevents refund recording in Phase 1A. Provider/environment/merchant transaction uniqueness prevents double allocation across attempts. Rejected events do not consume accepted receipt identity. No existing manual receipts, financial reviews, owner/cleaner amounts or opening positions are written.

Before staging: review the additive migration and run the rollback SQL regression in isolated staging after separate approval. Local Node tests include static SQL assertions, not PostgreSQL execution. Later phases must add evidence-gated RPCs, action lease enforcement, rate limiting, and sandbox Beds24 mapping allowlists before any external write capability is enabled.

## Corrections before staging

Unapplied migration: `202609260002_direct_checkout_foundation.sql` (renamed from the future-dated draft; no applied migration edited).

Projection now takes explicit checkout ID, environment, provider and merchant scope, plus the selected attempts and events. Every fact must resolve through a same-checkout attempt. Mixed scopes fail with `PAYMENT_SCOPE_MISMATCH` and `reviewRequired=true`; no partial success is returned. Repeated identical accepted transactions count once; conflicting allocations fail with `PAYMENT_FACT_CONFLICT`. These are safe codes for future audit/recovery callers; the pure function writes nothing.

Hold timestamp input must be a valid Date or explicit zoned timestamp string. Missing, empty and invalid input fails. SQL requires both timestamps or neither, with positive configured duration. Quoted/preparing records can have neither.

Beds24 reference/timestamp fields remain UNTRUSTED pending metadata. inventory_scope is derived from environment. protection_verified is permanently false under the Phase 1A CHECK, so no held/confirmed record is possible yet, regardless of reference values. Phase 1C must explicitly replace that gate only alongside narrowly authorized RPCs that verify environment-specific allowlisted inventory. No allowlist, external call or verifier is added here. Valid pending timestamps can be tested on preparing records; they do not constitute a verified hold.

The strengthened SQL suite uses generated IDs and references. Its temporary manifest and baseline exist before a fixture savepoint. After ROLLBACK TO SAVEPOINT, it verifies every fixture identity and unchanged baseline, then final ROLLBACK removes the temporary harness too. Run the complete file only in isolated staging after authorization. Audit-function owner/security configuration is reported by catalog inspection. Database SQL remains unexecuted locally.
