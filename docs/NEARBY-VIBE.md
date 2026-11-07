# Nearby Vibe — offline hotspot rooms (1.1.5)

The Android host serves an ephemeral room and a bundled browser listening page
on port 8765. The audio path is Android playback capture → loopback WebSocket →
embedded server → hotspot/Wi-Fi guests. No cloud signaling, database, STUN,
external scripts, fonts, account login or internet audio relay is required.

## Use

1. Connect the host to Wi-Fi or enable its hotspot in Android Settings.
2. From the app's welcome screen, open Play Close, enter your name and tap Host & create nearby
   room. This creates the local room automatically.
3. Open View local invite from the Room screen. Use Copy local invite or
   Share invite. If no address is shown, enable hotspot/Wi-Fi and Refresh invite.
4. Friends connect to that same network and open the link in their browser.
   Android guests use Play Close → Join nearby room in app and paste the complete
   invite to listen and share device audio. Browser guests can listen or share
   local music files.
5. Friends enter their name and tap Join and listen. The host uses Share device
   audio and grants Android capture consent. Play an app that permits capture.
6. Leave/end using room controls; keep the host phone and hotspot running.

The website's separate Play Close screen explains the flow and opens a private local
invite. The website cannot itself enable a hotspot or host Android device audio.
Guests use the locally served page, not the public site's online room.

## Scope and limits

Rooms support one Android host and at most nine guests, audio handoff and chat.
Participants request a turn; the host/co-host approves, rejects or directly grants
control. The host can assign a co-host and take audio control back. Android
publishers must still accept Android's capture consent; approval never starts
capture automatically. Browser publishers choose a local music file and tap Play.
The host enables hotspot manually; automatic hotspot provisioning and QR invites
are not included. Interface addresses are listed because Android hotspot IPs vary.
Some routers enable client isolation; use a network that permits local clients to
reach the host. Guest browser playback/background rules vary by OS.

This is a trusted-local-network transport, not end-to-end encrypted media. Use a
password-protected hotspot and share the invite privately. Native app cleartext
is allowed only for 127.0.0.1/localhost; public internet connections remain HTTPS.
An unguessable invitation gates guest WebSockets; a separate loopback-only owner
capability gates creation and ending the room. The server checks the selected
source and epoch again for every audio packet, including participant publishers.
Reconnect secrets never appear in rosters.

Per-peer writer queues prevent one slow guest from blocking the room. Audio is
bounded to 200 packets per peer; the browser buffer adapts up to three seconds.
The HTTP reader pool is capped at 24; inactive reads time out after 30 seconds.
The pinned NanoHTTPD 2.3.1 WebSocket implementation is vendored as NearbyWSD with
its BSD license, a 65,556-byte pre-allocation limit and fragmentation rejection.
Only nanohttpd core remains a dependency. Original source is from Maven Central's
nanohttpd-websocket-2.3.1-sources.jar; changes are limited to package/class naming
and these parser bounds. The distribution license is retained in source and the
APK's offline page. Large/delayed bursts beyond queue bounds can still drop audio.

## Validation

JVM integration tests start the real embedded HTTP/WebSocket host and exercise
local page/config, invitation joining, host-only publication, exact PCM relay,
stale epoch rejection, chat and room ending. Parser tests reject oversized and
fragmented frames before payload allocation. Playwright runs the bundled page at
desktop/phone sizes and verifies active WebAudio playback plus chat with all
external requests blocked. Physical Android hotspot/device tests are still needed;
these software checks do not prove acoustic synchronization or flawless RF.

The public service now uses Neon after the verified migration described in
DATABASE-MIGRATION-2026-11-07.md. Local rooms remain independent of the database.

Verified software checks for this release: 81 Android JVM tests, debug APK
assembly and lint passed; 116 Node tests passed on Node 22.14.0; six Playwright
desktop/phone checks passed, including offline WebAudio and chat. No physical
Android device was connected. A local release-signing attempt refused to proceed
without private keys; public signing uses the existing GitHub release secrets.

The network is offline, not a music download service: the host needs downloaded
or locally playable content. Android apps that prohibit playback capture remain
unsupported by the operating system.

## Invite and UI refinement (1.1.6)

Hosting now creates the room in one action. Its local invite stays visible and
selectable, with Copy/Share controls disabled until an address is available.
Normalized owner endpoint matching prevents showing a local invite for an online
room. The website gives explicit invite instructions, restores its desktop grid
and uses a compact phone layout. Offline guest pages share the warm brass theme.
Validation: 117 Node tests, 81 Android JVM tests, debug assembly/lint, and six
browser checks passed. Desktop and phone landing screenshots were visually
reviewed. Physical Android UI/hotspot testing still requires a connected device.

### Local address correction (1.1.7)

Local invite selection now excludes cellular and VPN interfaces and prioritizes
hotspot interfaces ahead of ordinary Wi-Fi/Ethernet. This prevents Copy invite
from selecting an unrelated private mobile-data address. Two JVM policy tests
cover exclusion and ordering. Both the website and the offline listener retain
the existing warm brass/teal theme; responsive previews were reviewed at 390px
and 1440px. Hosting and sharing still require a real local network address.

## Participant audio control (1.1.9)

Update both host and Android guest apps, start a fresh room and copy a fresh
invite. New invitations carry a local TLS port and a SHA-256 certificate pin.
Android guests use that encrypted, pinned connection; public HTTPS trust and the
loopback-only cleartext policy remain unchanged. The host's private key stays in
[Android Keystore](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec).
Invites accept only literal private IPv4 addresses; hostname and certificate pin
must both match. Redirects are disabled for the paired client. The original HTTP
browser listener remains available on the trusted hotspot.

Host/co-host audio requests and direct grants are available under People in the
Android app. Use Room for sharing/stop/take-back controls. Pending requests expire
after two minutes and an unused approved slot expires after one minute. Revocation,
leaving, removal and source changes invalidate the previous source's audio.
Browser guests can share audio files stored on their device after approval; they
cannot capture audio from other phone apps through the HTTP browser page. Android
app guests can share eligible device playback with system consent.

Tests cover real local WebSocket request/rejection/approval, co-host takeover,
direct grant, exact participant PCM delivery and rejected stale/revoked packets.
A real TLS server is tested with the pinned client, including rejecting a wrong
certificate; invite parsing rejects public/invalid addresses. Browser checks play
a generated WAV through WebAudio, verify non-silent transmitted PCM and verify
that host revocation stops the publisher, with external requests blocked.
Physical Android-to-Android hotspot/TLS/consent testing is still required.
Release checks: 86 Android JVM tests, debug APK assembly and lint passed;
117 Node tests and the build check passed on Node 22.14.0; all ten desktop/phone
Playwright checks passed. Host key preparation runs on a worker so first-use
Android Keystore generation does not block the welcome screen.
