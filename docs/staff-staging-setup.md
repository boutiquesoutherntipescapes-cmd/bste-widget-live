# BSTE Operations Staging: staff access and recovery

## Current status

Bond reported on 21 September 2026 that the existing foundation migration and rollback security tests passed in the isolated **BSTE Operations Staging** project: all 11 operations tables have RLS/policies, and no test staff, bookings or Auth users remain. This task does not reapply or change that migration. No new migration is needed for enrollment.

The local app supports password sign-in, first-time Supabase TOTP enrollment, six-digit verification, existing-factor challenge and provider logout. Privileged access still requires AAL2 in the server and the already-applied database policies. The dashboard itself and Beds24 importer are not part of this step.

## Configure the local staging app

1. Open the Supabase dashboard and explicitly select **BSTE Operations Staging**. Check its project reference before copying anything. Copy its project URL and **publishable key** (or legacy **anon public** key) from the project's connection/API settings. Never copy a secret/service-role key. Do not use the production project's values.
2. In the repository root, copy `.env.example` to `.env.staff.local`. This new local file is ignored by Git. Leave existing `.env` / `.env.local` files alone. Replace only these placeholders:
   ```dotenv
   BSTE_STAFF_SUPABASE_URL=https://YOUR-STAGING-PROJECT-REF.supabase.co
   BSTE_STAFF_SUPABASE_PUBLIC_KEY=YOUR-STAGING-PUBLISHABLE-OR-ANON-PUBLIC-KEY
   ```
   Keep `BSTE_STAFF_ENV=staging` and `BSTE_STAFF_ORIGIN=https://localhost:3443`. Staff code requires these dedicated URL/key settings; it never falls back to the owner portal's shared `SUPABASE_URL` or keys. The operator must verify project identity; the app cannot independently infer a project name from its URL.
3. Prepare a local HTTPS certificate for `localhost` so Secure cookies stay enabled. If no trusted development certificate already exists, the following uses an existing OpenSSL installation (it installs nothing):
   ```sh
   mkdir -p .local/staff-tls
   openssl req -x509 -newkey rsa:2048 -sha256 -days 30 -nodes \
     -keyout .local/staff-tls/localhost-key.pem \
     -out .local/staff-tls/localhost-cert.pem \
     -subj '/CN=localhost' \
     -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
   chmod 600 .local/staff-tls/localhost-key.pem
   ```
   The certificate directory is ignored by Git. Trust **only this locally generated certificate** for localhost using macOS Keychain Access before entering credentials. If the installed OpenSSL lacks `-addext`, obtain a localhost certificate through the approved local development setup instead; do not turn off Secure cookies or TLS verification. Certificate generation/trust was not performed by this task.
4. With Node 22 or later, start the staff-only local runner from the repository root:
   ```sh
   node --env-file=.env.staff.local scripts/staff-staging-server.mjs
   ```
   It binds only to `127.0.0.1:3443`, requires the staging marker and serves only the login page/script and staff-session endpoint. It does not load `.env.local`, booking endpoints, crons, owner APIs, Beds24 or communications. Existing exported environment variables take precedence over the env file in Node: use a clean terminal without conflicting `BSTE_STAFF_*` settings. No package installation or Vercel linking is needed.
5. Open `https://localhost:3443/staff-login.html`. Resolve any certificate warning before entering credentials. The local runner does not contact Supabase until a staff authentication request is made.

## Create Bond's first Administrator account

Perform these steps only in **BSTE Operations Staging**; none were executed by this task.

1. In Supabase Auth settings, confirm email/password sign-in and TOTP MFA are enabled. Keep phone MFA disabled for this staff project; this UI supports TOTP only. Disable public user sign-ups for this staff-only environment. Retain provider rate limits. No mail/invite is required for this setup.
2. Under Authentication → Users, use **Add user / Create user**, not Invite. Enter Bond's verified email and a strong unique password through the dashboard (not SQL, source code, chat or a shell command). Use the confirmed-email option only after verifying the identity/address directly. Record the resulting Auth user UUID.
3. In the staging SQL editor, replace the placeholder below with that UUID, verify the project again, then run:
   ```sql
   insert into public.ops_staff (user_id, display_name, role, is_active)
   values ('REPLACE-WITH-BONDS-AUTH-UUID'::uuid, 'Bond', 'administrator', true);
   ```
   This is a staff-provisioning operation, not a migration. Do not rerun it blindly or use a role in Auth user metadata. Confirm there is exactly one correct record:
   ```sql
   select user_id, display_name, role, is_active
   from public.ops_staff
   where user_id = 'REPLACE-WITH-BONDS-AUTH-UUID'::uuid;
   ```
4. Sign into the local page with Bond's credentials. Password-only access offers authenticator setup and cannot access operational data. Choose **Set up / restart authenticator**, scan the QR code in Bond's authenticator app (or enter the setup key manually), and enter the current six-digit code.
5. Only successful Supabase verification followed by the database AAL2 check enables staff access. Sign out, sign in again, and confirm that it now asks for an authenticator code without another enrollment. Check a wrong code is denied. The initial setup cookie expires within five minutes; sign in again if it expires.
6. Repeat separately for Leah, with her own email, Auth UUID, password, authenticator and `display_name='Leah'`, role `administrator`. Finance accounts use `finance` and also require MFA. Never share accounts, authenticator seeds or passwords.

A setup restart deletes only **unverified TOTP factors named `BSTE staff TOTP`** owned by the signed-in user. It cannot replace a verified factor at AAL1. After a refresh, sign in again and restart unfinished setup if necessary, then scan the newly generated code. Multiple tabs can invalidate unfinished setup; use one setup tab. Successful verification, sign-out, page exit and a five-minute display timer clear the setup secret from the page. The QR/secret is necessarily shown to the enrolling user over HTTPS; it is never stored in browser storage, logs, URLs or application database tables. Responses are not cached.

## Recovery: staff-assisted, no bypass

The login page explains this path; it does not send an email or perform an automatic factor reset. A valid alternate enrolled TOTP factor can be selected in the normal challenge screen. Without one, stop and use the following controlled process.

1. Contact another known BSTE administrator through an independently known number or in person. A newly supplied phone number, email access, password knowledge or an emailed document alone is not sufficient. The requester must not approve their own recovery. If Bond and Leah are both locked out, the designated Supabase project custodian must handle the case using their separately protected project account. If no trusted approver/custodian is available, leave access blocked.
2. The authorized project custodian identifies the exact Auth UUID and suspends `ops_staff.is_active` before resetting anything. Record the reason, requester, approving person, custodian and timestamps in BSTE's restricted recovery incident record. Staff activation changes already enter the database audit. Do not put passwords, setup keys, identity-document copies or MFA codes into audit notes.
3. Independently verify identity and approval. Use Supabase's supported project administration tools / Auth Admin API in a trusted administrative environment to reset the password, terminate the user's existing sessions and remove the lost factor(s). Do not delete/recreate the user: keep the same UUID and audit history. Do not edit the `auth` schema directly, disclose a service-role key, or build these actions into the public staff endpoint. **Confirm session termination actually succeeded before reactivation**. If the available administrative interface cannot prove revocation, stop and have the project custodian resolve it using supported tooling.
4. Issue the replacement password privately to the verified person, keep their privileged role and all MFA policies unchanged, and reactivate the same staff record only for supervised re-enrollment. Never temporarily assign Operations to bypass MFA, change the database assurance requirement, or mark a factor verified manually.
5. The recovered person logs in with the new password, enrolls a fresh TOTP authenticator and verifies it. AAL1 remains blocked throughout; AAL2 is required again. Verify that old credentials, old sessions and the lost factor no longer work. Close the recovery incident with the result and provider audit references.

The recovery custodian, independent identity-check procedure and protected incident-record location must be designated before staff rely on this environment. This is a documented manual recovery path, not a self-service recovery/reset feature. No administrator/service key is needed by the local app.

## Verification still required in staging

Local tests mock Supabase; no live enrollment or recovery was attempted. Test real enrollment/QR scanning, wrong-code retry, return login, five-minute setup expiry, AAL1 denial, AAL2 access and logout in the isolated project. Confirm provider MFA rate limits and the actual recovery administrative tools before staff trials. The previous successful SQL suite validates the existing database foundation; it does not prove the new browser/Auth flow. No bookings or communications are needed for these tests.

References: [Supabase TOTP enrollment and challenge](https://supabase.com/docs/guides/auth/auth-mfa/totp), [Auth REST API including administrative factor removal](https://github.com/supabase/auth/blob/master/openapi.yaml), [session termination and session validation](https://supabase.com/docs/guides/auth/sessions).

## Staging migration record — manually applied through SQL Editor

Bond reports that `202609230001_stay_finances.sql` and `202609230002_september_backfill.sql` were successfully applied through the authenticated **BSTE Operations Staging SQL Editor**, not Supabase CLI. This project has NO `supabase_migrations.schema_migrations` table. Do not infer unapplied migrations from absent CLI history, do not blindly rerun these SQL files, and do not create a history table merely to resolve this difference. Inspect actual schema/functions when checking installation.

Bond verified: 14 bookings; zero historical batches/results/opening positions; finance and backfill RLS tests passed; private receipt bucket verified; no persistent test data. These are user-reported staging results, not fresh external verification by the local harness implementation. No migration changes accompany this harness.
