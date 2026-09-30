# OPS-1: daily stay readiness — local staging foundation

Status: implemented locally; migration NOT applied; SQL rollback suite NOT executed. No provider calls or real notifications were made. PayFast work is paused and its uncommitted files are preserved.

## Existing infrastructure reused

- Existing `ops_bookings` UUIDs, raw status/channel, explicit property mapping and separate manual/direct source identities. Source data and original booking terms remain unchanged.
- `requireStaff`, secure HttpOnly staff session, exact Origin checks, isolated staging configuration, real `ops_can()` session/role/MFA checks. Administrator MFA remains mandatory. Existing Operations `operations.write` allows readiness actions; Finance alone has no operations-write permission. Read access uses `operations.read`.
- `ops_events` and its existing audit trigger record revisions; `ops_no_change` protects append-only response history. Checklist information is not a financial record.
- Existing `ops_tasks` remain ad-hoc staff jobs; they lack versioned checkpoint/question responses, deferral and action capabilities, so they are not repurposed or duplicated into a second ad-hoc task system.
- Existing `ops_notes` remain general notes. New notes belong to a readiness response or cleaning arrangement and are audited.
- Existing `ops_communications` schedule/status is displayed read-only. Its delivery-disabled constraint is untouched. OPS-1 does not enroll guest messages or backfill missed communications.
- The older `api/booking-workflow.js` reads Beds24, writes a custom delivery hash back to Beds24 and calls a Google Apps Script webhook. The Apps Script can send manager/cleaner emails and create Calendar events. OPS-1 never calls those paths. Their live activation is unknown; audit overlapping triggers before any future delivery activation.
- Legacy guest capture/widget transport references do not prove a GHL contact/message sync. Readiness shows GHL state as unknown, not successful.
- There is no authoritative per-stay cleaner assignment in the operations snapshot. A finance cleaner supplier is private financial evidence, not permission to assume a current operational assignment. OPS-1 therefore adds an explicit audited cleaning arrangement rather than exposing financial records or inventing a cleaner.

## Data model

New additive migration: `202609280001_operational_readiness.sql`.

1. `ops_readiness_templates`: version, timing and positively phrased question arrays. Defaults are data, not property-specific columns. Later approved configuration can change timings; no public/template editor is exposed now.
2. `ops_readiness_checkpoints`: one booking UUID + checkpoint key + template version; questions stored as structured item objects. Stores due time, source dates, response state, deferred time, date-review flag, revision, actor/source/timestamps and notes.
3. `ops_readiness_responses`: append-only before/after response history. Corrections append another response, never delete the earlier one.
4. `ops_readiness_actions`: private hashed capabilities, actor/session, intended answer, expiry, checkpoint revision and saved replay result. No plaintext tokens are stored. The replay receipt contains response ID, action and revision; associated response notes/history and current-state responses can contain operational or personal information and must be protected accordingly; hashes are deliberately excluded from generic audit logging.
5. `ops_readiness_cleaning`: explicit assigned / not_required / unassigned state, cleaner name when assigned, optional finite zoned completion time, confirmed source dates/property, sticky review flag and actor/time. A not-required decision requires a reason. Changes captured in `ops_events`; no cleaner payment inferred.
6. `ops_readiness_prompts`: stable request UUID, checkpoint/revision/staff/session/environment/cycle, expiry and supersession. Only one active generation per context; three unique answer capabilities per generation.

All new tables have RLS enabled and all direct application-role privileges revoked. Only explicit authenticated RPCs are granted. Every RPC checks the production operations permissions; the private reconciliation helper is not executable by application roles. The API uses the caller's JWT server-side, never a service-role bypass. No financial grants are added.

## Time and response rules

All displayed and calculated calendar times are Africa/Johannesburg (SAST).

| Checkpoint | Default |
|---|---|
| Pre-arrival readiness | Arrival minus 3 calendar days, 08:00 |
| Final arrival check | Day before arrival, 08:00 |
| Arrival-day readiness | Arrival day, 08:00 |
| Departure check | Checkout day, 08:00 |
| Post-clean check | Checkout day, 16:00, replaced by explicit expected cleaning completion when arranged |

08:00 and 16:00 are visible V1 planning defaults, not claims about a cleaner's actual schedule. Confirm these before real notifications. An unassigned cleaner remains an attention item. An assigned cleaner may use the clearly labelled default-derived completion schedule. Intentionally not-required cleaning is a separate, reasoned staff decision, never inferred from a NULL name.

Stored states: pending, complete, needs_attention, deferred, not_applicable. `due` and `overdue` are time-derived display states, not competing stored flags. A deferral is visible before its deadline but not counted overdue. Deferred becomes due at next-day 08:00 SAST; no background write or email job is required. The page updates while idle or when reloaded; a preview/form in use is not automatically replaced.

YES means **every displayed readiness statement is ready/clear**. Questions about defects are phrased “No maintenance issue requiring attention” / “No damage/problem requiring action”, so YES never records a reported defect as resolved by accident. NO marks the checkpoint and its questions needs_attention with an optional issue note. REMIND TOMORROW is unresolved, never ready. Individual item editing is not exposed in V1; the response applies to the displayed checkpoint as a group.

Existing stays can be initialized explicitly from the dashboard. No real booking is initialized by applying the migration. Subsequent booking inserts and relevant source-date/status or operational-review changes reconcile automatically inside the existing database transaction. An unchanged import does not regenerate or duplicate anything.

On first enrollment, checkpoints whose **SAST calendar day** already passed are not applicable: no catch-up prompt is sent or automatically scheduled. Current-day work remains actionable. The database supplies the authoritative eligibility flag. New/confirmed source stays are eligible unless an explicit review_required override exists. Requests need an existing confirmed/checked-in/checked-out operational review. A blocked/cancelled raw source status always vetoes eligibility even with a confirmed override. The shared browser model mirrors this rule and cannot override a database denial. Cancelled/blocked stays cannot receive response actions. Pending work becomes not applicable, with history retained. A cancellation does not erase completed answers.

Date changes update due dates; completed response items/timestamps remain intact and are flagged for review. NO sets a separate persistent issue flag. Deferral and repeated date changes preserve both unresolved issues and existing review warnings. Only an authorized YES explicitly resolves those flags. Cleaning arrangements retain their last confirmed dates and explicit time; a changed stay flags them for review instead of silently replacing the time. Saving a reviewed arrangement clears its arrangement flag; any checkpoint review still needs an explicit readiness response. Default-derived times follow the revised departure. Timestamp input must be finite ISO date/time with an explicit Z or offset; timezone-less and infinite values are rejected. An overdue/conflicting reschedule also needs attention. Revision changes invalidate outstanding action capabilities. No booking or inventory data is modified by readiness code.

## Dashboard and safe simulation

Existing URL: `https://localhost:3443/staff-dashboard.html`.

Daily readiness sits above the existing source/financial sections. Today / Tomorrow / Next 7 Days include both stays and preparation work due in that window. Six cards show arrivals, departures, in-house, next-week arrivals, attention and ready counts. The normal window covers upcoming 30 days and departures from the last 7 days. Independently, unresolved issues, deferred work, schedule/cleaning reviews and incomplete post-clean work remain queryable and visible without an arbitrary age cutoff. Resolved old stays may age out. Counts refer to the loaded scope. Source health remains visible in the existing dashboard notice.

Each stay shows property/guest/channel/dates/nights/status, contact routes, cleaner/time, next saved arrival, checkpoint readiness and history. Response history is per-booking and available to operational staff; wider database audit retains actor names/roles. Finance information is not loaded by the readiness RPC.

Airbnb and Booking.com channel identities count as potential guest contact routes even with missing email/mobile. The label says delivery is not tested. Unknown channels are not assumed supported. Mobile presence does not verify WhatsApp. No live GHL synchronization state is fabricated.

Preview requires an explicit click and generates ONE stay + ONE checkpoint prompt plus three simulation actions. No messages are sent. This is not a zero-write action: the server registers short-lived action hashes and may reconcile changed checkpoint dates. Merely reading the dashboard performs no writes. A simulation changes readiness and audit records only.

Actions are POST-only, exact-origin and JSON protected; there is no state-changing GET or public anonymous URL. Each 256-bit random capability is hashed before persistence, bound to current staff/session, staging environment, checkpoint/revision and intended action, expires after ten minutes and returns an explicit replay flag, minimal original receipt and CURRENT readiness on a same-session replay. A consumed replay performs no reconciliation, response insert or audit mutation, including after rescheduling or cancellation. Forwarding it to another user cannot authorize a change. Tokens stay in browser memory and POST bodies, never URLs, local storage or logs. Repeated preview resolves to the same active generation and action set; it does not append more action rows. Plaintext capabilities are retained only in bounded server memory and the current browser view. Server/cache loss or expiry requires an explicit replacement action, which supersedes the old generation. Revision changes also supersede old generations. No automatic retries. An uncertain save disables that preview's buttons and instructs staff to reload/inspect.

C"tonic remains internally configured but checkout-disabled, with no fabricated channel IDs or listing URLs. OPS-1 does not relax the existing `ops_properties` requirement for Beds24 IDs. A future non-channel property registration change is needed before storing C"tonic bookings; no such records are invented here.

## Future email/GHL boundary (not connected)

`normalizeInternalReply()` uses strict Map allowlists for answers; contact routes likewise reject prototype keys and unknown channels. Replies require staging environment, provider, unique inbound message ID, checkpoint reference, correlation ID and verified authorized staff identity. No subject-only matching.

`lib/readiness-inbound.js` is an unconnected, dependency-injected future adapter. It requires sender verification, authorized correlation and `processOnce`. That callback MUST atomically enforce environment+provider+message identity, reject a changed payload fingerprint, and commit the response and receipt together. Local mocks exercise duplicates/conflicts; there is no persistent inbound ledger or live handler in OPS-1. Implementing and validating that transaction plus provider verification is a prerequisite to connecting transport.

External email links are deliberately deferred. Retain a sign-in requirement and POST confirmation page; do not turn GET links or forwarded emails into broad anonymous database access. Delivery IDs/status and failed-send retry handling must be introduced separately. Review overlap with the older Google workflow before enabling either route. Expired-token cleanup/retention also belongs to that delivery phase.

## Validation and staging gate

- Node tests cover timing, attention/contact routing, authorization, opaque action handling, blocked methods/origins, mocked UI simulation and no automatic retries.
- `tests/stay-readiness-rls.sql` uses random synthetic identities, real session/permission checks, real generation/response functions and the real local importer RPC. It checks manual/OTA generation, repeated sync, all role/table grants, nonstaff/invalid-session denial, YES/NO/defer/corrections, repeated issuance, replay/expiry/session/booking/environment binding, unused-token invalidation, repeated date changes, explicit cleaning states/timestamps, old outstanding visibility and canonical eligibility. Before/after financial fingerprints include existing owner-rate, payment, opening/settlement, finance attachment and reconciliation tables; manual identity and replay audit immutability are checked. Savepoint rollback verifies all readiness/audit contents plus synthetic users, staff and sessions are removed.
- The SQL suite is prepared, not executed locally: no PostgreSQL server/parser is available here. Static checks are not a substitute for database validation.
- Review the new trigger/RPC migration before applying it to isolated staging. The trigger intentionally adds readiness records during future staging imports; it never contacts Beds24 or sends anything. Any trigger failure would roll back that import transaction, which is why rollback SQL validation is required first.
- No environment keys/settings, applied migrations or public property listings were changed.


## Final lookup and historical-window corrections

Ordinary preview resolves the database's current active prompt for the exact checkpoint/revision/staff/session/environment, even when the API proposes an older cached request ID. Explicit replacement retries retain their own request identity. Superseded records remain stored, and their unused actions remain invalid. Server memory only supplies plaintext capabilities for the generation actually selected by the database.

A separate `historical_skip` flag identifies a checkpoint whose window had already passed before it ever became actionable. A correction to another past SAST calendar day keeps that checkpoint not applicable without manufacturing overdue work. Moving its window to today or a future day can activate it; the flag then clears. This rule never suppresses existing NO, deferred or completed work, and cancellation/ineligibility still takes precedence.
