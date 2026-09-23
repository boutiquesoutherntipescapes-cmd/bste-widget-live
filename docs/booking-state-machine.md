# BSTE booking state machine

This document defines the target booking behaviour for `bste-booking-v2`. It is an implementation contract, not a claim that the current application already implements these safeguards.

A booking has two separate states: a **reservation state** describing its inventory commitment, and a **payment state** describing verified money received or owed back. Payment alone does not prove that a reservation is confirmed.

## Scope

The PayFast transactional state machine applies to **direct BSTE bookings**. PayFast is the standard payment method for these bookings, with the controlled manual-payment exception below. OTA/channel bookings and owner stays have separate payment flows; they share inventory safeguards where appropriate, but do not need a BSTE PayFast payment to establish their status. This document does not replace channel-specific payment or cancellation arrangements.

## Which system decides what

| System | Authoritative responsibility |
| --- | --- |
| Beds24 | Inventory and reservation records: whether the accommodation and required preparation dates are protected, held, confirmed, or released. |
| PayFast | Verified facts for PayFast payments and refunds. A browser return or CRM message is not a payment fact. Staff-verified EFT/manual receipts are separately evidenced in BSTE; they must not be represented as PayFast transactions. |
| BSTE application/database | Booking orchestration, approved price snapshots, payment allocation, transaction history, state transitions, deadlines, retries, and reconciliation. Its reservation state must reflect verified Beds24 results. |
| HighLevel | CRM records and guest communication based on BSTE-authorized events. It cannot establish payment success or independently confirm inventory. |

BSTE gives every booking a permanent reference and links it to the Beds24 reservation, payment attempts, PayFast transactions, and operational events. The same references are reused when retrying work.

## Pricing, deposit and balance rules

- BSTE calculates the mandatory reservation total on the server: accommodation, cleaning, and any other mandatory booking charges. Optional extras are accounted for separately. Guest-submitted totals are never accepted as the price.
- Seasonal prices follow the actual stay dates. Price each night under its applicable season, including stays crossing seasons.
- Standard non-promotional quotes are valid for **30 minutes from generation**. Quote validity does not reserve inventory.
- A valid promotional quote receives a **30-minute grace period from quote generation**, even if the promotion expires during those 30 minutes. This price grace period does not reserve inventory or start the payment hold.
- Before creating a hold, revalidate availability and price on the server, honouring any still-valid promotional grace period. Once the provisional hold is successfully created, freeze the final approved price for that payment hold. Store the quote generation time, promotional entitlement/deadline, accepted price, currency, full total, and payment schedule. Later rate or promotion changes must not silently reprice that hold.
- **Recalculate the payment requirement when the provisional hold is created**, using South African calendar dates. More than seven calendar days before arrival, guests may choose **50% deposit (the default checkout option)** or **100% in full**.
- Within the seven-day window, including exactly seven calendar days before arrival, the required initial payment is **100%**.
- The payment requirement is frozen when the provisional hold is created for that hold period, including its one authorized extension. Crossing the seven-day boundary during the hold does not silently change it; a new hold requires recalculation.
- The remaining balance is due by **23:59 SAST on the calendar date seven days before arrival**. Calculate dates in `Africa/Johannesburg`, not by subtracting 168 hours from check-in time.
- All financial calculations use integer cents. When a 50% split produces a half-cent, round the deposit up to the next whole cent and assign the remainder to the balance: `deposit = ceil(total_cents / 2)`; `balance = total_cents - deposit`. For R100.01, deposit is R50.01 and balance is R50.00. Their sum must always equal the exact reservation total.
- The Beds24 booking value always remains the **full reservation total**, even when only the deposit has been paid. Deposit/payment records must not replace that value.
- Balance payments are **not automatically debited**. Send a secure PayFast balance-payment link tied to the existing booking and its verified outstanding amount. A balance payment must not create a new reservation or a new inventory hold.
- PayFast is the standard direct-booking payment method. EFT/manual payment is permitted only as a staff-controlled exception after funds have actually been verified. Record the booking reference, amount, date, payment method, and staff member who verified receipt, together with supporting verification evidence. A guest's payment claim alone is insufficient.

Example: for a R15,000 reservation booked more than seven days ahead, default to R7,500 initially and R7,500 by 23:59 SAST on the balance due date; the guest may instead pay R15,000 immediately. The Beds24 booking value stays R15,000 throughout.

## Reservation states

| State | Meaning |
| --- | --- |
| `quoted` | A server-calculated offer exists. No inventory is reserved and no payment should be collected yet. |
| `preparing` | BSTE is validating the quote and creating/verifying a provisional Beds24 reservation plus required preparation protection. It is not yet safe to offer payment. |
| `held` | The provisional reservation and preparation protection are verified in Beds24. A deadline is recorded and payment may be requested. This is not a confirmed guest stay. |
| `confirmed` | The required payment has been verified and allocated, and Beds24 confirmation and required inventory protection have been verified. A deposit can be sufficient when the payment schedule permits it. |
| `cancelling` | An authorized cancellation or expiry release is in progress. Its intended outcome (`cancelled` or `expired`) and reason are recorded. Inventory release is not yet fully verified. |
| `cancelled` | An explicit cancellation is complete and the Beds24 reservation and BSTE-owned protection have been released as required. Refunds may still be outstanding. |
| `expired` | An unpaid provisional booking timed out or an unused quote expired. Any inventory it held has been verified released. |

### Allowed reservation transitions

Only the transitions below are allowed. Any other transition requires a revised design; a support action must not bypass these rules.

| From | To | Required condition/action |
| --- | --- | --- |
| `quoted` | `preparing` | Guest proceeds with a valid quote; server revalidates dates, capacity, price and preparation rules. |
| `quoted` | `expired` | Quote validity ends; no inventory or payment exists. |
| `quoted` | `cancelled` | Quote is explicitly withdrawn; no inventory needs releasing. |
| `preparing` | `held` | Beds24 reservation and all required preparation protection are verified; payment deadline is saved. |
| `preparing` | `quoted` | Preparation is abandoned or fails, and reconciliation proves no reservation/protection remains. The quote is still valid. |
| `preparing` | `cancelling` | Preparation must be abandoned but partial or uncertain inventory effects require cleanup. |
| `held` | `confirmed` | Required payment is verified and allocated; Beds24 confirmation and protection are verified. |
| `held` | `cancelling` | Guest/staff explicitly cancels, or the hold deadline passes with no verified successful payment and expiry checks succeed. |
| `confirmed` | `cancelling` | An explicit authorized cancellation action is recorded. Overdue eligibility starts on Day 3 unless an active approved arrangement pauses it; a missed revised deadline restores eligibility. Eligibility alone never cancels or releases inventory. |
| `cancelling` | `cancelled` | Explicit cancellation or preparation-abort cleanup is verified complete. |
| `cancelling` | `expired` | The recorded intent is unpaid-hold expiry; release is verified and no payment/release race remains unresolved. |

`cancelled` and `expired` are terminal: they have no outgoing transitions. A later booking requires a new reference, a fresh quote, and fresh inventory checks. Repeated notifications can update transaction history without changing a terminal reservation state.

## Confirmed booking amendments

Confirmed date/property amendments require **BSTE staff approval**; guests cannot self-edit them. Check and protect the new inventory, including buffers, before releasing original inventory. Recalculate the amended stay price and obtain guest agreement to price differences. Additional amounts, credits and refunds remain traceable within the original booking history. Preserve original and amended agreements, staff approval and timestamps. Financial decisions require the permissions below. Do not simulate amendments by silently moving backwards through reservation states.

## Optional concierge and service extras

Optional concierge/services are separate from the accommodation payment obligation. Track each extra separately using statuses such as `requested`, `pending confirmation`, `confirmed`, `paid` and `cancelled`. Weather-dependent extras may remain requested/pending until conditions and provider availability are confirmed. They may be confirmed and charged before or during the stay.

An unpaid or cancelled optional extra never makes accommodation underpaid, prevents accommodation check-in, or puts the booking at risk. Keep its charges, payments and refund history separate. Cancelling an extra does not erase an existing payment; its detailed cancellation/refund terms still need definition.

## Payment states

| State | Meaning |
| --- | --- |
| `unpaid` | No verified successful payment has been allocated. Pending or failed attempts do not count. |
| `deposit_paid` | The required 50% deposit is verified and allocated, but the full total has not been paid. |
| `fully_paid` | Verified allocated payments cover the full reservation total. |
| `refund_required` | Some verified money must be returned or requires a refund decision, such as money received after release, duplicate charges, or cancellation. Record the exact amount, reason, and approval status. |
| `refunded` | All refunds required by the recorded decision have been verified complete. This does not necessarily mean every rand originally paid was refundable. |

### Allowed payment transitions

| From | To | Required condition/action |
| --- | --- | --- |
| `unpaid` | `deposit_paid` | Verified payment meets the deposit requirement for an eligible booking. |
| `unpaid` | `fully_paid` | Verified payment covers the full total. |
| `deposit_paid` | `fully_paid` | Verified balance payment brings the allocated total to the full reservation value. |
| `unpaid` | `refund_required` | Verified money arrives but cannot safely be allocated, including a late payment against a released booking. |
| `deposit_paid` | `refund_required` | Cancellation, an extra charge, or another exception requires refund handling. |
| `fully_paid` | `refund_required` | Cancellation, overpayment, or another exception requires refund handling. |
| `refund_required` | `refunded` | Required refunds are verified complete; recording a refund request is insufficient. |
| `refund_required` | `deposit_paid` or `fully_paid` | Documented reconciliation proves no refund is due and establishes the retained payment coverage, including a cancelled reservation under the approved no-refund rule. This changes only financial status, never a terminal reservation state. |
| `refunded` | `refund_required` | A new, distinct successful payment arrives or another refund obligation is identified. |
| `refunded` | `deposit_paid` or `fully_paid` | An active reservation remains valid after an excess-payment refund, and reconciliation verifies its retained payment coverage. The refund history remains permanent. |

Amounts and individual transactions remain authoritative even when a single summary state cannot express every exception. Track received, allocated, refundable, refunded, and outstanding amounts separately. Unexpected partial payments must be recorded and flagged; do not label them as a paid deposit or confirm a stay until the actual requirement is met. Failed payment attempts do not downgrade previously verified payments.

For a no-refund cancellation, retain the verified payment history and coverage state, and explicitly record refund due as zero with the policy reason. Do not label it `refunded` when no refund occurred. `refund_required` identifies a financial exception or pending decision; it does not authorize an arbitrary amount.

## Approved cancellation and refund policy

- Cancellation **60 or more days before check-in**: refund **80% of gross money actually received for that booking**, not 80% of the full price if only a deposit was received. Do not deduct PayFast transaction fees from this calculation unless rental terms explicitly change that rule.
- Cancellation **59 days or fewer before check-in**: **no refund**, subject only to an explicitly authorized exception. Record the authorizer, reason, and approved amount for any exception.
- Example: if R7,500 has actually been received, a qualifying cancellation at least 60 days before check-in produces a R6,000 refund. Do not calculate R12,000 against a R15,000 reservation total.
- Store the calculation basis, cancellation timing, applicable terms, actual receipts, refund due, and refund status. Repeated processing must not issue the refund twice or disregard refunds already completed.
- Refund processing and reservation release are separate. A reservation can be `cancelled` while a legitimate refund remains `refund_required`.
- These cancellation percentages must not be automatically used to retain money from duplicate charges, overpayments, or failed booking creation. Those are financial exceptions requiring reconciliation, not automatically guest cancellations.
- The effective guest-cancellation timestamp is when **BSTE first receives a clear cancellation request**, using South African time. Written requests use their received timestamp. Phone cancellations must be manually recorded by staff with the request time and a note; also retain the staff identity and record-entry timestamp. Later approval/release delays must not replace the request time.
- Refunds require staff approval under the financial permissions below. Target processing is **within five business days after approval**, through the original payment method where possible. Record approval, processing and verified completion separately; processing is not a guarantee of bank posting time.
- Boundary-day counting, the refund business-day calendar, and fallback when the original payment method is unavailable still need detail. A BSTE-initiated cancellation without a guest request must not fabricate a guest-request timestamp.

## Provisional holds and preparation buffers

1. Validate dates, capacity, minimum stay, server price, and the entire protected date range.
2. Create a provisional reservation using verified Beds24 behaviour that actually removes inventory from sale. A BSTE database row or an assumed Beds24 status name is not enough.
3. **Every BSTE property must protect one night before arrival and one night after checkout for every stay.** This is a global operational rule because BSTE has a small cleaning team and needs sufficient preparation/cleaning time. Never treat buffers as unused inventory to optimize away automatically. Checkout is exclusive for occupied nights: arrival 10 October, checkout 12 October occupies nights 10 and 11; buffers protect nights 9 and 12.
4. This applies to direct bookings, OTA/channel bookings and owner stays. Verify imported-channel enforcement; a missing mechanism is a protection gap, not an exemption.
5. Track which reservation owns each protection. Never clear unrelated owner, maintenance, guest, or manual restrictions when releasing a hold.
6. Enter `held` and offer payment only after reservation and protection are verified. If preparation partly fails, remain `preparing` with a recovery flag until reconciled, or enter `cancelling` for cleanup.

Hold creation must be safe against simultaneous customers. A separate availability read followed by an unchecked write is insufficient. Verify the actual Beds24 conflict-prevention mechanism before implementing this transition.

The online payment hold lasts **30 minutes**, starting only after Beds24 inventory and required protection have been successfully verified. Store the start and expiry timestamps and show the deadline consistently to the guest. Browser refreshes and repeated payment attempts do not restart or extend it. Store instants in UTC and display them in SAST.

**One staff-authorized extension of an additional 30 minutes is permitted**, after rechecking safety. Add 30 minutes to the existing expiry and record the authorizer, safety check, original/new deadline and extension count. No second extension is allowed. It continues the same hold and frozen price/payment requirement; it cannot recreate an expired or cancelled reservation.

The promotional quote's 30-minute grace and the inventory hold's 30-minute clock are separate: the first begins at quote generation, the second after successful inventory protection. A successfully created hold retains its frozen price even when the promotional grace later ends.

## Hold expiry versus cancellation

**Unpaid expiry** releases an abandoned provisional booking; it is not a cancellation of a confirmed stay. It does not trigger cleaner or operations-calendar cancellation messages because those workflows must never have started.

Before expiry, serialize processing for the booking and check both recorded payments and unresolved payment attempts. Reconcile an uncertain payment result rather than treating a missing callback as proof of nonpayment. If PayFast cannot establish the result, flag recovery and alert staff instead of blindly releasing inventory.

Move an eligible unpaid hold to `cancelling` with expiry intent, release its reservation and owned preparation protection, verify the result, then mark it `expired`. Failed or uncertain release remains `cancelling`; it must not be presented as safely reopened. A timeout during preparation also needs reconciliation before any terminal state.

**Explicit cancellation** records who authorized it and why. It uses `cancelling` while release is in progress, then `cancelled`. Any refund is tracked separately under the approved policy and may finish later. A confirmed cancellation can remove operational events and notify staff and guests after verified release. Manual cancellation also automatically produces the Booking Evidence Pack described below.

If a payment is discovered during expiry release, pause the expiry decision and reconcile. Do not move back to `held` or `confirmed` automatically once cancellation/release has begun; resolve the release and financial exception, with a new reservation if needed.

## Late payments against provisional holds

- A payment notification arriving after the deadline must be checked against the actual verified transaction time and the recorded release state. Callback arrival time alone is insufficient.
- If payment succeeded before the deadline, inventory remains protected, and release has not begun, it can be processed normally after verification.
- Money paid after the deadline must not automatically confirm the stay. Keep the payment on record, flag recovery, and require an explicit decision after checking the reservation and inventory.
- If release has begun, or the booking is `expired` or `cancelled`, do not reinstate it. Record the money as `refund_required` for reconciliation. Any replacement reservation needs a new reference and fresh checks.
- A partial or unexpected payment prevents treating a hold as an ordinary unpaid expiry. Record it, retain the financial evidence, and resolve it explicitly.

## Approved overdue-balance process

This process applies to an existing confirmed direct booking, not an unpaid provisional hold. A late balance can be verified and allocated to the existing booking while it remains active; it does not require a replacement reservation.

1. The balance deadline is 23:59 SAST on the calendar date seven days before arrival. If the balance has not been received, mark it overdue without automatically cancelling the reservation. The booking and inventory remain protected.
2. On the **first calendar day overdue**, send **one friendly, helpful balance reminder** with the secure payment link. Invite the guest to contact BSTE if card/payment difficulties or another genuine issue are preventing payment. The tone must be service-oriented, not threatening. Deduplicate the reminder and record its delivery outcome.
3. On the **third calendar day overdue**, the booking becomes **eligible for manual cancellation by authorized BSTE staff**, unless an active approved payment arrangement pauses eligibility. Eligibility is a flag, not a cancellation or release instruction.
4. Only an **explicit manual cancellation action** initiates release of this overdue booking and its inventory. Recheck verified payments and unresolved payment attempts before acting. Complete and verify release through `cancelling` before reporting `cancelled`.
5. **Bond or Leah** may approve a payment arrangement and retain the booking. Record the revised deadline, reason/note, approver and timestamp, plus correspondence and follow-up. An active approved arrangement pauses normal Day-3 cancellation eligibility. If its revised deadline is missed, manual-cancellation eligibility returns; this does not automatically cancel or start another three-day grace period. Preserve the original deadline and arrangement history.
6. A verified balance payment clears the outstanding balance/overdue condition and updates payment status. Do not duplicate the reservation or its operational tasks. If cancellation has already begun, use the cancellation/payment reconciliation process rather than automatically reversing it.

Example: arrival on 20 October gives a balance deadline of 13 October at 23:59 SAST. The first overdue day is 14 October; manual-cancellation eligibility starts on 16 October, the third overdue calendar day. Neither date automatically releases inventory.

## Roles, permissions and check-in payment gate

**Bond and Leah are full administrators.** They may approve financial exceptions, verify manual payments, approve refunds, cancellations and payment arrangements. Future staff accounts use role-based permissions. Guest communication, check-ins, housekeeping coordination, notes and operational tasks may be granted without financial permissions. Financial access is separately controlled and **never granted by default**. Every sensitive action records staff identity and timestamp, plus the relevant reason/evidence.

**No guest receives keys/check-in while a required accommodation balance remains unpaid unless Bond or Leah explicitly approve an exception.** Record who approved it, when and why. A payment arrangement alone is not a check-in exception; optional extras do not affect this gate. OTA balances are assessed through their separate payment flow, not through the absence of a BSTE PayFast transaction.

## Duplicate payments and idempotency

Idempotency means repeating the same message or retrying an operation has the same effect as doing it once.

- Verify PayFast notifications server-side, including authenticity, transaction status, merchant/environment, currency, amount, and association with the intended payment attempt and booking. A mismatch is an exception, not confirmation.
- Enforce uniqueness for each PayFast transaction within its environment/merchant scope. Record and allocate it once, even when multiple callbacks arrive simultaneously.
- Store distinct payment attempts separately. A deposit and balance are separate transactions against the same booking total.
- Staff-verified manual receipts also require durable references, evidence, and duplicate checks. Never record the same receipt again as a new payment or falsely assign it a PayFast transaction ID.
- A repeated notification for the same transaction is acknowledged without another allocation, confirmation, email, or calendar action.
- Two distinct successful charges are real payments, not duplicate notifications. Preserve both; allocate only the amount legitimately due and flag the excess for refund handling.
- Use durable operation references for Beds24 writes. After a timeout, look up/reconcile the original operation before retrying creation. Never create another reservation simply because a response was lost.
- Serialize conflicting confirmation, cancellation, expiry, and payment decisions for the same booking. State checks and database writes must not race.
- Keep an append-only transaction and transition history: previous/new state, booking reference, external IDs, reason, actor, timestamp, and result. Exclude secrets and unnecessary personal data.

## When communications and operations may trigger

| Event | Allowed effects |
| --- | --- |
| Quote only | Quote information and general payment policy through HighLevel. No actionable payment link or collection until inventory is protected; no booking confirmation or operational tasks. |
| Verified unpaid hold | Provisional hold information, its deadline, and payment instructions/link. No confirmed-booking message, cleaner task, check-in task, or operations-calendar event. |
| Verified payment while confirmation is pending | A payment-received acknowledgment stating that reservation confirmation is pending; staff recovery alert. No confirmed-stay operations. |
| Verified transition to `confirmed` | One booking-confirmation event. Create preparation, check-in, checkout, inspection, and cleaning work once. A valid deposit-confirmed booking may trigger these without waiting for the balance. |
| Verified balance payment | Receipt and updated payment status. Do not recreate the booking or repeat cleaner/calendar tasks. |
| First calendar day overdue | One friendly balance reminder with secure link and an invitation to contact BSTE for help; retain booking and inventory. |
| Third calendar day overdue | Mark manual-cancellation eligibility unless an active approved arrangement pauses it. No automatic cancellation, release, or threatening guest message. |
| Approved, verified amendment | Update the existing operational tasks and guest communication using the same booking reference. |
| Verified cancellation of a previously confirmed stay | Remove/update its tasks and issue cancellation communications once. Refund communication must accurately reflect whether a refund is pending or completed. |
| Unpaid hold expiry | Optional hold-expired/payment-link-expired message. No cleaner cancellation or confirmed-booking workflow. |

Persist authorized events for delivery and retry them independently. Notification failure must not undo a real booking or payment. Consumers must deduplicate events. HighLevel and the Beds24-to-Google workflow must obey these gates, including when Beds24 emits intermediate reservation updates.

Cleaner communications contain only operationally necessary information, not guest payment or contact details. **Pre-arrival inspection occurs during the protected pre-arrival period, after the previous guest has departed and preparation is sufficiently complete.** Replace the previous two-days-before scheduling assumption; access must fit the protected period.

## Automated guest communication timeline and routing

Use South African time and the current approved stay dates. These messages apply to confirmed guest stays, not unpaid holds. Amendments reschedule messages; cancellation suppresses future stay messages. Deduplicate delivery. Messages do not override the check-in payment gate.

| When | Message |
| --- | --- |
| Three days before arrival | Full arrival information. |
| Arrival day 09:00 | Short arrival reminder. |
| Arrival day 20:00 | Same-day “settled in okay?” message. |
| Day before departure 18:00 | Full checkout information. |
| Departure day 08:00 | Short checkout reminder. |
| Approximately two hours after checkout | Thank-you message. |
| Following day 10:00 | Review request and direct-booking invitation, subject to channel rules. |

| Source | Communication route and evidence |
| --- | --- |
| Direct BSTE | HighLevel/direct email and WhatsApp. If intended WhatsApp is unavailable or invalid, fall back to email. Evidence comes from connected direct communication systems. |
| Airbnb | Applicable communication through Beds24 to Airbnb messaging; capture or reference Beds24/channel message history. |
| Booking.com | Applicable communication through Beds24 to Booking.com messaging; capture or reference Beds24/channel message history. |
| Other OTA/channel | Beds24/channel messaging where supported; capture or reference connected message history. Unsupported delivery needs explicit handling. |

Do not assume OTA guests have usable personal email addresses. Keep them primarily in their channel conversation unless suitable direct-contact details have been legitimately obtained. Channel rules govern applicable messages, particularly direct-booking invitations. Do not claim messages outside connected/synced systems have been captured.

## Booking evidence and audit trail

Maintain a **durable lifecycle event/audit record from the outset**. Do not wait for a dispute to reconstruct evidence. Preserve accepted rental-terms versions and acceptance details, approved prices, payments, reminders and delivery records, relevant captured correspondence, staff notes and arrangements, state changes, and cancellation actions. Changes and corrections must retain their history.

On an explicit **manual cancellation**, automatically create a human-readable **Booking Evidence Pack**, linked to the booking/contact. Create it when the manual cancellation is authorized, showing any pending release/refund accurately; update or append a version when release/refund results become available. The pack is a readable record of the evidence, while underlying transactional/audit records remain authoritative.

Include:

- Booking reference, guest and property details, stay dates, and agreed price.
- Accepted rental terms/version, acceptance timestamp, and recorded acceptance details.
- Payment history, including verified manual receipts and their verifying staff member, and the balance deadline.
- Reminder communications, send/delivery timestamps, and known delivery outcomes. Distinguish sent, delivered, failed, and unknown; do not invent delivery evidence.
- Captured guest/BSTE correspondence, recorded arrangements, and staff notes.
- Cancellation eligibility date and basis where applicable; identify cancellations for other reasons rather than inventing overdue eligibility.
- Cancellation authorization details: staff member, timestamp, action, and reason.
- Refund calculation, approved exceptions, and refund status, including an explicit zero-refund decision where applicable.
- Inventory-release confirmation, or a clear pending/failed status until release is verified.

Capture correspondence only from connected/synced BSTE communication systems and explicitly recorded staff entries. Direct records use direct communication systems; OTA records capture or reference Beds24/channel history. **Do not claim to capture email or messages outside those systems.** Label gaps and manual notes clearly. Preserve request receipt times, phone cancellation notes, arrangement revisions, approvals and check-in exceptions with staff identities/timestamps. Apply role-based access controls; secrets must not enter the pack. Pack failures require retry and visibility without repeating cancellation, refund or inventory actions.

## Failure and recovery handling

Recovery flags explain outstanding work without inventing a successful state. Each flag needs a timestamp, last error, retry history, and an accountable staff alert when automatic recovery cannot finish.

| Failure | State and safe response |
| --- | --- |
| Beds24 creation response is lost | Remain `preparing` with `inventory_reconciliation_required`. Locate the operation by reference before creating anything else. Do not collect payment yet. |
| Stay protection succeeds but buffer protection fails | Remain `preparing`; repair protection or use `cancelling` to undo owned effects. Do not offer checkout as ready. |
| Payment received but Beds24 confirmation temporarily fails | Record verified payment, keep `held` with `confirmation_pending`, and preserve inventory. Alert **Bond and Leah immediately**. Send a calm guest acknowledgment that payment was received and the reservation is being finalised. Automatically retry/reconcile confirmation for **15 minutes** from the first failure. If still unconfirmed, set `manual_attention_required`. Never falsely confirm, automatically refund, or release inventory solely because confirmation temporarily failed. |
| Paid booking cannot be confirmed because protection was lost | Record an inventory conflict and `refund_required`; resolve the reservation through cancellation/release handling. Never take another guest's inventory or automatically resurrect an expired booking. |
| Beds24 confirmation succeeds but the BSTE database update fails | Recover by matching the durable booking/operation reference and verifying payment facts. Do not create or charge again. Release authorized operational events only once the transition is durably recorded. |
| PayFast verification is unavailable | Keep the prior payment state and record `payment_verification_pending`. Do not infer success or nonpayment from the browser. Pause unsafe expiry decisions and reconcile. |
| Cancellation or expiry release partly fails | Remain `cancelling` with `release_pending`; reconcile all owned effects. Do not claim the dates are reopened. |
| Refund is requested but not verified | Remain `refund_required` with the amount and request reference. Do not tell the guest the refund is complete. |
| HighLevel, email, or calendar delivery fails | Keep the verified reservation/payment states; record `notification_pending` and retry the authorized event without duplicating successful actions. |

`manual_attention_required` is a recovery flag, not an eighth reservation state. The reservation remains `held` with payment recorded and inventory protected until confirmation or explicit authorized resolution. Repeated callbacks do not reset the 15-minute window. Manual recovery must reconcile Beds24 before repeating writes.

Reconciliation compares BSTE, Beds24, PayFast and separately evidenced manual receipts. It identifies stuck preparation, paid-but-unconfirmed stays, overdue balances/arrangements, releases/refunds, undelivered events and incomplete evidence packs. The paid-confirmation escalation is fixed above; limits and alert timings for other failures still need operational agreement.

## Non-negotiable safety rules

1. **Browser redirects never prove payment.** Only independently verified payment facts count.
2. **HighLevel never confirms payment.** It communicates verified BSTE decisions.
3. **Cancelled or expired bookings cannot be resurrected automatically.** New inventory commitments require a new booking and checks.
4. **Unpaid provisional holds do not trigger operational workflows.** No cleaner or confirmed-stay calendar activity.
5. **One PayFast transaction must never be applied twice.** Enforce this in durable storage, including concurrent notifications.
6. **Guest-submitted prices are never authoritative.** Validate the server-approved full total and amount due.
7. **Sandbox payments must never affect production Beds24 inventory.** Separate credentials, records, callbacks, and test inventory, and reject environment mismatches. Do not test hold creation against live inventory either.
8. **Payment success and reservation confirmation are separate facts.** Both required conditions must be verified before claiming a confirmed stay.
9. **Beds24 booking value always remains the full reservation total.** A deposit does not reduce that value.
10. **Unavailable or uncertain inventory is never advertised as verified availability.** Missing data is not an empty calendar.
11. **Release only protection owned by the reservation.** Preserve unrelated restrictions and shared preparation requirements.
12. **Retries must not create another booking, charge, allocation, refund, or operational task.** Reconcile uncertain results before retrying effects.
13. **Overdue eligibility never cancels a booking.** Only an explicit authorized manual cancellation initiates release for overdue balances; arrangements may retain the booking.
14. **Manual payment exceptions require verified funds and accountable records.** Neither a guest assertion nor HighLevel status is proof of receipt.
15. **Evidence is collected throughout the lifecycle.** A generated pack must not fabricate missing communications, acceptance, payment, or release evidence.
16. **Global preparation buffers must not be optimized away.** Protect every property and every stay.
17. **Optional extras cannot jeopardize accommodation.** Keep their payments and status separate.
18. **Financial access is never a default staff permission.** Sensitive actions identify staff and timestamp.
19. **Unpaid required accommodation blocks check-in unless Bond or Leah explicitly approve an exception.** Record who, when and why.
20. **Temporary confirmation failure never automatically refunds or releases a paid hold.** Alert Bond and Leah immediately; retry for 15 minutes, then require manual attention.

## Remaining business decisions

The rules above are approved, including 30-minute standard quotes/holds and one additional 30-minute extension, frozen hold payment requirements, guest-request cancellation timing, gross refunds and five-business-day target, deposit rounding, separate extras, staff-approved amendments, global buffers, administrator roles, arrangements, check-in gate, 15-minute recovery and guest communication routes/timeline. Do not reopen them as unspecified policy. Remaining details are:

- Refund rounding to whole cents; calendar-day versus exact-time counting at the 60-day cancellation boundary; the refund business-day calendar; fallback when the original payment method is unavailable; effective timing for BSTE-initiated cancellations without a guest request.
- Extra cancellation/refund/provider terms; exceptional duplicate/overpayment/failed-booking refunds and possible reallocation to replacement bookings.
- Resolution deadlines/staffing for late, partial or uncertain payments and other failures, plus manual response expectations after the fixed 15-minute retry window. Whether an arrangement changes a not-yet-sent Day-1 reminder; its pause of Day-3 eligibility is settled.
- Recovery of `cancelling` before release completes and the terminal resolution for payment discovered during expiry release. Until defined, pause and reconcile rather than invent transitions.
- Amendment-related payment deadlines, credits/refunds and recalculation of payment coverage after a price change. Approval, repricing and guest agreement are settled.
- Whether adjacent stays can share a buffer night while fully satisfying each mandatory before/after buffer, and handling of existing channel conflicts. No option may eliminate the global buffer rule.
- Original balance-link timing, pre-deadline reminders and hold-expiry messages; exact time for three-days-before arrival information, catch-up for last-minute bookings, and scheduled versus actual checkout for relative messages. Fallback when both direct contact methods or channel delivery are unavailable.
- Evidence retention, pack storage/recipients, legacy evidence gaps and specific future-role/extension permissions. Bond and Leah's financial authority and no-default-financial-access rule are settled.

## Technical verification before implementation

- Verify Beds24 provisional status, conflict prevention under concurrency, confirmation, release, buffer ownership, and ability to maintain protection during reconciliation/one authorized extension. Confirm all property mappings and imported-channel protection behaviour.
- Verify PayFast notification authenticity, transaction-time evidence, refund evidence, reconciliation and secure balance links; map the existing HighLevel handoff and prevent duplicate communications. Verify how manual receipt evidence is stored and deduplicated separately.
- Verify Beds24 channel messaging support/restrictions and accessible message/delivery history. Verify direct WhatsApp validation and email fallback; never assume OTA personal email availability.
- Verify durable transition locking, event delivery, audit storage, rental-terms version capture, reminder deduplication, and evidence-pack generation/versioning. Confirm connected communication sources and actual delivery-status visibility; do not assume all email is synced.
- Verify role-based financial enforcement, approval identity/timestamps, arrangements and check-in exceptions; operational permissions must not bypass financial controls.
- Verify South African date boundaries, grace/hold/extension clocks, frozen price/payment requirements, integer-cent calculations, arrangement-aware eligibility and guest-message scheduling. Verify amendments preserve new inventory before releasing old protection and retain financial history.
- Verify immediate alerts to both administrators, the 15-minute retry window and durable manual-attention flag without paid-inventory release/refund. Verify optional-extra isolation and global buffer enforcement.
- Establish isolated test inventory and payment environments. Test concurrent bookings, duplicate callbacks, manual receipt duplicates, late/partial payments, cancellation/payment races, outages, recovery, and evidence-pack failures before production writes.

This document records approved business decisions but does not claim that the published rental terms or deployed workflows have already been updated to match. Verify that alignment before rollout.
