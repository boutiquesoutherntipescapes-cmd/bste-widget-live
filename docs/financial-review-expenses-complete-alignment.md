# Financial review expenses-complete schema correction

The real staging rollback identified SQLSTATE 42703 at the review INSERT: expenses_complete is missing from ops_stay_financial_reviews.

Canonical definition: `expenses_complete boolean NOT NULL DEFAULT false` in local 202609230001_stay_finances.sql. There is no field-specific CHECK, foreign key or index. The similarly named monthly reconciliation flag is a different table and its approval CHECK does not apply here. The review is already append-only, audited and protected by financial RLS.

The current local file includes the column, but the exact SQL text originally executed in staging is not available here. Earlier manual SQL Editor installation and source/schema drift are known; the precise omission event is not proven. No applied migration is edited.

The new 202609250002_fix_financial_review_expenses_complete_schema.sql only adds this column. Before changing anything it compares ALL 21 review columns, types, nullability and defaults against the canonical design under a table lock. Other missing/incompatible/extra columns abort the transaction. A present compatible expenses_complete makes a rerun a no-op; a present incompatible column aborts. RLS must be enabled; no policy, grant, constraint, trigger or function is changed.

Existing review fields/history are preserved. Existing rows receive the conservative default false, meaning expense capture is not attested complete. There is no UPDATE, finance RPC, owner-rate change, payment, settlement or opening-position change.

Other staging schema differences cannot be ruled out from the supplied missing-column error alone. docs/financial-review-schema-preflight.sql provides a read-only full-column comparison and current constraints/RLS. The migration enforces its own column comparison, but does not claim that unobserved staging constraints/policies match local definitions.

Next: Bond manually applies this new guarded migration in the isolated staging SQL Editor. If it reports other drift, stop and share the error. After successful application, the separately authorized real Legacy rollback test must succeed with zero persistent changes BEFORE a browser Save is retried. The rollback test now verifies boolean / NOT NULL / false default first, then uses the real RPC, exact eight-night amounts, expenses_complete=false and R28000 owner entitlement, followed by unchanged-row hashes and counts.

Local Node/static checks do not execute PostgreSQL. Staging application and the real rollback test remain pending.
