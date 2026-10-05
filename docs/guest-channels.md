# Airbnb and direct guest communications

Booking.com remains live under its existing approval. Airbnb and direct guest
sending are OFF. Building/deploying this code does not authorize activation.

All three routes use the same seven-message Johannesburg schedule, existing
property templates and environment-only Wi-Fi secrets. Existing stays never
receive historical booking confirmations or missed-message backfills. Cancelled,
blocked, inquiry and request bookings cannot dispatch. Failed/uncertain messages,
sent history and manual skips survive reconciliation. Claimed rows cannot be
re-enabled; a claim now atomically consumes automation_enabled so the guard does
not block the first send. Terminal outcome RPCs require the matching claim token.
Historical manual-direct records remain immutable and excluded from live sending.
Direct reservations must be confirmed in Beds24; no payment status is inferred.

Airbnb uses Beds24 `/bookings/messages`, never a guest email fallback. Its post-stay
message requests an Airbnb review and invites return contact through Airbnb.
Direct stays use Gmail API with the fixed sender and reply address
`boutiquesoutherntipescapes@gmail.com`. The API call targets that mailbox explicitly.
Missing or invalid guest email prevents a database claim. No recipient is accepted
from a public request. Email bodies and Wi-Fi credentials are never saved in the
queue or returned by preview. MIME recipient/header validation prevents injection.

## Verification without activation

Authenticated GET:
`/api/guest-communications-worker?preview_source=beds24&channel=new_channels`

This branch performs only source/storage GETs, does not enroll or mutate the queue,
and cannot dispatch the live worker. Both new runtime switches must remain off.
Responses contain schedules, eligibility counts, recipient availability and render
metadata, never recipient addresses or message bodies. Booking.com's existing
preview retains its stricter all-sending-disabled requirement.

Run JavaScript checks with the exact command in
`.github/workflows/guest-automation-tests.yml`. Run
`tests/sql/guest-channel-safety.sql` using the connected operations staging admin;
its fixtures and temporary switches roll back, with no provider calls.

## Gmail setup still required

Vercel cannot reuse the desktop Gmail connector's private authorization. An owner
of the BSTE Gmail account must authorize an offline Google OAuth client for the
Gmail API `https://www.googleapis.com/auth/gmail.send` scope. Enable the Gmail API
on that Google Cloud project. Keep the OAuth app's publishing/verification state
appropriate for unattended operation; an External app left in Testing can issue
refresh tokens that expire after seven days for Gmail scope.

Store `BSTE_GMAIL_CLIENT_ID`, `BSTE_GMAIL_CLIENT_SECRET` and
`BSTE_GMAIL_REFRESH_TOKEN` as production sensitive environment variables on
**bste-guest-worker-staging**, and redeploy with
`--local-config vercel.guest-worker-staging.json`. Do not put secrets in the repo,
chat or browser URLs. Refresh-token authorization must be for the BSTE address.
This is separate from guest-send approval and does not activate the channel.

After account authorization, complete a deliberately authorized inbox-only
provider test before considering guest activation. The adapter's fixture tests
verify payload/uncertainty handling; they are not evidence of real Gmail delivery.

## Activation only after explicit user approval

Each new route requires TWO independent approvals encoded as switches:

- Database: service-only `ops_set_additional_guest_channel(target_route, true)`.
- Runtime: `BSTE_GUEST_AIRBNB_SENDING=true` or
  `BSTE_GUEST_DIRECT_SENDING=true`, with a redeploy.

Database target routes are `beds24_airbnb` and `direct_email`. The global
`BSTE_GUEST_LIVE_SENDING=true` and live worker mode are still required. Booking.com's
live flag alone cannot permit either new channel. The channel activation RPC
one-way enrolls confirmed/current Beds24 stays and excludes past windows.
Only service role may call it; anon/authenticated roles have no execute access.
Call it with false to stop that additional channel and disable its unclaimed rows.
Turn its runtime switch off too. Do not call any activation RPC during preparation.

Messages due more than 15 minutes ago expire. Each claim is single-use. Network
loss, ambiguous acknowledgements or accepted-provider/storage-finalization loss
retain the claim and require manual review; there are no automatic retries.
Gmail's Message-ID is for traceability and does not guarantee deduplication.
"Sent" means provider accepted, not guaranteed inbox delivery.

Sources: [Beds24 messages](https://wiki.beds24.com/index.php/Messages),
[Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending),
[Google offline OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#offline),
[Airbnb off-platform policy](https://www.airbnb.com/help/article/2799).
