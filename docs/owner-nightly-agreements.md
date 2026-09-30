# Standard and agreed owner rates

Local implementation only. No migration or live finance writes executed.

Apply `202609250001_add_owner_shoulder_and_booking_rate_overrides.sql` only after staging approval, then run `tests/owner-nightly-rates-rls.sql` as a complete rollback test. Existing migrations are unchanged.

Property rate periods accept low, shoulder and high. They supply the standard for each occupied night (arrival included, checkout excluded). Configure coverage for every night before saving. Missing or changed defaults fail closed.

In the financial review, “Owner payout for this stay” shows Date, Season, Standard rate and editable Agreed rate. Apply-to-all fills the individual nightly inputs. Differences need an adjustment reason; a previously recorded reason remains usable for an unchanged agreement. Values are ZAR, stored as integer cents; zero is allowed for a deliberate waived entitlement, with a reason if different from the standard.

No new table is needed: `ops_stay_financial_reviews.rate_nights` is already append-only and audited. Each review stores each night’s rate-period ID, season, default_rate_cents, actual `rate_cents`, is_override, previous_rate_cents and adjustment_reason. Its parent row supplies booking, previous revision, actor, timestamp, unique request key and review reason. Old snapshots are not rewritten. Legacy snapshots remain valid and readable.

Owner gross entitlement = SUM(rate_nights.rate_cents). Approved owner-allocated expenses are then deducted using the existing rules. Agreed rates never change property defaults. Explicit agreements carry forward on later revisions even when standards change; unadjusted nights follow current standards when preparing a new revision. Existing saved reviews always retain their original snapshot. Stale form defaults are rejected, requiring reload.

Saving nightly agreements uses the existing financial review action, permissions, MFA, per-booking lock, idempotency and audit triggers. It does not create a payment, funds receipt or settlement. Other review fields remain independently controlled; changing a rate does not infer funds received. Historical stays use exactly the same editor and authorization.

Local Node tests cover calculations, UI and SQL structure. The new SQL rollback test still requires authorized staging execution; no local PostgreSQL engine is available here.
