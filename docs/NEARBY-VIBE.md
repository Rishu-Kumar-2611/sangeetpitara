# Nearby Vibe — offline hotspot rooms (1.1.5)

The Android host serves an ephemeral room and a bundled browser listening page
on port 8765. The audio path is Android playback capture → loopback WebSocket →
embedded server → hotspot/Wi-Fi guests. No cloud signaling, database, STUN,
external scripts, fonts, account login or internet audio relay is required.

## Use

1. Connect the host to Wi-Fi or enable its hotspot in Android Settings.
2. In the app's Nearby Vibe card, enter your name and tap Host & create nearby
   room. This creates the local room automatically.
3. The offline invite appears directly in the card. Use Copy local invite or
   Share invite. If no address is shown, enable hotspot/Wi-Fi and Refresh invite.
4. Friends connect to that same network and open the link in their browser.
   Android guests can use Join nearby invite in browser inside the app.
5. Friends enter their name and tap Join and listen. The host uses Share device
   audio and grants Android capture consent. Play an app that permits capture.
6. Leave/end using room controls; keep the host phone and hotspot running.

The website's Nearby Vibe section explains the flow and opens a private local
invite. The website cannot itself enable a hotspot or host Android device audio.
Guests use the locally served page, not the public site's online room.

## Scope and limits

This first version supports one Android host, at most nine guests, host audio
and room chat. Guest source handoff/co-host controls are not supported locally.
The host enables hotspot manually; automatic hotspot provisioning and QR invites
are not included. Interface addresses are listed because Android hotspot IPs vary.
Some routers enable client isolation; use a network that permits local clients to
reach the host. Guest browser playback/background rules vary by OS.

This is a trusted-local-network transport, not end-to-end encrypted media. Use a
password-protected hotspot and share the invite privately. Native app cleartext
is allowed only for 127.0.0.1/localhost; public internet connections remain HTTPS.
An unguessable invitation gates guest WebSockets; a separate loopback-only owner
capability gates creation/publication. Reconnect secrets never appear in rosters.

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

The database migration is intentionally separate. Render remains the public
service's database until its existing data is securely migrated to Neon.

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
