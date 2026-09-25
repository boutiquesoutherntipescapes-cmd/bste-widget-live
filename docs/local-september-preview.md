# Local September preview

This interface is local only. It is not a deployed API or public asset. Nothing runs when the page opens.

After Bond authorizes a live preview:

1. In a terminal, change to `/Users/blfmastermac/Developer/bste-widget-live`.
2. Start (or restart) the existing local HTTPS runner with `node --env-file=.env.staff.local scripts/staff-staging-server.mjs`. Use the existing trusted localhost TLS certificate and isolated staging configuration. Do not paste or add a staff JWT to the environment file.
3. Open `https://localhost:3443/staff-login.html`. Sign in as Bond with the existing password and authenticator code if needed.
4. Open `https://localhost:3443/staff-september-preview.html` in the same browser.
5. Press **Run September Preview** once. The page makes one POST to `/local/september-preview`. The button remains disabled after success or failure. Reload only to deliberately authorize a new attempt; there are no background retries.

The server reuses the HttpOnly cookie, verifies the live staff session/MFA and Administrator role, and requires both `sync.run` and `finance.read`. It accepts only HTTPS loopback requests on the exact localhost origin, with isolated staging configuration and no Vercel environment. No staff token is returned or shown.

The preview uses GET-only data access to staging booking snapshots and Beds24 bookings. Existing session verification also calls the read-only `ops_staff_access` permission function via POST; this is not an application-data write. Fresh sign-in/MFA can create normal authentication/session audit activity, independently of this preview. The preview never records batches, imports bookings, settles stays, changes normal sync state, or sends communications.

Records use masked booking IDs plus a deterministic distinguishing tag. Names, contact details, raw financial values, private source payloads and auth credentials are excluded. Raw status/channel labels are displayed only for recognized safe values; unrecognized free text is redacted and requires review. Differences show field names rather than private before/after values.

Totals include duplicate source occurrences, with a separate unique-booking count. Invalid source records are shown for review; their storage status can be unknown. Opening-period eligible means checkout before/on the cutover, never proof of channel funds or owner/cleaner settlement. The three Bond-confirmed September stays have funds received and both obligations outstanding. Duplicate/conflicting identities and invalid/non-guest statuses are flagged for opening-period review.

There are no import, apply or settlement controls. A failed preview returns a fixed error, not provider details. The existing CLI is unchanged and still needs a securely provisioned staff token; use this browser interface instead.
