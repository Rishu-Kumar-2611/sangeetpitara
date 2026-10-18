# RoomSound Android phase 2 transport slice

This module contains the Android playback-capture client and native RoomSound
media transport. It shares eligible Android device playback only; it never
opens or publishes a microphone input.

## Implemented behavior

- Requires Android 10/API 29 or newer for playback capture.
- Checks the playback-capture API and `MediaProjection` availability.
- Requests `RECORD_AUDIO` and one-time system capture consent.
- Runs capture in a `mediaProjection` foreground service.
- Reads eligible playback as in-memory PCM16 frames at 48 kHz mono.
- Displays captured and non-silent frame counts.
- Stops and releases `AudioRecord` and `MediaProjection` when capture ends.
- Uses pinned OkHttp `4.12.0` for a native `ws://`/`wss://` RoomSound client.
- Sends the existing `create-room` and `join-room` commands using a stable
  caller-provided `guestId`.
- Parses and exposes the existing `joined`, `state`, `error`, `chat`, source
  control, host/member, room lifecycle, and `rtc` signaling events. Unknown
  event types are surfaced instead of being silently treated as media.
- Reconnects with bounded exponential backoff after an unexpected socket loss.
  Once a room has been created, reconnect uses `join-room` with the returned
  room code and the same `guestId`; it does not create a second room.
- Tracks the server's `activeSourceId`, `sourceStatus`, and monotonically
  increasing `sourceEpoch`. Stale lower-epoch state is ignored.
- Provides `RoomAudioTransport`, which implements the capture `Pcm16Sink` seam
  and accepts frames only when this member is the live source for the current
  epoch.
- Fetches the server's `/config` ICE list for native WebRTC peers, including
  TURN credentials when the RoomSound server is configured with them; it
  falls back to the bundled Google STUN server if the config endpoint is
  unavailable.
- The activity now exposes native room controls: WebSocket endpoint, display
  name, create-room, join-room, connection state, room roster, source state,
  and leave-room. The guest ID is generated once and persisted locally so a
  reconnect can reattach to the same server-side member.
- It includes a connection probe and accepts `ws://`, `wss://`, `http://`, or
  `https://` endpoint input (HTTP schemes are converted to WebSocket schemes).
  Emulator builds default to `ws://10.0.2.2:4173`; physical devices start with
  an empty endpoint so they do not accidentally try to connect to the
  emulator-only address.
- The activity binds `RoomAudioTransport` to the capture service when the
  service is available. Capture start is rejected if native WebRTC
  initialization fails, instead of allowing a session that can only drop its
  PCM frames; the transport status explains the failure.

The WebSocket client is control/signaling only. Its `rtc` events carry the
same JSON signaling envelopes used by the web prototype; they do not carry
PCM audio.

## PCM/WebRTC boundary

`Pcm16FramePublisher` is the media-plane seam for the native WebRTC audio
backend. `RoomAudioTransport` stamps accepted frames with the authorized room
source epoch, stops the publisher on an epoch/source transition, and reports
unauthorized, not-live, stale-epoch, invalid-format, and unavailable-backend
frames separately.

The default `UnavailablePcm16FramePublisher` intentionally drops frames with
an explicit `BACKEND_UNAVAILABLE` result. The active native publisher accepts
only Android playback PCM; there is no microphone fallback, generated test
source in the Android UI, fake publisher, or PCM-over-WebSocket path. The
native WebRTC audio-device integration is backed by the pinned WebRTC SDK and
its diagnostics expose queue, ADM callback, playout, and peer state.

Typical wiring for a future media backend is:

```kotlin
val client = RoomSoundWebSocketClient("wss://example.invalid/roomsound")
val transport = RoomAudioTransport(client, verifiedNativePublisher)
controller.start(resultCode, projectionData, sink = transport)
```

The room UI can still be used for create/join and server-state validation with
the default publisher; its transport snapshot shows `backendReady = false`
and source controls remain disabled until a real publisher is supplied. The
separate capture-probe control continues to validate Android capture without
sending media.

`PlaybackCaptureService.LocalBinder.setPcm16Sink(...)` can install the
`RoomAudioTransport` before the next `ACTION_START`; if no sink is installed,
the existing probe continues to capture only in memory and publishes no media.

## Build and run

The Android SDK and JDK 17 are external prerequisites; they are not bundled
with this workspace. The Gradle wrapper is checked in and pins Gradle 8.9 with
a SHA-256 distribution check, so do not install a second global Gradle version.
Android SDK Platform 35 and Build-Tools are required. App dependency versions
are locked in `app/gradle.lockfile`.

Once the toolchain and dependency access are available, run from this folder:

```text
./gradlew :app:assembleDebug --no-daemon --console=plain
```

The build declares OkHttp `4.12.0` and the WebRTC SDK from Maven Central. If
the checkout is under OneDrive or another synchronised folder, generated
output can be locked while Gradle replaces it. Use the project-supported
external build directory switch instead of deleting random Gradle caches:

```powershell
$env:ROOMSOUND_BUILD_DIR = Join-Path $env:TEMP "RoomSoundAndroidBuild"
./gradlew.bat :app:assembleDebug --no-daemon --console=plain
```

The equivalent Linux/macOS command is:

```sh
export ROOMSOUND_BUILD_DIR="${TMPDIR:-/tmp}/roomsound-android-build"
./gradlew :app:assembleDebug --no-daemon --console=plain
```

`ROOMSOUND_BUILD_DIR` (or `-Proomsound.buildDir=...`) moves generated project
output only; source files and the Gradle wrapper remain in this checkout.

Debug APKs accept `ws://` endpoints for private/local addresses such as
`10.x.x.x`, `172.16.x.x`–`172.31.x.x`, and `192.168.x.x`, which makes same-Wi-Fi
laptop testing possible. Release builds should use `wss://`; the release
manifest does not enable Android cleartext traffic and non-local insecure
endpoints are rejected by the app.

### Signed release APK

Release signing never uses a password embedded in the build script. Supply the
four values from a local secret store, shell environment, or CI secret:

```powershell
$env:ROOMSOUND_BUILD_DIR = Join-Path $env:TEMP "RoomSoundAndroidBuild"
$env:ROOMSOUND_KEYSTORE = "$PWD\app\roomsound-release.keystore"
$env:ROOMSOUND_KEYSTORE_PASSWORD = "<local keystore password>"
$env:ROOMSOUND_KEY_ALIAS = "<local key alias>"
$env:ROOMSOUND_KEY_PASSWORD = "<local key password>"
./gradlew.bat :app:assembleRelease --no-daemon --console=plain
```

Use `export` and `./gradlew` on Linux/macOS. The release task fails early with
an actionable message if any value is missing or the keystore path is invalid.
The APK is produced at
`$ROOMSOUND_BUILD_DIR/app/outputs/apk/release/app-release.apk` when the
external directory is enabled. Copy it to `android/artifacts/` for local
distribution if desired; that directory is ignored by git.

If Gradle reports `Unable to delete directory` or `AccessDeniedException` under
`app/build`, stop stale Gradle/Java processes and rerun with
`ROOMSOUND_BUILD_DIR` outside the synchronised checkout. A 30-second terminal
timeout is not a Gradle failure; allow the full command to finish and inspect
the `BUILD SUCCESSFUL`/`BUILD FAILED` footer.

The Android SDK must be installed and configured using Android Studio or
`ANDROID_HOME` / an uncommitted `local.properties` file; JDK and the wrapper
alone are insufficient.

Android Studio can be launched with:

```powershell
& "C:\Program Files\Android\Android Studio\bin\studio64.exe"
```

In SDK Manager, install Android SDK Platform 35, Android SDK Build-Tools,
Android SDK Platform-Tools, and Android SDK Command-line Tools (latest). With
the default SDK location, create the machine-local Gradle pointer from the
`android/` directory with:

```powershell
$sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
if (-not (Test-Path -LiteralPath (Join-Path $sdk "platforms\android-35\android.jar"))) {
    throw "Android SDK Platform 35 is not installed at $sdk"
}
"sdk.dir=$($sdk.Replace('\', '/'))" | Set-Content -Encoding ascii "local.properties"
```

Do not commit `local.properties`; it contains a machine-specific SDK path.

Install the debug APK on a physical Android 10+ device. An emulator can
validate the permission and service UI, but a physical device with an eligible
media app is needed to validate real playback capture.

For a local RoomSound server, construct the client with the server's reachable
WebSocket endpoint, for example `ws://192.168.1.20:4173`. The activity starts
with the Android-emulator endpoint `ws://10.0.2.2:4173` only on an emulator;
on a physical device enter the computer's LAN IPv4 address. The manifest
permits cleartext traffic for this local prototype; production deployments
should use `wss://` and remove that broad cleartext allowance. The device must
be able to reach the host, and Windows Firewall must permit port 4173 on the
active Private network.

## Expected platform limitations

Playback capture is not unrestricted hardware-output capture. The source app
can opt out, protected/DRM content can be unavailable, and silence is
ambiguous between a paused source and a blocked source. The probe deliberately
reports `NO_ACTIVE_PLAYBACK` rather than claiming that every application is
capturable.

Room membership and source authorization are server state. Android permission
grant, a connected WebSocket, or a `STARTING` source state alone does not make
the client a live publisher. Frames are accepted by `RoomAudioTransport` only
after a `LIVE` state for this member and the matching source epoch.
