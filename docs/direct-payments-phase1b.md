# Phase 1B — local quote and sandbox preparation

No migration applied; no external provider calls or data writes performed during implementation. Phase 1A and the manual-direct baseline remain applied and unchanged.

## Authoritative pricing

`lib/direct-pricing.js` is shared by quote/search/suggest and the preparation service. Every night uses the existing Easter-shoulder rule and UTC calendar dates; charges are integer cents. Current configuration remains unchanged (R6,000 low, R7,000 shoulder, R8,000 high and R1,000 cleaning for each existing villa). Guest rates are not owner entitlement rates. Minimum stay is the strictest applicable seasonal minimum.

Suggestions previously ignored Easter and used local month parsing. They now match quote/search. Cleaning previously selected the maximum fee across all seasons. The new engine selects the applicable season fee; current amounts do not change. Mixed applicable cleaning fees or ambiguous season mappings fail closed instead of inventing policy. Pricing limits stay length to 366 nights as an input/resource guard.

## Internal property rules

`config/checkout-properties.json` records Bond's approved rules: Legacy total 8; Kalaya total 10, adults 6, children 4; Pearl adults-only 8 or family adults 6/children 4. Ctonic is internal key `ctonic-ocean-view-villa`, official name `"C"tonic Ocean View Villa`, address 93 Malvern Drive, Struisbaai, adults-only 10 or family 6+4. checkout_enabled=false; no external IDs/URLs are invented. It is absent from public property search and checkout options. This internal key is not a published listing slug. Existing canonical Kalaya spelling is retained.

## Quote → prepare → status

POST `/api/direct-checkout` supports `action: quote`, `prepare`, `status`; exact configured HTTPS Origin, JSON and disabled-by-default staging checks apply. No staff cookie or broad guest database permissions are used. `quote` validates dates/occupancy/minimum stay and returns a server-HMAC-signed 30-minute quote. Its version hashes pricing inputs, occupancy rules, terms and engine version. Quotes contain no guest PII. No database write occurs until prepare.

Prepare verifies signature/expiry, recalculates against current configuration and SAST date, and rejects changed price/version/schedule/terms. Browser money fields are rejected. Terms must be explicitly accepted; the database records acceptance time. A changed calendar-day schedule requires a fresh quote. A valid duplicate preparation uses the same quote token and UUID idempotency key. After quote expiry the browser must use status to investigate an uncertain existing result before starting a new quote; it cannot blindly replay expired preparation.

Only the server service credential may execute the narrow RPCs. The RPC hard-codes sandbox, locks the idempotency key, fingerprints the complete normalized request, creates a quoted checkout, stores immutable guest/quote evidence, and transitions only to preparing. A reused quote cannot create a second checkout with a different key. Changed guest/dates/occupancy under the same key fails. The RPC transaction is atomic. A failed response must not cause an automatic new-key retry.

Status requires the signed quote bearer capability and checkout UUID. Database stores only its SHA-256 hash and returns no guest PII or internal credentials. Keep the token private; it is not logged, put in URLs, persisted in browser storage or displayed. Status capability lasts until signing-key rotation; production access expiry/retention policy remains a later security decision. Losing the in-memory token requires a future recovery flow, not guessing a booking ID.

## New additive migration

`202609260003_direct_checkout_preparation.sql` adds only direct_checkout_preparations and narrow RPCs. The immutable companion stores first name, surname, email, mobile, normalized request fingerprint, capability hash and priced quote snapshot. No ID/passport, card, CVV, address or unrestricted request payload. No direct table privileges are granted to guest, staff or service roles. Quote snapshot/guest fields cannot later be silently overwritten.

No payment attempts/events/actions, Operations bookings, owner/cleaner settlements or Beds24 references are created. All checkouts stay unprotected/preparing. Phase 1A's disabled-protection gate remains intact. No Phase 1A migration edits.

## UI and configuration

Prototype: `https://localhost:3443/direct-checkout.html` on existing local staging HTTPS runner. It shows nightly prices, total, due-now and balance; the sole submit prepares, never pays. It does not call availability/provider APIs. Existing iCal search is preliminary only. An explicit `data-checkout-mode="prepare"` on a property widget links to the prototype with property/dates; otherwise existing GHL behavior remains unchanged. No embed or production setting was changed.

New names only: BSTE_CHECKOUT_ENABLED, BSTE_CHECKOUT_ORIGIN, BSTE_CHECKOUT_SIGNING_KEY, BSTE_CHECKOUT_TERMS_VERSION, BSTE_CHECKOUT_TERMS_URL. Reuses BSTE_CHECKOUT_HOLD_MINUTES and existing isolated staging Supabase configuration. No values were installed. Missing approved terms version/HTTPS URL blocks quote/preparation. Do not use the outdated rental-agreement page automatically. Explicit fixture terms are used only in tests. Signing material must be securely generated/configured later, never placed in source.

## Validation and release limits

Local tests are mocked and static. The rollback SQL test is prepared for later isolated staging execution, not executed here. Review RPC ownership/privileges and sandbox isolation before applying. No guest-facing enablement until revised rental terms are approved. Phase 1C must supply final live inventory verification and hold; payment and production remain disabled. Before any externally exposed rollout, add durable abuse/rate controls and review capability expiry/recovery and PII retention. No promo engine exists in current pricing: promotion support/grace must be separately implemented before advertising promotional checkout.
