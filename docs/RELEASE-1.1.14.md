# SangeetPitara 1.1.14

The owner authorized publishing the website and Android app on 8 November 2026, replacing the earlier local-only UI review boundary.

## User-visible changes

- Mehfil Dark and Playground Light replace the four older palettes on web, native Android and the offline listening page. Existing saved dark palettes migrate to Mehfil.
- Minimal welcome screen with separate Create, Join and Play Close flows. Android has no APK download promotion.
- Room, Chat, People and Health use separate sections. Health uses the available content width instead of an overflowing sidebar, and the header no longer overlaps it.
- A compact web player summary keeps the active source and audio controls within reach outside Room. Phone portrait navigation sits at the bottom with safe-area spacing; short landscape screens retain top tabs.
- Real audio-reactive bars use the theme accent, settle during silence and stay still for reduced-motion preferences. Navigation does not tear down playback.
- Calmer surfaces, consistent arrows and spacing, smaller artwork and controls, and portrait/landscape reflow on Android and web.
- Voice notes and quoted replies are available in updated internet and local rooms. Recordings are temporary and bounded; they require microphone consent. Browser hotspot microphone recording requires a secure context; the Android app and localhost companion support recording.

## Packaging

Version 1.1.14 / Android versionCode 10114. Shared browser assets use cache identity 20261108-mehfil1. The offline page is synchronized before packaging. Android release signing uses the existing protected CI secrets and normal application ID. The separate debug preview is not a public release.

No database migration or paid-resource change is required. Release publication also refreshes the Windows companion's offline page.

## Verification

Local Node suite: 144 tests plus origin, payload and RTC checks. Android unit tests, debug assembly and lint passed. Isolated release checks exercised room creation, requests, moderation, takeover, reconnect and leaving. Browser checks cover both themes, voice notes/replies, portrait/landscape, desktop and offline-room sharing. Public verification checks release asset contents, health/readiness, downloads and WebSocket behavior after rollout.

Physical-device microphone, hotspot and background behavior still needs testing on the owner's phone; emulator interoperability evidence is recorded in VOICE-CHAT-AND-MOBILE-UI-2026-11-08.md.
