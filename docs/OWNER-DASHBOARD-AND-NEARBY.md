# Android fixes and owner dashboard

The Android changes make the room tabs and chat share one vertical page scroll. Sideways swipes still move through tabs. Play Close starts with Create a room / Join a room. Join asks for a name and a six-character nearby code, then uses Android network service discovery on the local Wi-Fi/hotspot. It makes no cloud lookup. Networks that block multicast/discovery can still use the full invite under **Invite link / discovery help**. Browser and Windows guests continue to use an invite; browsers cannot resolve Android mDNS services themselves.

Nearby discovery advertises the room code and public pairing details to the local network. Use a trusted Wi-Fi/hotspot. Certificate pinning verifies the discovered certificate for the subsequent TLS connection; discovery is not proof of the host's identity against a hostile LAN. Existing invites supply the out-of-band alternative. Leaving or ending the hosting session unregisters discovery and closes the local host.

## Enable your private dashboard

The dashboard is at `/admin` after deployment. It is disabled until an owner identity and authenticator key are provisioned. No owner credentials or default password are embedded in the APK or browser.

1. From your trusted operator terminal, set the deployment's `DATABASE_URL`, `ADMIN_SETUP_EMAIL` and a strong unique `ADMIN_SETUP_PASSWORD` in the process environment. Do not put secrets in command-line arguments, Git, screenshots or chat.
2. Run `node ops/provision-owner.mjs`. It migrates the database, hashes the password with the existing scrypt policy, provisions one account, and prints its owner ID and a new random authenticator key. Existing accounts require the explicit `ADMIN_SETUP_REPLACE_EXISTING=1` switch; that resets their password and revokes their sessions.
3. Add that key to your authenticator using manual setup: SHA1, 6 digits, 30 seconds. Store a recovery copy in your password manager.
4. Set `ADMIN_OWNER_ID` and `ADMIN_TOTP_SECRET` in your deployment's secret settings. Keep `NODE_ENV=production`, `SESSION_COOKIE_SECURE=1`, the exact HTTPS `ALLOWED_ORIGINS`, proxy settings, database URL and metrics secret configured as required by the existing server.
5. Deploy this code, then visit your HTTPS site at `/admin`. Sign in with the provisioned email, password and fresh authenticator code. Confirm a second browser without this session cannot read `/api/admin/analytics`.
6. Clear `ADMIN_SETUP_PASSWORD` and setup-only environment values from your terminal. Do not retain the authenticator key in terminal logs. To recover lost MFA, rerun operator provisioning and update the deployment key; restart the server to invalidate all owner sessions.

Only the configured account ID with a database admin role can use this dashboard. Other registered accounts, a different admin account, an ordinary account cookie, or knowledge of the dashboard URL cannot grant access. Fresh TOTP counters are consumed atomically in the database to prevent replay across restarts. Login is rate limited; sessions use a separate HttpOnly, SameSite=Strict, Secure cookie, a 15-minute idle timeout, and a one-hour absolute timeout. Every data request rechecks the account role/revocation. POST operations require the exact allowed origin. Dashboard assets have a restrictive CSP, no third-party scripts, no framing, no indexing and no cache. Login and data access are audited without logging credentials.

## Statistics and limits

- Live counts cover devices connected to cloud rooms, room connections, active rooms and live sources.
- Approximate unique devices, room time, delivered listening time, created rooms, joins, reconnects, relay packet deliveries and backlog drops persist as daily aggregates in PostgreSQL.
- Device counts are hashed guest/account identities, not verified people or installation counts. Clearing storage or changing browser creates another identity.
- Room time is server-observed connected time. Listening time counts bounded relay audio delivered to unpaused listeners; it does not verify audible playback. Source phones, direct WebRTC and fully offline nearby rooms are excluded. The UI explains this beside the figures.
- Daily buckets use UTC. A 7/30/90-day report and lifetime totals are available. Tracking starts with this deployment; old sessions cannot be reconstructed.
- Updates flush every 15 seconds and on graceful shutdown. Up to an unflushed interval may be lost in a hard crash. Batch IDs make database retries idempotent after uncertain commit responses. Database outages are surfaced as unavailable statistics rather than invented zeroes.
- Names, IP addresses, raw guest IDs, audio and chat content are absent from usage rows. The privacy page describes these aggregates. The offline in-memory adapter exists for development and resets when the server restarts.

## Verification before release

On 18 November 2026, all 49 Android Kotlin sources compiled against SDK 36 using the cached Kotlin compiler, and 103 Android JVM tests passed through JUnit. Fifty-two JavaScript checks passed, including the seven new owner security/analytics tests. Syntax, offline bundle synchronization and whitespace checks passed. Local HTTP/WebSocket integration tests could not connect (`EACCES`), and Gradle could not connect to its local daemon in this execution environment. Those checks and the production PostgreSQL migration still need a normal development/CI environment.

A separately installable `com.roomsound.android.preview` APK was assembled with the Android SDK CLI tools and cached dependencies, signed with a development key and verified with `apksigner`. Its manifest, launcher activity, SDK levels, dex, native libraries and bundled offline guide were checked. This preview is not a production release or evidence of physical-phone discovery testing. The live backend and production APK have not been deployed by this change.

Run `npm run check`, `npm test`, the PostgreSQL integration check against a disposable database, and `android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug`. Test the APK on two physical phones on both a home Wi-Fi network and a phone hotspot. Confirm code discovery, fallback invite, share/copy actions, leave/end cleanup, source approval, chat scrolling, and vertical swipes beginning over the tab bar. Verify login failure/replay throttling and owner session expiry on the deployed HTTPS origin before treating the owner dashboard as enabled.
