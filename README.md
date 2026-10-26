# SangeetPitara

SangeetPitara (formerly RoomSound) is a private audio-room app for web and Android.
The selected logo is the vector **Diya Eighth Note** in
[`branding/sangeetpitara/05-diya-eighth-note.svg`](branding/sangeetpitara/05-diya-eighth-note.svg).
Existing `roomsound-*` storage keys, `ROOMSOUND_*` build settings, Android
package identity, and media protocol stay unchanged so existing installs and
sessions remain compatible. It includes:

- Account-less room creation and joining by code or invite link
- Public landing-page download link for the current Android APK at
  `/downloads/SangeetPitara.apk`, which redirects to the latest GitHub Release
  (see "Android releases" below)
- Device-local guest identity
- Up to 10 people in a room
- Host, co-host, participant, and active-source state
- Binary PCM16 WebSocket media relay for browser audio, enabled by default for
  cross-NAT phone-to-laptop playback
- Direct WebRTC audio publishing as an explicit opt-out path with lightweight
  WebSocket signaling
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
- Free, unrestricted room access: the rewarded-access gate is currently disabled (code remains for future opt-in use)
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

When rewarded access is enabled by deployment configuration, a browser must
complete the configured access flow before entering a room. The default
production configuration keeps room access unrestricted. The current default
`/config` response publishes:

```json
{
  "rewardedAccess": {
    "enabled": false,
    "provider": "demo-local",
    "mode": "offline",
    "rewardDurationSeconds": 30,
    "accessDurationHours": 6,
    "accessDurationMs": 21600000
  },
  "mediaRelay": {
    "enabled": true,
    "mode": "pcm16",
    "sampleRate": 48000,
    "channels": 1
  }
}
```

Browser audio uses the `/config` `mediaRelay` setting by default. The enabled
path captures a browser/device stream through Web Audio, sends validated
PCM16/48 kHz mono frames over the room WebSocket, and schedules received
frames through an AudioContext. This avoids relying on STUN-only WebRTC for
cross-NAT connectivity. Set `MEDIA_RELAY_ENABLED=0` to opt back into the
existing direct WebRTC peer path. The relay is a server bandwidth path: every
source frame is uploaded to the RoomSound server and fanned out to listeners,
so it is not free at scale and should be sized and metered accordingly.
After every deployment, verify `GET /config` reports `mediaRelay.enabled: true`;
if it reports `false`, set `MEDIA_RELAY_ENABLED=1` in the deployment environment
and restart/redeploy the service before testing audio. A manually created Render
service does not necessarily import later `render.yaml` environment changes.

The relay frame is binary and starts with the 20-byte little-endian header
`RSR1`, version `1`, channels, sample rate, source epoch, sequence, and
sample count, followed by the exact PCM16 mono payload. The server accepts only
48,000 Hz, one channel, non-empty frames whose payload length matches
`sampleCount * 2`; it authorizes the current active source and source epoch
before forwarding the original bytes to online room members. The low-latency
path uses small browser capture callbacks, bounded sender/playout queues, a
short playback look-ahead, and drops stale frames for slow listeners instead
of letting old audio accumulate. This favors a short gap over delayed audio
when a device or network falls behind.

### Android Chrome background boundary

Browser listeners route relay PCM through an audible `<audio>` element backed by
the Web Audio graph. This gives Chrome Android the normal media-playback path,
and the page retries the media element and audio contexts on `visibilitychange`,
`resume`, and `pageshow`. It improves playback when Chrome is sent to the
background but remains alive in Recents.

This is still a web lifecycle boundary, not a background-service guarantee.
Chrome may freeze a hidden page (suspending JavaScript and network callbacks),
or discard/terminate it without a page callback. A service worker cannot take
over the live PCM WebSocket and Web Audio renderer. Therefore no web-only
change can guarantee continuous relay playback after Chrome is swiped away,
the browser process is killed, the tab is discarded, or Android reclaims the
process. The smallest guaranteed path for long-running locked/background
playback is the existing Android foreground-service client; an installed PWA
can reuse the same media-element and Media Session behavior, but it does not
remove Chrome's page-lifecycle limits.

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

`npm start` remains the simple local start path. For a local `.env` file (including optional relay settings), use the restart-safe commands below instead of starting a second copy on port `4173`.

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

With the server running, use this safe verification command to confirm whether `/config` is STUN-only or contains an explicitly enabled TURN relay. It prints only the relay status and count; it never prints the TURN credential:

```sh
node --input-type=module -e 'const response = await fetch("http://127.0.0.1:4173/config"); if (!response.ok) throw new Error(`HTTP ${response.status}`); const { iceServers = [] } = await response.json(); const turnServers = iceServers.filter(({ urls }) => [].concat(urls ?? []).some((url) => /^turns?:/i.test(String(url)))); console.log(turnServers.length ? `TURN present (${turnServers.length} server(s))` : "TURN not configured");'
```

Open `http://localhost:4173` in a current browser. To test the room flow, open the URL in two browser windows or on two devices that can reach the machine running the server.

For audio capture, use a secure context (`localhost` is allowed by browsers) and expect a browser permission prompt. Desktop Chrome and Edge are the most useful targets for browser-tab or system audio. Their picker must offer and have enabled `Share tab audio` or `Share system audio`; choosing a screen without an audio track cannot send music. Firefox can share the screen image but does not provide the live system-audio track required by this flow, so use Chrome or Edge on the laptop. RoomSound does not stream microphones; mobile browsers generally cannot capture audio from a separate native app, so use the native Android app for Android device playback.

Moderators can opt in to control-request notifications from the browser room settings menu (`•••`), or allow the Android notification permission after joining as host/co-host. If notifications are unsupported or blocked, the normal in-room control queue remains available. Approve or Reject from a notification sends the existing room command directly; if the browser room page is closed, RoomSound reopens the room invite URL and reconnects before delivering the action. Android actions are owned by the room service, so they continue to work while the Activity is backgrounded.

With the server running in another terminal, the repeatable room-control smoke test is:

```powershell
npm run smoke
```

It exercises room creation, guest joining, rejection and approval, blocked competing requests, host takeover, co-host assignment, and immediate co-host promotion after the host leaves.

The physical-device validation matrix is in [`QA_CHECKLIST.md`](QA_CHECKLIST.md).
Run it with the default PCM16 WebSocket relay when validating phone-to-laptop
playback across different networks. Set `MEDIA_RELAY_ENABLED=0` only when
deliberately testing the direct STUN/WebRTC opt-out path.

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
proxy and set `ALLOWED_ORIGINS`. Browser PCM16 relay is enabled by default and
moves media bandwidth to the RoomSound server; it is not free at scale. Set
`MEDIA_RELAY_ENABLED=0` only when a measured deployment should use the direct
STUN/WebRTC browser path. If that opt-out path needs a TURN server, set
`TURN_ENABLED=1` and provide `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL`.
The Android client fetches the same `/config` ICE settings before creating
native peers.

For provider-neutral production deployment, use the Android-free
[`Dockerfile.runtime`](Dockerfile.runtime), [`compose.yaml`](compose.yaml), or
[`render.yaml`](render.yaml). Health/readiness, migration, reverse-proxy, and
secret-store procedures are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). The
STUN-only cost-reduction decision and network validation plan are in
[`docs/ICE-COST-PLAN.md`](docs/ICE-COST-PLAN.md). The
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

### Android releases

Public APKs are built and signed by GitHub Actions and published to GitHub
Releases; they are no longer committed under `downloads/`. The site redirects
every `/downloads/*.apk` link (including the old 1.0.1 names) to
`https://github.com/Rishu-Kumar-2611/sangeetpitara/releases/latest/download/SangeetPitara.apk`.
Set `ANDROID_APK_URL` (https only) on the server to point elsewhere.

One-time setup. Create the release keystore once and keep a private backup:
every future update must be signed with the same key, or users have to
uninstall before they can install it.

```sh
keytool -genkeypair -v -keystore sangeetpitara-release.jks -alias sangeetpitara \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -i sangeetpitara-release.jks | pbcopy   # macOS; on Linux: base64 -w0 sangeetpitara-release.jks
```

Then add four repository secrets under Settings → Secrets and variables →
Actions: `ANDROID_KEYSTORE_BASE64` (the copied text), `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` (`sangeetpitara` above) and `ANDROID_KEY_PASSWORD`.

To release, push a version tag:

```sh
git tag v1.1.2
git push origin v1.1.2
```

`.github/workflows/release.yml` runs the web and Android tests, builds
`assembleRelease` with the tag's versionName and versionCode
(major·10000 + minor·100 + patch), verifies the signature, and publishes
`SangeetPitara.apk` plus a versioned APK with generated notes. The Android app checks
`releases/latest` on launch and offers a newer version. Every Android pull
request also uploads a debug-signed `SangeetPitara-debug-apk` artifact for
testing, and builds a release APK with a throwaway key to prove the release
build still works.

The 1.0.1 APK was debug-signed, so the first release-signed install over it
fails with a signature conflict; uninstall 1.0.1 once, then install.

## Server hardening and production foundations
- `GET /config` returns `iceServers` plus `mediaRelay` (`pcm16`, 48 kHz, mono,
  enabled by default). Browser and Android clients use the relay unless it is
  explicitly disabled; Android's native WebRTC path remains the opt-out.
- `TURN_ENABLED=1` plus `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` wires an optional relay for symmetric NAT/CGNAT. Keep it `0` to avoid relay charges.
- `ALLOWED_ORIGINS` optional allowlist for WebSocket handshake.
- Rate limiting: 120 req/min/IP + 30 JSON msg/5s per socket; PCM16 binary
  frames are bounded to 600/5s and 64 KiB of payload; WebSocket transport is
  capped at 512 KiB so application-level rejection can stay descriptive.
- Message/history bounded: `messages >200 splice 100`; requests auto-prune after cancel/expire/approve.
- CSP + `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` etc. Also `<meta http-equiv CSP>` in `index.html`.
- `/health` + `SIGTERM`/`SIGINT` graceful shutdown; timed `host → cohost` promotion at 30s.
- `/ready` blocks readiness until startup/migrations/room-directory restore finish; `/metrics` emits bounded Prometheus output.
- Authenticated report/block/ban APIs and Stripe checkout/portal/webhook seams fail closed when unconfigured.

Client hardening: 1 → 30s exponential backoff reconnect (mirrors `RoomSoundWebSocketClient`), `captureNonce` race fix, `clampVolume`, listening `audioElement` is visually hidden but accessible (`aria-label` on control panel), `connectionState=failed` toast + retry, listener-leave peer cleanup, `fetch /config` before selecting PCM16 relay or direct RTC.

## Current scale boundary

Live WebSocket membership and the browser PCM16 media relay remain
single-process; durable PostgreSQL metadata survives restarts but live sockets
and audio do not. The default browser relay improves connectivity through
restrictive NATs, CGNAT, enterprise firewalls, and networks that block direct
UDP, but it consumes RoomSound server ingress and fan-out bandwidth for every
listener. It is not free at scale and needs capacity planning. The direct
STUN/WebRTC path remains available as an opt-out, but cannot guarantee
cross-NAT delivery without TURN or another relay architecture.
The production target is 100 total concurrent users and at most 10 users per
room. Larger rooms or multiple live instances require shared room state and an
SFU such as LiveKit, mediasoup, or Janus. Do not promise 100 listeners in one
mesh room.

Android-wide application audio also remains platform-dependent. The production Android client should use `MediaProjection` and Android playback-capture APIs; a web page cannot guarantee capture of Spotify, YouTube, or other native Android applications.

On Android, the native client can attempt to pause the previous phone media app
when another room source is approved or takes control. Enable Android
Notification Access from the app's **Playback sharing** panel for that
best-effort handoff control; players that do not expose a controllable media
session may continue playing. A browser cannot pause a captured tab or another
system app.

Browser-to-browser audio is not disabled. Supported desktop Chrome/Edge
browsers can capture a tab or system-audio surface and exchange PCM16 audio
through the enabled server relay. A phone browser can listen, but it generally
cannot capture playback from another native Android app, so Android-to-laptop
source sharing requires the native Android app.

## Android client

The `android/` folder contains the native Kotlin capture and RoomSound client.
It requests `RECORD_AUDIO`, obtains one-time `MediaProjection` consent, starts
a media-projection foreground service, reads eligible playback as PCM16, and
uses native WebRTC for the room media plane. Build and device validation still
require a JDK 17/Android SDK toolchain plus a physical Android 10+ device for
meaningful playback-capture testing. See `android/README.md` for the native
transport boundary and device setup.
