# Production hardening — version 1.1.3

Updated 6 November 2026. The signed APK and AAB are published in
[GitHub Releases](https://github.com/Rishu-Kumar-2611/sangeetpitara/releases/tag/v1.1.3).
The downloaded APK's signing certificate matches v1.1.2. This is not a
production certification; the remaining device/deployment gates still apply.

## Completed implementation

- F01: every member has a private reconnect capability; missing/wrong capabilities cannot reclaim a public guest ID. Native clients persist/send their capability. Browser recovery remains compatible. Old APKs lacking capabilities must upgrade for secure recovery.
- F02: email allowlists no longer grant administrator authority. ADMIN_EMAILS reserves signup addresses only; trusted operators must explicitly provision database `users.is_admin` roles after verifying ownership.
- F04: anonymous rooms end on server restart instead of reappearing without a host. Account-owned restored rooms receive an expiry timer.
- F05, partial: removed guest IDs and reconnect capabilities cannot immediately rejoin the same running room. A fresh anonymous installation can evade this identity boundary; durable guest reporting, review tooling and stronger admission controls remain work.
- F06: published version 1.1.3/code 10103 and new browser asset cache identifiers. See LATENCY-1.1.3.md for the reduced playout/queue budgets.
- F07: upgraded compile/target API to 36, AGP 8.10.1 and Gradle 8.11.1 with verified distribution checksum. Added system/keyboard inset handling, removed full-screen notification permission, excluded private identity from cloud/device transfer, and added AAB to the signed release workflow.
- F08: Compose now passes/requires the metrics token; production template documents it.
- Production test-mode bypass is restricted to explicitly loopback-bound servers.
- F09, partial: bounded rooms, connections, per-IP room creation and pending commands; server heartbeat terminates dead connections. Edge proxy trust, staging load and cost validation remain external gates.
- F11: administrative revocation uses an allowed audit type. A real PostgreSQL test verifies response and mutation.
- F12: HTTP static assets use an explicit public allowlist; backend sources and audit/test files are private.
- F13: browser origin allowlist no longer trusts subdomains implicitly.
- F14: stereo payloads must have exact length; malformed packets reject before decoding.
- F15: offline participant slots and resolved requests are pruned; expired account sessions receive scheduled cleanup.
- F16, partial: CPU wake lock has a bounded, lifecycle-renewed lease; modern backup rules added. Battery profiling and optimization require physical devices.
- F17, partial: app-first landing content, labeled chat/errors, keyboard entry tabs, focus-contained dialogs, and storage-denied fallback. Added desktop/phone browser regression tests and rendered screenshots.
- F18, partial: published source now uses user-supplied support address rishu2311singh@gmail.com; removed contact-page placeholders and query-string email override. Updated storage/relay disclosures. Consent prompt stays hidden while ads are disabled. Mailbox delivery, retention/legal review remain unverified.
- F19, partial: real PostgreSQL integration and browser flows added to CI; release.properties triggers Android checks. Further observability, instrumentation and maintainability work remains.
- Additional real-database bug fixed: session lookup qualifies `sessions.created_at` in its JOIN, avoiding PostgreSQL authentication failures hidden by the memory adapter.

## Repeatable checks

Latest verification: 111 Node tests plus origin/payload/RTC checks passed on
Node 22.14.0; 78 Android unit tests passed; API 36 debug assembly/lint passed
with zero errors and 48 warnings; release APK, AAB and release lint passed
using a temporary validation-only key. Four desktop/phone browser tests passed.
PostgreSQL integration and the packaged production-container smoke test passed.
The npm production dependency audit reported zero known vulnerabilities.
No physical Android device was connected. Validation-key artifacts must never
be published as updates to the existing app.

```text
npm ci
npm test
npm run check
npm run test:postgres
npm run test:browser
node checks/release-local.mjs
docker build -f Dockerfile.runtime -t sangeetpitara:production-check .
node checks/container-smoke.mjs
```

The PostgreSQL check creates and removes a loopback-only disposable Docker database by default. CI can supply TEST_DATABASE_URL for an explicitly disposable database; never use a production database. It verifies migrations, existing allowlisted emails without privileges, explicit admin roles, successful revocation, session survival and safe guest-room restart.

Browser checks use installed Edge on Windows; other platforms use Playwright Chromium (`npx playwright install chromium`). CI installs Chromium. Tests exercise host/listener entry, chat, host recovery, leaving, dialog keyboard focus and denied browser storage at desktop/phone sizes. They do not prove actual audio delivery, Safari compatibility or screen-reader compliance.

Android check from android/ with JDK 17 and SDK 36:

```text
gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug --no-daemon --console=plain
```

Set ROOMSOUND_BUILD_DIR to a temporary directory outside OneDrive. Production signing requires the existing release key and passwords supplied locally or through CI secrets; never send them in chat. Release workflow builds/verifies APK plus AAB, but publication requires the release tag and configured CI credentials.

## Required next gates

1. **Live PostgreSQL deployment (F03):** verified public version 1.1.3, production mode, private database connection and PostgreSQL readiness after the approved Render Blueprint adoption. Rehearse backup restore. The current free database expires on 25 November 2026; arrange continued database hosting before then.
2. **Signing and store:** validate with the original signing identity; install over public v1.1.2; submit AAB through Play internal testing; complete Data Safety, foreground-service declarations, store listing and review. No Play Console changes were made.
3. **Physical audio/device matrix:** Android 10 and current Android, restrictive OEM, 16 KiB device, Wi-Fi/mobile/Bluetooth, capture allowed/blocked, source handoff, notification denial, calls, lock/background/process death, 60-minute listening and longer soak.
4. **Operational capacity:** staging load/reconnect storm, proxy trust, uptime/error/audio-egress monitoring, budgets/alerts and rollback drill. Caps are protective defaults, not demonstrated capacity: 50 rooms, 200 sockets, 40 sockets/IP, 10 room creations/IP/10 minutes, 16 queued commands/socket.
5. **Moderation/privacy:** guest reporting and operator review, retention/deletion/backup expiry, accurate final operator/provider disclosures and policy review.
6. **Optional payments/ads (F10):** keep disabled. Atomic/order-safe billing webhook handling and real provider/consent validation remain outstanding before enabling monetization.

The app remains deliberately single-process for room authority; a Redis environment variable does not enable horizontal scaling. Audio is transient server-relayed PCM, not end-to-end encrypted. Do not increase room limits or promise tight multi-speaker synchronization without measurements.

## Public website rollout verified (6 November 2026)

The approved Blueprint adopted the existing Singapore web service and database;
no resources were created and no paid plans were changed. Render now supplies
DATABASE_URL through fromDatabase without copying credentials into source or chat.
The Blueprint manages its listed settings; omitted service variables are preserved.
The service uses /ready for deployment health checks.

Render deployment dep-dbn07rgn74is73fh5vn0 reached live. The public site
https://sangeet-pitaraa.onrender.com reports version 1.1.3 and PostgreSQL readiness.
The release checker verified landing HTML, JavaScript, styles and both audio
worklets against the shipped files; APK redirects resolve to the public signed
1.1.3 release. Anonymous backend-source requests returned 404 and metrics 401.
These checks verify publication and readiness, not paired-device acoustic latency.
