# Playback stability and request alerts — 1.1.10

Welcome cards use identical right arrows, aligned to the same right inset and
vertical center at desktop and phone sizes.

The local server now separates control-command limits from audio traffic. A
bounded PCM byte budget drops excessive audio rather than disconnecting a room
because a recorder backlog arrived in a burst. A real WebSocket regression test
sends 160 queued packets followed by six silence/music cycles and verifies exact
relay delivery plus working chat without leaving the room. Native source types
are preserved through requests, grants and LIVE state so the Android consent
transaction can confirm its source lease. The previous release's fixed generic
source type did not match Android's expected source type.

Media-session Stop now pauses local listening. Leaving a room remains an explicit
room/notification action. A transient disconnect keeps the room screen open with
a reconnecting message instead of returning to welcome. Genuine Android consent
revocation still stops capture and requires fresh consent; it cannot be bypassed.

On Android 14+, capture requests the default display using MediaProjectionConfig.
Android's user confirmation is retained. Device manufacturers may customize the
consent UI. See [Android media projection documentation](https://developer.android.google.cn/media/grow/media-projection?hl=en).

Local requests emit control-requested events. Foreground hosts/co-hosts get a
request-specific approval dialog; background requests use the existing
high-importance notification channel with Approve/Reject actions. Repeated state
refreshes do not repost the same notification. Android notification permission,
channel settings and Do Not Disturb still control background alert delivery.

The People screen exposes automatic music pausing. Android Notification Access
allows pause commands to external media sessions, including buffering players.
Remote room listening requests full audio focus instead of ducking another app.
This does not mute the whole phone or silence the incoming participant's music.
Other apps must honor Android playback controls/focus; system sounds and calls
are not controlled. Approval never starts the participant's capture without their
system consent.

Physical Android pause/play, notification display and YouTube Music handoff need
device verification. No physical Android device is connected to this workspace.

Validation: 88 Android JVM tests, debug APK assembly and lint passed; the build
check and all 117 Node tests passed on Node 22.14.0; all ten Playwright checks
passed at desktop/phone sizes. Browser checks measure each welcome arrow's
horizontal alignment, vertical centering and direction. The phone welcome
screenshot was also visually reviewed.
