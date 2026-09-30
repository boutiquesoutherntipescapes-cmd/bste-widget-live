# Historical direct booking — staging only

This local workflow records the approved Charl Baard stay without fabricating a Beds24 reservation. No booking has been created by the local implementation.

The canonical existing Kalaya property slug is `kalay-ridge-villa-struisbaai` (not `kalaya-ridge-villa-struisbaai`). Property/room IDs remain property mapping metadata, not a claim that Beds24 contains this reservation.

Apply `202609260001_manual_historical_direct_bookings.sql` only in isolated staging after review, then run the rollback SQL test. Neither has been executed by the agent. Existing applied migrations are unchanged.

The new source_kind is manual_direct, the Beds24 booking ID is NULL, and reference BSTE-HIST-202609-KAL-01 is unique within the manual source namespace. Existing rows remain beds24. Manual rows cannot be updated/deleted by the importer. They have no import timestamps, no automation enrollment and no source financial snapshot.

After database validation and separate authorization, restart the local HTTPS runner and sign in as MFA Administrator. Open https://localhost:3443/staff-historical-direct.html. Its first action is a read-only preview. Review any overlapping stays before checking the confirmation boxes. Creation uses a narrowly scoped RPC, a session-bound 25-minute preview, and server-side fixed approved fields. Unknown request fields are rejected. No ID/passport number is accepted. Unprovided contact details/children remain unknown.

Overlap acknowledgement is audited; overlaps are never changed. An uncertain outcome stops further execution: inspect staging before restarting or trying again. Reruns return the same record. Later corrections require a separate audited workflow; this path does not offer arbitrary editing.

September finance includes bookings by checkout month regardless of source. Existing UUID-linked rate reviews, cleaner costs, expenses, private receipts and funds-received reviews work for this booking. Creation records none of those financial facts. Owner/cleaner obligations are not marked settled, and no existing opening position is touched. Funds received must be recorded separately with evidence. Existing monthly payout restrictions remain in place.

The local page/endpoint are not deployable API routes. Normal Beds24 sync never calls this RPC. Source environment production means a genuine source record inside the isolated staging database, not permission to access a production project.
