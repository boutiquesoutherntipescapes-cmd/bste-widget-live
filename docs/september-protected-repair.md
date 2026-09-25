# Local staging September repair

This page does not run the historical import or contact Beds24. No migration is added.

Restart the local HTTPS server, sign in as an active Administrator with TOTP MFA, then open https://localhost:3443/staff-september-repair.html. Opening the page requests a read-only staging preview. It requires sync.run, finance.read, finance.write and finance.cutover. The HttpOnly session cookie is never exposed to JavaScript.

Review the batch UUID and three properties/dates/channels. Check the unpaid-obligations confirmation and press the single repair button only when authorized. The server uses the existing ops_repair_september_openings RPC with the staff session and a fixed reason. No service-role key is used.

Preview approval is bound to the same user/access session for 25 minutes. The server re-reads the records before execution. It refuses changed identities, unexpected opening decisions, non-legacy batch results, or counts other than 17 bookings / 1 batch / 1 result and 0 or 3 compatible openings. The database RPC remains the transactional authority for identity locks, administrator authorization, audit attribution and idempotency.

SUCCESS requires a fresh server-side read of 17 / 1 / 1 / 3, all three openings open/outstanding with zero paid amounts, and unchanged bookings/batch/result. No funds-received, payment, settlement, expense or receipt function is called. Already-complete state is verified without another write.

If a dispatched request or verification is uncertain, stop and inspect staging. The server blocks further preview/repair attempts for that process. Do not restart the server to clear that guard or retry blindly. A browser network failure similarly disables further execution. No automatic retry occurs.

The route and assets exist only in scripts/ and the local staging HTTPS server, never the deployable API/public directory. Local/mock tests do not certify live staging state; Bond must review the preview before authorizing execution.
