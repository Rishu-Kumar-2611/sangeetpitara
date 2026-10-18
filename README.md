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
- Host takeover and participant-to-host source resumption
- Co-host promotion after host disconnect
- Text chat, roster presence, local mute, and volume controls
- No audio recording

## Run it

Requirements: Node.js 22.14.0 (the exact version is pinned in `.nvmrc`).

```powershell
npm ci
npm start
```

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
and the included Dockerfile runs the web server without requiring global packages:

```powershell
docker build -t roomsound:local .
docker run --rm -p 4173:4173 --env-file .env roomsound:local
```

The default Docker target builds and runs the Node/WebSocket service. The same
Dockerfile also provides an isolated Android build target with JDK 17, Android
SDK Platform 35, and pinned command-line/build-tools versions:

```powershell
docker build --target android-build -t roomsound-android:local .
```

Create `.env` from `.env.example` first. For a deployment, use HTTPS/WSS at a reverse
proxy, set `ALLOWED_ORIGINS`, and provide TURN values (`TURN_URLS`, `TURN_USERNAME`,
and `TURN_CREDENTIAL`) when clients may be behind restrictive NATs. The Android
client fetches the same `/config` ICE settings before creating native peers.

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

## Server hardening (this patch)
- `GET /config` returns `iceServers` (STUN + TURN when env set). Web + Android should fetch it.
- `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` env wire TURN for symmetric NAT/CGNAT.
- `ALLOWED_ORIGINS` optional allowlist for WebSocket handshake.
- Rate limiting: 120 req/min/IP + 30 msg/5s per socket; `maxPayload 64k`.
- Message/history bounded: `messages >200 splice 100`; requests auto-prune after cancel/expire/approve.
- CSP + `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` etc. Also `<meta http-equiv CSP>` in `index.html`.
- `/health` + `SIGTERM`/`SIGINT` graceful shutdown; timed `host → cohost` promotion at 30s.

Client hardening: 1 → 30s exponential backoff reconnect (mirrors `RoomSoundWebSocketClient`), `captureNonce` race fix, `clampVolume`, listening `audioElement` is visually hidden but accessible (`aria-label` on control panel), `connectionState=failed` toast + retry, listener-leave peer cleanup, `fetch /config` before RTC.

## Prototype boundary

The prototype still uses an in-memory `rooms` map and WebRTC mesh (no SFU). Client `guestId` remains trusted until a JWT/session layer is added. For internet-scale, add TURN + SFU, persistent storage for rooms, and HttpOnly signed session for `guestId`.

Android-wide application audio also remains platform-dependent. The production Android client should use `MediaProjection` and Android playback-capture APIs; a web page cannot guarantee capture of Spotify, YouTube, or other native Android applications.

## Android client

The `android/` folder contains the native Kotlin capture and RoomSound client.
It requests `RECORD_AUDIO`, obtains one-time `MediaProjection` consent, starts
a media-projection foreground service, reads eligible playback as PCM16, and
uses native WebRTC for the room media plane. Build and device validation still
require a JDK 17/Android SDK toolchain plus a physical Android 10+ device for
meaningful playback-capture testing. See `android/README.md` for the native
transport boundary and device setup.
