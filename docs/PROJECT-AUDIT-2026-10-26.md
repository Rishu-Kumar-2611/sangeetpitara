# SangeetPitara project audit — 2026-10-26

## Executive summary

SangeetPitara is a well-tested real-time listening-room product with a browser
client, native Android playback-capture client, Node.js/WebSocket server,
optional PostgreSQL persistence, and GitHub Release-based Android delivery.
The strongest parts are the bounded PCM16 relay, source authorization and epoch
checks, lifecycle-aware Android foreground service, security headers and input
limits, and unusually broad automated coverage.

The main release problem is synchronization: this laptop contains local commit
`1cff79f` and tag `v1.1.1`, while GitHub `main` is still `c6e8589` and the latest
published APK is v1.1.0. The laptop now contains a current debug APK, but the
public website and GitHub Release do not yet contain the mobile People/Health
changes. The push attempt was rejected by GitHub authentication with HTTP 401.

### Follow-up hardening

After this baseline audit, the project added production configuration validation,
authoritative release properties for v1.1.2, authentication throttling,
serialized per-socket room commands, serialized per-room persistence snapshots,
duplicate-entry race coverage, browser CI, release identity checks, release
linting, and an Android runtime permission check. The current local debug APK is
version 1.1.2/code 10102; the historical synchronization table below describes
the state at the time of the baseline audit.

## Repository and artifact synchronization

| Item | Observed state |
|---|---|
| Local branch | `main`, commit `1cff79f` |
| GitHub `main` | `c6e8589` |
| Local difference | One local mobile-parity commit; all GitHub-tracked files are present locally |
| Local tag | `v1.1.1` |
| GitHub latest tag/release | `v1.1.0` |
| Public deployment | Older release; current `checks/release.mjs` fails on landing-page hash mismatch |
| Current laptop APK | `android/artifacts/SangeetPitara-debug.apk`, version `1.1.1`, code `10101`, debug-signed |
| Root APK | `app-debug.apk`, synchronized to the same current debug APK |
| Public APK | v1.1.0, version code `10100` |

The current APK SHA-256 is:

```text
f79ca4a253c185053d10f1c7c450c807593d1d23b8dadaad8dbbca67fef958e8
```

The old `RoomSound-debug.apk`, `RoomSound-release.apk`, and prior ignored
artifacts remain as historical files. They are not part of GitHub `main` and
should be clearly treated as rollback/reference artifacts.

## A–Z audit

### A — Architecture

**Good:** Clear separation between browser UI, Node server, media relay,
security/auth/moderation/persistence modules, and Android capture/transport
packages. The server is dependency-light and the Android client uses a stable
wire protocol.

**Fix:** `app.js` and Android `MainActivity.kt` are now large orchestration
files. Split UI rendering, room state, media controls, and diagnostics into
smaller modules as feature count grows.

### B — Build and dependencies

**Good:** Node and Gradle versions are pinned; Android dependencies are locked;
the Android build uses JDK 17 and compile/target SDK 35.

**Fix:** The Android Gradle fallback version is still `1.0.1`/code `3`, while
the current local release is 1.1.1. Make the default values derive from one
version source so a normal local build cannot produce a falsely old APK.

### C — Client features

**Good:** Browser supports rooms, source requests, takeover, chat, reactions,
roster, moderation, waveform, stream health, local file audio, mute, volume,
and synchronization controls. Android supports native playback capture,
background service operation, room control, chat, reactions, notifications,
source handoff, People, and Health diagnostics.

**Fix:** Continue validating feature parity with a written browser/Android
matrix. Browser-only tab capture and Android-only MediaProjection cannot be
identical, so document capability differences in the UI.

### D — Data and protocol

**Good:** PCM16 packets have a strict `RSR1` header, 48 kHz mono validation,
payload length checks, source authorization, source epoch checks, bounded
queues, stale-frame rejection, and relay byte/frame limits.

**Fix:** PCM16 relay bandwidth grows with every listener. Establish deployment
bandwidth limits and monitoring before increasing the 10-person room limit.

### E — Errors and recovery

**Good:** Browser and Android clients reconnect with bounded backoff; Android
preserves guest identity; server handles graceful shutdown; stale source and
request states are rejected.

**Fix:** Add a user-visible “last successful connection” and retry detail to
the Android Health panel and browser Health panel for faster diagnosis.

### F — Frontend and responsive design

**Good:** Responsive Chat/People/Health tabs, safe escaping in dynamic HTML,
cache-busted assets, keyboard tab navigation, reduced-motion handling, and
mobile audio guidance are present.

**Fix:** Perform physical-device checks on narrow Android Chrome, iOS Safari,
and a small tablet. Automated DOM/CSS tests cannot prove touch scrolling,
safe-area behavior, keyboard behavior, or background audio behavior.

### G — Git/GitHub workflow

**Good:** Feature branches were merged into `main`; Android release automation
is tag-driven; APKs are no longer committed into the web image.

**Fix — high priority:** Authenticate GitHub and push both `main` and `v1.1.1`.
Until that happens, GitHub, Render, and the public APK remain behind the laptop.

### H — Health and observability

**Good:** `/health`, `/ready`, bounded Prometheus metrics, structured redacted
logs, audit events, and Android/native media diagnostics exist. Local release
verification passed.

**Fix — high priority:** `METRICS_BEARER_TOKEN` is optional. Configure it in
production or protect `/metrics` at the reverse proxy. Also set a meaningful
`APP_VERSION`; the code default is still `0.1.0`.

### I — Identity and authentication

**Good:** Account passwords use salted scrypt; sessions are server-side and
HttpOnly; account APIs do not return session tokens; room entry remains
anonymous by deliberate product design.

**Fix:** Anonymous room membership is inherently spoofable and rooms are
single-process. Add stronger host/member identity or signed room capabilities
before treating rooms as private or expanding abuse-sensitive features.

### J — Jobs and CI

**Good:** GitHub Actions run Android tests, debug assembly, and a throwaway-key
release build; tagged releases verify signatures and publish fixed APK names.

**Fix:** Add the browser test/release checks to a required GitHub workflow on
every `main` push, not only Android-path changes. Add a workflow check that the
tagged release commit contains the expected web asset version.

### K — Key and secret handling

**Good:** `.env`, keystores, Gradle output, logs, and APK artifacts are ignored;
the Docker context excludes private material; secrets are read from environment
variables.

**Fix:** Keep the local keystore backed up securely and verify that its public
certificate matches the GitHub Actions release key before the next production
release. Never use the local debug APK as the public update artifact.

### L — Lifecycle

**Good:** Android foreground service owns long-running capture/playback; source
handoff, screen lock, reconnect, and service reattachment are designed and
covered by the QA checklist. Browser lifecycle limitations are documented.

**Fix:** Complete the physical-device 30–60 minute background, lock, Wi-Fi
transition, and force-stop scenarios; these remain manual acceptance tests.

### M — Media quality

**Good:** The project includes jitter buffering, PLC/concealment work, pacing,
AudioTrack buffering, AudioWorklet playout, soft limiting, resampling, and
native PCM diagnostics.

**Fix:** Define measurable audio-quality targets: acceptable latency, underrun
rate, packet-loss behavior, CPU, battery, and relay bandwidth per listener.

### N — Networking

**Good:** WSS/public endpoint support, optional TURN, STUN fallback, origin
checks, rate limits, payload bounds, and WebSocket upgrade handling are present.

**Fix — high priority:** `ALLOWED_ORIGINS` is optional; when unset, the server
does not reject arbitrary WebSocket origins. Require an explicit production
allowlist or default production origin rather than relying on deployment setup.

### O — Operations

**Good:** Render, Docker runtime, Compose, health checks, migrations, graceful
shutdown, readiness, and deployment documentation are provided.

**Fix:** The live deployment must be checked after every push using the release
check and smoke flow. Current live verification correctly reports that it is
not the laptop release.

### P — Persistence

**Good:** PostgreSQL migrations cover auth, product data, account revocation,
room directory, moderation, billing events, and entitlements; in-memory mode
keeps development offline.

**Fix:** Live sockets, active rooms, requests, and audio are intentionally lost
on restart. A multi-instance deployment requires shared room state or an SFU;
do not scale horizontally with the current in-memory live-room map.

### Q — Quality gates

**Good:** `npm test` passes 98 tests plus origin, payload, and RTC checks;
`npm run check` passes; `npm audit --omit=dev` reports zero vulnerabilities;
the isolated release check and room smoke flow pass; Android unit tests and
current debug assembly pass.

**Fix:** Add lint, APK signature verification, manifest cleartext verification,
and a physical-device smoke result to the release evidence for every version.

### R — Reliability

**Good:** Bounded histories, queues, message sizes, rate windows, reconnects,
request TTLs, source epochs, and shutdown timers reduce runaway resource use.

**Fix:** Add load tests for many simultaneous rooms and relay listeners. The
current tests are excellent contract/regression tests but do not prove free-tier
capacity or long-running media stability.

### S — Security

**Good:** CSP, HSTS, frame denial, nosniff, COOP/COEP/CORP, permissions policy,
secure cookies, input limits, redaction, constant-time comparison, Stripe
signature verification, and authenticated product APIs are implemented.

**Fix:** Complete a production threat model for anonymous rooms, originless
WebSocket clients, room-code guessing, resource exhaustion, and admin APIs.
Run a focused external security review before enabling billing or bans broadly.

### T — Testing

**Good:** Tests cover auth, billing, moderation, persistence, relay packets,
capture, playout, reactions, room flows, security, branding, Docker context,
and release redirects.

**Fix:** Add browser automation on real Chromium mobile emulation and Android
instrumentation tests for People/Health rendering and accessibility.

### U — User experience and accessibility

**Good:** Touch-sized controls, mobile tabs, labels, live regions, status text,
accessible audio controls, reaction controls, and notification fallbacks are
present.

**Fix:** Review long Android diagnostic strings on small screens, screen-reader
order, contrast on all room palette combinations, and focus restoration after
mobile tab/menu changes.

### V — Versioning and release identity

**Good:** GitHub tags derive Android version name/code and the app checks GitHub
Releases for updates.

**Fix — high priority:** The laptop’s v1.1.1 debug APK, GitHub’s v1.1.0 signed
APK, and the stale default Gradle version are three different release states.
Push v1.1.1, let Actions create the signed release, then verify the public
redirect and installed package/version.

### W — Web deployment

**Good:** Render uses the runtime-only Docker image, health checks `/health`,
and the release verifier compares live assets and download redirects.

**Fix:** Do not consider a Git push complete until `/health`, `/ready`, `/config`,
browser asset hashes, redirect target, and room smoke all pass against the live
origin.

### X — External services

**Good:** PostgreSQL, TURN, Stripe, AdSense, Redis, Render, and GitHub Releases
are optional seams with fail-closed behavior in many paths.

**Fix:** Remove or clearly label unused integrations in deployment examples.
Redis is declared but not used by the current room server; TURN is disabled in
the Render blueprint; billing and ads require separate legal/provider setup.

### Y — Year/date and documentation consistency

**Good:** Release notes, deployment notes, QA checklist, and product plans are
present and explain important boundaries.

**Fix — medium priority:** README, `.env.example`, `ops/env.production.example`,
and deployment docs disagree about rewarded access and authentication defaults.
The server currently hardcodes `rewardedAccess.enabled: false`, while some
examples still advertise an enabled demo gate. Choose one truth and regenerate
the examples.

### Z — Next actions

1. Authenticate GitHub and push `main` plus tag `v1.1.1`.
2. Confirm GitHub Actions has the four Android signing secrets.
3. Wait for the signed v1.1.1 release and verify its version code/signature.
4. Verify Render deploys the mobile asset version and run `checks/release.mjs`
   plus the public smoke flow.
5. Fix version defaults, production origin enforcement, metrics protection,
   `APP_VERSION`, and rewarded-access documentation consistency.
6. Complete physical Android/browser acceptance tests before announcing the
   release.

## Verification performed for this audit

- `git fetch --all --prune`: completed; all remote branches and tags inspected.
- Local tracked tree contains all tracked files from GitHub `main`.
- `npm test`: passed, 98 tests plus origin/payload/RTC checks.
- `npm run check`: passed.
- `npm audit --omit=dev --audit-level=moderate`: zero vulnerabilities.
- `node checks/release-local.mjs`: passed, including release assets and room
  control smoke flow.
- Android `testDebugUnitTest`, `assembleDebug`, and `exportDebugApk`: passed.
- Current laptop APK inspected with `aapt`: package `com.roomsound.android`,
  version `1.1.1`, version code `10101`.
- Public `checks/release.mjs`: correctly failed because Render still serves the
  older release, confirming deployment synchronization is not complete.
