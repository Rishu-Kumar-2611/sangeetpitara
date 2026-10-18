# RoomSound prototype

RoomSound is a small, runnable web prototype for the private audio-room idea. It includes:

- Account-less room creation and joining by code or invite link
- Device-local guest identity
- Up to 10 people in a room
- Host, co-host, participant, and active-source state
- WebRTC audio publishing with a lightweight WebSocket signaling server
- Browser display/tab-audio capture where supported
- Device/browser playback audio and a generated test-audio diagnostic source
- Host approval/rejection of participant source requests
- Optional browser/Android OS notifications with Approve/Reject actions for moderators
- Host takeover and participant-to-host source resumption
- Co-host promotion after host disconnect
- Text chat, roster presence, local mute, and volume controls
- Internal PostgreSQL-backed email/password accounts with server-issued HttpOnly sessions
- Durable room directory, moderation records, billing events, and subscription entitlements when PostgreSQL is enabled
- Production health (`/health`, `/ready`), bounded Prometheus metrics, structured redacted logs, and abuse-report APIs
- Privacy-gated, opt-in advertising boundary with a Google AdSense adapter that is disabled until deployment configuration and consent exist
- Provider-neutral rewarded-access gate: a completed 30-second offline demo reward grants six hours of browser room access in local storage
- No audio recording

## Run it

Requirements: Node.js 22.14.0 (the exact version is pinned in `.nvmrc`).

```powershell
npm ci
npm start
```

When `DATABASE_URL` is absent, the server uses an in-memory account/session
repository. This keeps `npm test` and local development offline. For a persistent
deployment, set `DATABASE_URL` in the deployment secret store; startup applies the
SQL files in [`migrations/`](migrations/) before opening the HTTP listener. The
explicit migration command is:

```sh
npm run migrate
```

The account API is same-origin and does not return session tokens in JSON. It is
kept for internal/admin workflows and protected moderation/billing operations;
the browser room surface does not display sign-in, sign-up, or account controls.
A successful registration or login sets the `roomsound_session` HttpOnly cookie:

- `POST /api/auth/register` with `{ "email": "...", "password": "..." }` returns `201`.
- `POST /api/auth/login` with the same shape returns `200` or a generic `401` for invalid credentials.
- `GET /api/auth/me` (also `/api/auth/current-user`) returns the current public user or `401`.
- `POST /api/auth/logout` invalidates the server-side session and clears the cookie.

Browser room create/join is always anonymous. Older deployments may still have
`REQUIRE_AUTH=1` or `ALLOW_ANONYMOUS` settings, but those settings no longer gate
WebSocket room create/join; the internal HTTP account/admin APIs remain
authenticated.

Before a browser can create or join a room, it must complete the configured
rewarded-access flow. The current `/config` response publishes:

```json
{
  "rewardedAccess": {
    "enabled": true,
    "provider": "demo-local",
    "mode": "offline",
    "rewardDurationSeconds": 30,
    "accessDurationHours": 6,
    "accessDurationMs": 21600000
  }
}
```

`demo-local` is an explicitly named offline development simulation. It does not
load a real ad network, make a production ad-impression claim, or provide
production monetization. The browser stores only an access expiry timestamp in
`localStorage`; access is inactive at or after the six-hour expiry. A reviewed
provider adapter and consent/legal review are still required before using a real
rewarded-ad network.

Sponsored display advertising is disabled by default. To enable a reviewed Google AdSense deployment,
configure the `roomsound-ad-provider=adsense`, `roomsound-ad-client`, and
`roomsound-ad-enabled=true` meta values at deploy time, provide non-empty
`data-ad-slot` values, and obtain user consent through the in-app banner. Never
commit a publisher/client identifier, load ads before consent, or treat this
boundary as a substitute for legal privacy/consent review. The room UI keeps ad
slots outside live audio controls.

Passwords are validated before persistence and stored as salted, parameterized
scrypt hashes. Set `SESSION_COOKIE_SECURE=1` when HTTPS terminates at the server
or reverse proxy; it defaults on automatically for `NODE_ENV=production`. Keep
`DATABASE_URL` and any database credentials out of `.env.example` and source
them from the deployment secret manager.

`npm start` remains the simple local start path. For a local `.env` file (including TURN settings), use the restart-safe commands below instead of starting a second copy on port `4173`.

### Local server and safe restarts

Create the local environment file once:

```powershell
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
}
```

`.env` is ignored by Git. Keep real TURN usernames, credentials, and other secrets only in that local file or in your deployment secret store; never put them in `.env.example`, commit `.env`, or paste its contents into logs or issues.

On Windows PowerShell, this stops only a Node process that is listening on RoomSound's port before starting the server with `.env` loaded:

```powershell
$ownerPids = @(Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($ownerPid in $ownerPids) {
  $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    Stop-Process -Id $ownerPid -Force
  }
}
node --env-file=.env server.mjs
```

On macOS, Linux, or PowerShell 7+, use the same cross-platform start command:

```text
npm start
```

The `.nvmrc` pins Node 22.14.0, which supports the optional env-file flag used by `npm start`. To restart on any platform, press `Ctrl+C`, wait for the process to exit, and run the same command again. If another program owns port `4173`, inspect it before stopping it rather than force-stopping an unrelated service.

With the server running, use this safe verification command to confirm that `/config` contains at least one TURN server. It prints only the TURN status and count; it never prints the TURN credential:

```sh
node --input-type=module -e 'const response = await fetch("http://127.0.0.1:4173/config"); if (!response.ok) throw new Error(`HTTP ${response.status}`); const { iceServers = [] } = await response.json(); const turnServers = iceServers.filter(({ urls }) => [].concat(urls ?? []).some((url) => /^turns?:/i.test(String(url)))); console.log(turnServers.length ? `TURN present (${turnServers.length} server(s))` : "TURN not configured");'
```

Open `http://localhost:4173` in a current browser. To test the room flow, open the URL in two browser windows or on two devices that can reach the machine running the server.

For audio capture, use a secure context (`localhost` is allowed by browsers) and expect a browser permission prompt. Desktop Chrome and Edge are the most useful first targets for browser-tab audio. RoomSound does not stream microphones; mobile browsers generally cannot capture audio from a separate native app, so use the native Android app for Android device playback.

Moderators can opt in to control-request notifications from the browser room settings menu (`•••`), or allow the Android notification permission after joining as host/co-host. If notifications are unsupported or blocked, the normal in-room control queue remains available. Approve or Reject from a notification sends the existing room command directly; if the browser room page is closed, RoomSound reopens the room invite URL and reconnects before delivering the action. Android actions are owned by the room service, so they continue to work while the Activity is backgrounded.

With the server running in another terminal, the repeatable room-control smoke test is:

```powershell
npm run smoke
```

It exercises room creation, guest joining, rejection and approval, blocked competing requests, host takeover, co-host assignment, and immediate co-host promotion after the host leaves.

The physical-device validation matrix is in [`QA_CHECKLIST.md`](QA_CHECKLIST.md).
Run it with TURN enabled before evaluating a replacement relay provider.

The offline regression test and syntax check are:

```powershell
npm test
npm run check
```

`make test` is an equivalent single test command on systems with Make installed.

## Reproducible container run

The Node runtime is pinned in `.nvmrc`, dependencies are pinned by `package-lock.json`,
and the production-only `Dockerfile.runtime` runs the web server without requiring
global packages or building the Android toolchain:

```powershell
docker build -f Dockerfile.runtime -t roomsound:local .
docker run --rm -p 4173:4173 --env-file .env roomsound:local
```

The root `Dockerfile` also provides an isolated Android build target with JDK 17, Android
SDK Platform 35, and pinned command-line/build-tools versions:

```powershell
docker build --target android-build -t roomsound-android:local .
```

Create `.env` from `.env.example` first. For a deployment, use HTTPS/WSS at a reverse
proxy, set `ALLOWED_ORIGINS`, and provide TURN values (`TURN_URLS`, `TURN_USERNAME`,
and `TURN_CREDENTIAL`) when clients may be behind restrictive NATs. The Android
client fetches the same `/config` ICE settings before creating native peers.

For provider-neutral production deployment, use the Android-free
[`Dockerfile.runtime`](Dockerfile.runtime), [`compose.yaml`](compose.yaml), or
[`render.yaml`](render.yaml). Health/readiness, migration, reverse-proxy, and
secret-store procedures are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The
disabled-by-default billing and entitlement contract is documented in
[`docs/BILLING.md`](docs/BILLING.md).
Legal and abuse-launch templates are in [`docs/PRIVACY.md`](docs/PRIVACY.md),
[`docs/TERMS.md`](docs/TERMS.md), and [`docs/ABUSE.md`](docs/ABUSE.md); replace
their placeholders and obtain legal review before launch.

## Android release build

The Android wrapper is checked in and pins Gradle 8.9. Use JDK 17, Android SDK
Platform 35, and Android SDK Build-Tools. The Android Gradle Plugin and Kotlin
plugin versions are pinned in `android/build.gradle.kts`.

From `android/`, a debug build is:

```powershell
./gradlew.bat :app:assembleDebug --no-daemon --console=plain
```

If the repository is inside OneDrive or another synchronised folder, move only
the generated Android output to a local temporary directory:

```powershell
$env:ROOMSOUND_BUILD_DIR = Join-Path $env:TEMP "RoomSoundAndroidBuild"
./gradlew.bat :app:assembleDebug --no-daemon --console=plain
```

Release signing is intentionally opt-in. Keep the keystore and passwords
outside git, set `ROOMSOUND_KEYSTORE`, `ROOMSOUND_KEYSTORE_PASSWORD`,
`ROOMSOUND_KEY_ALIAS`, and `ROOMSOUND_KEY_PASSWORD` in the build environment,
then run:

```powershell
./gradlew.bat :app:assembleRelease --no-daemon --console=plain
```

The signed APK is written to
`android/app/build/outputs/apk/release/app-release.apk`, or to the equivalent
directory below `ROOMSOUND_BUILD_DIR` when that option is set. The keystore
file pattern is ignored by git; do not commit signing material.

## Server hardening and production foundations
- `GET /config` returns `iceServers` (STUN + TURN when env set). Web + Android should fetch it.
- `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` env wire TURN for symmetric NAT/CGNAT.
- `ALLOWED_ORIGINS` optional allowlist for WebSocket handshake.
- Rate limiting: 120 req/min/IP + 30 msg/5s per socket; `maxPayload 64k`.
- Message/history bounded: `messages >200 splice 100`; requests auto-prune after cancel/expire/approve.
- CSP + `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` etc. Also `<meta http-equiv CSP>` in `index.html`.
- `/health` + `SIGTERM`/`SIGINT` graceful shutdown; timed `host → cohost` promotion at 30s.
- `/ready` blocks readiness until startup/migrations/room-directory restore finish; `/metrics` emits bounded Prometheus output.
- Authenticated report/block/ban APIs and Stripe checkout/portal/webhook seams fail closed when unconfigured.

Client hardening: 1 → 30s exponential backoff reconnect (mirrors `RoomSoundWebSocketClient`), `captureNonce` race fix, `clampVolume`, listening `audioElement` is visually hidden but accessible (`aria-label` on control panel), `connectionState=failed` toast + retry, listener-leave peer cleanup, `fetch /config` before RTC.

## Current scale boundary

Live WebSocket membership and WebRTC media remain single-process and mesh-based;
durable PostgreSQL metadata survives restarts but live sockets and audio do not.
The production target is 100 total concurrent users and at most 10 users per
room. Larger rooms or multiple live instances require shared room state and an
SFU such as LiveKit, mediasoup, or Janus. Do not promise 100 listeners in one
mesh room.

Android-wide application audio also remains platform-dependent. The production Android client should use `MediaProjection` and Android playback-capture APIs; a web page cannot guarantee capture of Spotify, YouTube, or other native Android applications.

## Android client

The `android/` folder contains the native Kotlin capture and RoomSound client.
It requests `RECORD_AUDIO`, obtains one-time `MediaProjection` consent, starts
a media-projection foreground service, reads eligible playback as PCM16, and
uses native WebRTC for the room media plane. Build and device validation still
require a JDK 17/Android SDK toolchain plus a physical Android 10+ device for
meaningful playback-capture testing. See `android/README.md` for the native
transport boundary and device setup.
