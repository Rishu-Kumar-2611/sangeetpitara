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
- Fetches and stores `/config` ICE servers together with `mediaRelay`. A
  missing or unreachable relay configuration defaults to enabled PCM16 for
  safety; only `mediaRelay.enabled = false` selects direct WebRTC.
- Sends authorized 48 kHz mono PCM16 frames as bounded `RSR1` binary
  WebSocket packets when the relay is enabled. Relay listeners validate the
  packet, source epoch, and live-source authorization before AudioTrack
  playout.
- Provides `RoomAudioTransport`, which implements the capture `Pcm16Sink` seam
  and accepts frames only when this member is the live source for the current
  epoch.
- Fetches the server's `/config` ICE list for native WebRTC peers, including
  TURN credentials when the RoomSound server is configured with them; it
  falls back to the bundled Google STUN server if the config endpoint is
  unavailable.
- The activity now exposes native room controls: display name, create-room,
  join-room, connection state, room roster, source state, and leave-room. The
  WebSocket endpoint is embedded at build time rather than entered in the UI.
  The guest ID is generated once and persisted locally so a reconnect can
  reattach to the same server-side member.
- Android room creation, joining, and device-audio capture use anonymous guest
  identity only. There is no account UI, account client, encrypted session
  restore, or bearer token on the native room socket.
- Build-time endpoint configuration accepts `ws://`, `wss://`, `http://`, or
  `https://`. `http://` becomes `ws://`, and `https://` becomes `wss://` before
  the native client is created. The normal room UI does not display the raw
  endpoint or provide a manual connection probe.
- A local six-hour rewarded-access gate blocks room creation, joining, and
  capture until a 30-second completion callback. Offline builds use the
  explicit `LocalDemoRewardedAccessProvider` countdown; this is provider-neutral
  plumbing and **does not integrate a real ad SDK**.
  When `ROOMSOUND_DEFAULT_ENDPOINT` is omitted, debug emulator builds default
  to `ws://10.0.2.2:4173`. Physical-device builds and release emulator builds
  keep the endpoint unset rather than guessing a host.
- The activity binds `RoomAudioTransport` to the capture service when the
  service is available. Relay mode does not initialize native WebRTC peers or
  require a native WebRTC audio backend for capture. The direct WebRTC opt-out
  still reports initialization failures instead of allowing a session that can
  only drop its PCM frames.
- Hosts and co-hosts can approve or reject participant audio-control requests
  from Android system notifications while the Activity is backgrounded. Android
  13+ requests notification permission separately from playback-capture audio
  permission; the in-room approval controls remain available if notifications
  are denied.

The WebSocket client carries JSON control/signaling and the binary relay
fallback. Its `rtc` events carry the same JSON signaling envelopes used by the
web prototype. Relay PCM is never routed through the microphone.

## PCM/WebRTC boundary

`Pcm16FramePublisher` is the media-plane seam shared by the PCM16 relay and the
direct native WebRTC backend. `RoomAudioTransport` stamps accepted frames with
the authorized room source epoch, stops the publisher on an epoch/source
transition, and reports unauthorized, not-live, stale-epoch, invalid-format,
and unavailable-backend frames separately.

The relay publisher builds the exact 20-byte `RSR1` header followed by
little-endian PCM16 samples, uses a bounded uint32 sequence, and sends only
while the current room state authorizes this member as the live source. The
relay player uses a bounded single-thread queue and Android `AudioTrack` in
`STREAM_MUSIC`/streaming mode with per-player volume control. It never opens a
microphone. The default `UnavailablePcm16FramePublisher` still reports an
explicit `BACKEND_UNAVAILABLE` result when direct WebRTC is selected but its
native backend cannot initialize.

Relay playout deliberately favors freshness over a perfect buffer: sender
backlog is bounded near 125 ms, the Android queue keeps 12 frames, and the
`AudioTrack` buffer target is approximately 50 ms subject to the device's
reported minimum. When a listener falls behind, old frames are dropped so the
user hears a short gap instead of stale audio catching up seconds later.

When `mediaRelay.enabled` is true, the coordinator creates
`Pcm16RelayPublisher` and `Pcm16RelayPlayer`; native WebRTC peer creation is
not attempted. When it is false, the existing `WebRtcPcmPublisher` path,
including `/config` ICE/TURN handling and JSON `rtc` signaling, remains the
media backend.

Typical wiring for a future media backend is:

```kotlin
val client = RoomSoundWebSocketClient(BuildConfig.ROOMSOUND_DEFAULT_ENDPOINT)
val transport = RoomAudioTransport(client, verifiedNativePublisher)
controller.start(resultCode, projectionData, sink = transport)
```

The room UI can still be used for create/join and server-state validation. In
relay mode the transport snapshot exposes `mediaRelayEnabled = true`; the
separate capture-probe control continues to validate Android capture without
starting a native peer.

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

The RoomSound WebSocket endpoint is a build-time value. Set
`ROOMSOUND_DEFAULT_ENDPOINT` as either a Gradle property or an environment
variable; the Gradle property takes precedence when both are supplied. For
example, the exact property name for an emulator APK is:

```sh
./gradlew :app:assembleDebug \
  -PROOMSOUND_DEFAULT_ENDPOINT=ws://10.0.2.2:4173 \
  --no-daemon --console=plain
```

For a physical device, replace the value with the real reachable server
endpoint, or set the same name in the environment before building:

```sh
export ROOMSOUND_DEFAULT_ENDPOINT='ws://<reachable-lan-host>:4173'
./gradlew :app:assembleDebug --no-daemon --console=plain
```

The generated `BuildConfig.ROOMSOUND_DEFAULT_ENDPOINT` value is normalized to
the corresponding WebSocket scheme at runtime. A non-empty configured value is
never replaced by the emulator fallback, even when it is invalid; the app
reports a configuration failure without showing the raw endpoint. If no value
is supplied on a physical device or release emulator build, create/join stays
disabled and the room status reports that the APK needs a configured endpoint.

The offline unit-test, debug-assemble, and lint check used for this Android
slice is:

```sh
export ROOMSOUND_BUILD_DIR="${TMPDIR:-/tmp}/roomsound-android-build"
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug \
  --offline --no-daemon --console=plain
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

For a LAN build, set `ROOMSOUND_DEFAULT_ENDPOINT` to a reachable `ws://` or
`http://` server endpoint; the device must be on the same Wi-Fi. For a public
build, set it to the real `wss://` or `https://` server endpoint. The app
converts HTTP(S) input to the corresponding TLS or cleartext WebSocket scheme
without displaying the raw value. The local prototype still needs Android
cleartext networking for `ws://`/`http://`; production deployments should use
`wss://`/`https://` and remove broad cleartext allowances.

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
media app is needed to validate real playback capture. A real rewarded-ad
provider has not been connected; the current 30-second local/demo countdown is
only an offline-access stand-in.

For a local RoomSound server, build the APK with the server's reachable
WebSocket endpoint in `ROOMSOUND_DEFAULT_ENDPOINT`. A debug emulator uses
`ws://10.0.2.2:4173` only when that build-time value is omitted; a physical
device requires an explicitly supplied endpoint. The manifest permits
cleartext traffic for this local prototype; production deployments should use
`wss://` and remove that broad cleartext allowance. The device must be able to
reach the host, and Windows Firewall must permit the server port on the active
Private network.

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
