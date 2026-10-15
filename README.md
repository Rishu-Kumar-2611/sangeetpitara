# RoomSound prototype

RoomSound is a small, runnable web prototype for the private audio-room idea. It includes:

- Account-less room creation and joining by code or invite link
- Device-local guest identity
- Up to 10 people in a room
- Host, co-host, participant, and active-source state
- WebRTC audio publishing with a lightweight WebSocket signaling server
- Browser display/tab-audio capture where supported
- Microphone and generated test-audio fallbacks
- Host approval/rejection of participant source requests
- Host takeover and participant-to-host source resumption
- Co-host promotion after host disconnect
- Text chat, roster presence, local mute, and volume controls
- No audio recording

## Run it

Requirements: Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://localhost:4173` in a current browser. To test the room flow, open the URL in two browser windows or on two devices that can reach the machine running the server.

For audio capture, use a secure context (`localhost` is allowed by browsers) and expect a browser permission prompt. Desktop Chrome and Edge are the most useful first targets for browser-tab audio. Mobile browsers generally cannot capture audio from a separate native app.

With the server running in another terminal, the repeatable room-control smoke test is:

```powershell
npm run smoke
```

It exercises room creation, guest joining, rejection and approval, blocked competing requests, host takeover, co-host assignment, and immediate co-host promotion after the host leaves.

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

Create `.env` from `.env.example` first. For a deployment, use HTTPS/WSS at a reverse
proxy, set `ALLOWED_ORIGINS`, and provide TURN values (`TURN_URLS`, `TURN_USERNAME`,
and `TURN_CREDENTIAL`) when clients may be behind restrictive NATs. The Android
client fetches the same `/config` ICE settings before creating native peers.

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

## Android phase 2A probe

The `android/` folder contains a native Kotlin capture probe. It requests `RECORD_AUDIO`, obtains one-time `MediaProjection` consent, starts a media-projection foreground service, and reads eligible playback into an in-memory PCM16 sink. It intentionally does not record audio or connect to the room yet. Build and device validation require Android Studio or a JDK/Gradle/Android SDK toolchain, plus a physical Android 10+ device for meaningful playback-capture testing.
