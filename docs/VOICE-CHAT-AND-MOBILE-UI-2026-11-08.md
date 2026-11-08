# Voice chat and mobile UI handoff — 8 November 2026

These changes remain local and uncommitted. The owner previously prohibited GitHub pushes until the UI is approved. Nothing in this iteration deploys or changes the public website, database, or release APK.

## What changed

- Voice messages on web and Android: microphone consent, 30-second maximum, 192 KiB maximum, preview/play/discard/send, bounded temporary room history. Music streaming continues independently of microphone recording.
- Replies to individual text or voice messages. Quote author and excerpt are derived from the room's history on the server; clients cannot forge the quoted author. Selecting a quote can locate the original while it is still in recent history.
- Real recordings use browser Opus/WebM (or another supported browser format) and native Android AAC/M4A. Built-in browser and Android media APIs are used; no new paid service, database table, or UI framework.
- Recording stops on backgrounding/leaving the chat section. Native unsent drafts and reply targets survive orientation changes; voice-note playback files are private temporary cache files.
- Voice-send retries have stable client IDs and server deduplication. Browser draft recordings remain available when sending is not confirmed. Incoming chat preserves the existing audio element rather than restarting a playing voice message.
- Routine room updates send small voice references instead of repeatedly retransmitting recording data. Browser/Android caches preserve playback and Android keeps recent chat across Activity recreation. Raw chat payloads and recording data are excluded from Android error logs.
- Server and Android-host validation check sizes, duration metadata, base64 and container signatures. Per-room/global voice-memory budgets expire old recording data while retaining message metadata. Large text frames and fragments are bounded; live binary PCM remains separately bounded.
- UTF-8 byte lengths in local WebSocket text frames are corrected for emoji and non-English text.
- Voice/reply capabilities are advertised by updated servers. The preview APK does not offer unsupported actions on older servers; normal text and music remain usable.
- Room, Chat, People and Health have separate web/local-room sections. Diagnostics use the content width. Phone entry forms omit the introductory hero. Smaller source artwork, fewer oversized panels, calmer type and clearer spacing retain Mehfil/Dark and Playground/Light.
- Privacy text describes temporary voice recordings and their cache/history behavior. Browser recording requires a secure context; ordinary HTTP hotspot pages can listen/reply, while microphone recording uses the APK or the localhost desktop companion.

## Validation

- npm run build: passed.
- npm test: 144 tests passed, followed by origin, payload and RTC checks.
- Full browser suite: 26 passed on desktop and phone projects. Eight targeted regressions passed again after final layout refinements.
- Public pages checked at 320/390/844/1024 widths, both themes. Room sections checked in phone portrait/landscape and desktop sizes; no horizontal overflow.
- Fourteen text/button/health contrast pairs exceeded 4.5:1; light muted text was darkened for raised surfaces as well.
- Android: 102 unit tests with zero failures/errors, assembleDebug and lintDebug passed. Includes native localhost voice/reply round trip above 64 KiB and emoji, format validation, server capability parsing and existing audio/authorization regressions.
- Running APK and browser interoperability: browser WebM note reached native Chat; a native AAC/M4A note played in the browser; a reply to that note was delivered. This used an emulator-owned temporary local room, not production.
- Android emulator screenshots checked portrait and landscape. Final landscape layout reduces header/panel spacing and places chat history beside the composer.
- A physical phone was not connected during verification; device-specific microphone, Bluetooth, hotspot and background behavior still needs owner testing.

## Review artifacts and publication boundary

- Current local web preview: http://127.0.0.1:4191 (in-memory test server; no production database).
- Android review build: android/artifacts/SangeetPitara-Preview.apk. Opt-in Gradle property ROOMSOUND_PREVIEW_BUILD=1 adds .preview to the application ID, so this debug-signed APK installs beside the existing signed app.
- Release application ID/version/configuration are unchanged. Public internet rooms need the matching backend update before the new chat features become available. Play Close includes its own updated host and works without publishing.
- Actual screenshots are in the session visualization directory under ui-review, including final-phone-light-chat.png and final-apk-landscape.png.

## Build instructions

After web theme/chat changes, run node desktop/sync-nearby-theme.mjs to refresh the bundled offline page. Build with JDK 17 and the installed Android SDK. For a separate preview, pass -PROOMSOUND_PREVIEW_BUILD=1. Omit that property for the normal application identity. Do not publish the preview build as a production release.

Before the public release, obtain the owner's authorization to push/deploy, bump the release/cache version coherently, publish the matching backend, release-signed APK and rebuilt Windows companion, and retest voice/replies with the actual phone. No data migration is required for these temporary chat features.
