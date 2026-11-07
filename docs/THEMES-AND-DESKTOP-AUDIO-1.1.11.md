# Themes and local desktop audio — 1.1.11

The top Theme picker offers Brass, Midnight, Forest and Rose. Website and bundled
offline pages save the choice in local browser storage; Android uses private
preferences and semantic theme attributes for panels, fields, text and controls.
Changing an Android theme recreates the Activity while the service-owned room
and capture remain alive. Entry fields and the selected room screen are retained.

Ordinary hotspot HTTP origins cannot use screen capture. The Windows x64 desktop
companion serves the same bundled room UI through a loopback-only origin, which
supports the browser's capture picker. It includes its own checksum-verified
official Node.js 24 runtime and the ws license; no Node installation is needed.
The release workflow publishes SangeetPitara-Desktop-Windows.zip with the APK.

Use:

1. Update the Android host and start a fresh Play Close room.
2. Connect the laptop to the host's hotspot/Wi-Fi.
3. Extract the Windows companion ZIP and run Start Play Close.cmd. Keep it open.
4. Paste the host's complete new invite into the companion's local page and join.
5. Ask for control. After approval, choose Share screen / system audio.
6. In Chrome/Edge, select Entire screen and Share system audio, or a browser tab
   with Share tab audio. Browser confirmation remains required.

Only 48 kHz mono PCM audio is relayed; video frames are never transmitted. Capture
is stopped on revocation, leaving, browser Stop sharing or cancellation. An
approval revoked while the picker is open cannot start a late publisher. Missing
audio produces instructions rather than silently falling back to a microphone.
Saved-file publishing and ordinary HTTP listening are retained.

The browser talks only to its loopback companion. The companion fetches the
host's public certificate without sending a room identity, verifies its SHA-256
pin from the invite, and uses strict TLS with that certificate for the local
WebSocket. It does not install certificate authorities or disable TLS verification.
Host/Origin checks and a per-process pairing token protect the loopback service.
Only private literal IPv4 invitations are accepted in production. Room capability
and host certificate scope separate reconnect identities; Android local guests
derive a per-pairing secret instead of revealing their public-room capability.

The initial download requires internet. Later room transport stays on the LAN;
the source music app may independently need internet. Capture availability is
controlled by Chrome/Edge, the OS and the source application's protections.
See [Chrome screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls).

Validation: 119 Node tests, 89 Android JVM tests, Android debug assembly/lint and
14 desktop/phone browser checks passed. Browser tests use a simulated picker with
real WebAudio and real pinned local TLS to verify non-silent PCM, approval,
revocation during capture and during the picker, and missing-audio behavior.
Four theme choices, persistence, layout and room continuity are checked. Theme
previews were visually reviewed. The packaged Windows runtime starts successfully
and serves its UI; runtime, launcher and licenses are present, test keys excluded.
The production container passes isolated PostgreSQL readiness/login/asset checks.
Physical Android theme switching and actual OS-wide browser capture still need
device verification; the automated picker test does not prove OS capture support.
