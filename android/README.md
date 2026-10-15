# RoomSound Android phase 2 transport slice

This module contains the Android playback-capture probe plus the native
RoomSound room control-plane client. The implementation is deliberately split
between signaling/control and media transport so that Android playback PCM is
never mistaken for a working WebRTC publisher.

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
  service is available. Source controls remain disabled if native WebRTC
  initialization fails, instead of allowing a capture session that can only
  drop its PCM frames; the transport status explains the failure.

The WebSocket client is control/signaling only. Its `rtc` events carry the
same JSON signaling envelopes used by the web prototype; they do not carry
PCM audio.

## PCM/WebRTC boundary

`Pcm16FramePublisher` is the media-plane seam for a future native audio
backend. `RoomAudioTransport` stamps accepted frames with the authorized room
source epoch, stops the publisher on an epoch/source transition, and reports
unauthorized, not-live, stale-epoch, invalid-format, and unavailable-backend
frames separately.

The default `UnavailablePcm16FramePublisher` intentionally drops frames with
an explicit `BACKEND_UNAVAILABLE` result. There is no microphone fallback,
generated test tone, fake publisher, or PCM-over-WebSocket path in this
module. The Android SDK's public Java APIs do not provide a supported way to
inject arbitrary `AudioRecord` PCM into a WebRTC sender. A real implementation
will need a verified native WebRTC audio-device/custom-source integration (and
its own tested artifact/build configuration) before this seam can be backed by
live media. No speculative WebRTC dependency is included.

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
with this workspace. A Gradle wrapper is not checked in yet. Open `android/`
in Android Studio, or install JDK 17, Gradle 8.9, and Android SDK platform 35
before building from a terminal.

Once the toolchain and dependency access are available:

```powershell
gradle :app:assembleDebug
```

The build declares OkHttp `4.12.0` from Maven Central. JDK `17.0.20.1` and
Gradle `8.9` were verified locally after repairing the Windows installation.
The Android SDK now installs successfully through Gradle, but a normal build
under this OneDrive-backed workspace hit a Windows `AccessDeniedException`
while Kotlin tried to replace `app/build/kotlin/compileDebugKotlin` caches.
That is a generated-output/OneDrive lock, not a source compilation error.
JDK `17.0.20.1`, Gradle `8.9`, Android SDK Platform 35, dependency resolution,
Kotlin compilation, Java compilation, resource processing, and APK packaging
were verified by relocating the temporary Gradle build directory outside
OneDrive. The resulting debug APK was 3,787,875 bytes with SHA-256
`18BBA602000F85C855696D35C4086EAE7E71B181475F3F54AEDEB01E05036A5D`.

The build emitted a non-fatal SDK XML warning because the installed Android
command-line tools understand an older SDK XML version than Android Studio.
Update Android SDK Command-line Tools from SDK Manager when convenient.

If Gradle is not installed on Windows, install JDK 17 and Gradle 8.9 (the
minimum Gradle line for the pinned Android Gradle Plugin) from PowerShell:

```powershell
winget install --id Microsoft.OpenJDK.17 -e

# Accept the installer elevation prompt. Then reopen PowerShell so Java's
# installer-provided environment changes are visible.
$ErrorActionPreference = "Stop"
$version = "8.9"
$zip = Join-Path $env:TEMP "gradle-$version-bin.zip"
$root = Join-Path $env:LOCALAPPDATA "Gradle"
$url = "https://services.gradle.org/distributions/gradle-$version-bin.zip"
curl.exe --fail --location --retry 3 --output $zip $url
if ($LASTEXITCODE -ne 0) { throw "Gradle download failed; do not extract a partial ZIP." }
$expectedHash = (Invoke-RestMethod "$url.sha256").ToString().Trim()
if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expectedHash) {
    throw "Gradle ZIP checksum mismatch; download it again before extracting."
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $root -Force
$gradleHome = Join-Path $root "gradle-$version"
if (-not (Test-Path -LiteralPath "$gradleHome\bin\gradle.bat")) {
    throw "Gradle extraction did not complete."
}
[Environment]::SetEnvironmentVariable("GRADLE_HOME", $gradleHome, "User")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$gradleBin = Join-Path $gradleHome "bin"
if (($userPath -split ";") -notcontains $gradleBin) {
    [Environment]::SetEnvironmentVariable("Path", "$gradleBin;$userPath", "User")
}
```

Do not name a variable `$home`: PowerShell treats it as the read-only built-in
`$HOME`, regardless of capitalization. Use `$gradleHome` instead.

Installation does not update the environment of already-running terminals or
OmniRush.ai. Restart them, or refresh the current PowerShell environment:

```powershell
$env:JAVA_HOME = [Environment]::GetEnvironmentVariable("JAVA_HOME", "User")
if (-not $env:JAVA_HOME) {
    $env:JAVA_HOME = [Environment]::GetEnvironmentVariable("JAVA_HOME", "Machine")
}
$env:GRADLE_HOME = [Environment]::GetEnvironmentVariable("GRADLE_HOME", "User")
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
java -version
gradle --version
```

Then run `gradle :app:assembleDebug` from `android/`. The Android SDK must
also be installed and configured using Android Studio or `ANDROID_HOME` /
an uncommitted `local.properties` file; JDK and Gradle alone are insufficient.

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
