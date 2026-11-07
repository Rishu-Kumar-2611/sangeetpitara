# Focused screens — 1.1.8

The welcome screen has three choices: Create a room online, Join a room online,
and Play Close over a hotspot/Wi-Fi network. Each opens its own focused screen
without opening a new tab. Only the website welcome screen offers an APK download.
The existing brass/teal theme is preserved.

Android room controls, chat, people, audio and status are separate screens. Welcome
and system Back return home; an active session offers Return to your room. The
Room screen exposes View local invite for a hosted local session. Audio playback
and capture remain mounted while navigating; the audio transport is unchanged.
Offline guests continue to use the embedded local browser page.

Validation: npm run build passed under Node 22.14.0; all 117 Node tests and eight
Playwright checks passed. Browser checks cover desktop/phone entry navigation,
room creation/joining/chat/reconnection/leaving and offline WebAudio/chat. Phone
and desktop welcome screenshots were visually reviewed. Android JVM tests, debug
assembly and lint passed. No physical Android device was connected, so native
screen layout and system Back still require a device check.
