# Owner checks and store handoff

## What can be tested now

The public website/APK remain 1.1.13. On that release, test stable playback in
both directions, repeated approval/source handoff, pause/resume, leaving during
reconnection, background/locked screen, battery saver, calls, headphones/Bluetooth,
and a temporary network outage. In Play Close, test with mobile data disabled
while both devices stay on the same hotspot. Record receiving-device health when
a cut happens, not just the publishing panel.

Record device models, Android/browser versions, online/local mode, whether the
screen was locked, and approximate failure time. Do not include passwords, full
invite links or unrelated personal messages in screenshots sent to support.

Once the final UI build is signed and supplied, repeat those checks and save
paired audio diagnostics immediately after a glitch. The new export is part of
the unpublished hardening branch, so it is not yet available in public 1.1.13.
Confirm Android's document picker can save/read the JSON, exports omit room/name
details, and collecting/exporting does not interrupt music. Test TalkBack, large
text and small screens after the final visual pass.

Suggested acceptance: at least one hour in each direction without an unexpected
exit or audible cut on a stable network. During a real outage, note its duration
and confirm the room recovers without manual recreation. This is a proposed app
test gate, not a promise that buffered live audio can survive an unlimited outage.

## Decisions/account work

- Choose backup destination and retention; keep a recoverable encryption key
  offline, separately from the archive. A manual encrypted-backup workflow is
  prepared, but no recurring production backup is enabled yet.
- Choose the monitoring recipient/channel and configure a private monitor using
  `ops/alerts.yml`. The rule file is not an active notification service.
- Keep the original Android signing key and an independent protected recovery
  copy. Do not share it, its password, backup keys or database URLs in this chat.
- Complete the Play Console account, tester and release requirements applicable
  to the account. The agent cannot perform physical listening or account-holder
  identity/declaration decisions for the owner.

## Store preparation

Package ID: `com.roomsound.android`. Product: SangeetPitara. Support:
`[support email]`. Privacy policy:
https://sangeet-pitaraa.onrender.com/privacy.html

Draft short description: "Listen together online or nearby, with host-approved audio sharing."

Verify the final app's foreground-service declarations and provide accurate
capture-use evidence for review. Keep Android's per-session capture consent;
it is a platform requirement, not an app button defect.
https://developer.android.com/media/grow/media-projection

Review the actual audio, room/account/moderation and optional diagnostic data
flows in the Data Safety form. Ephemeral off-device processing still belongs
in the form response; lack of disk recording alone does not justify declaring
that no data is collected. The internet relay uses TLS but is not end-to-end
encrypted. Local downloads are not automatically uploaded to support.
https://support.google.com/googleplay/android-developer/answer/10787469

Finish screenshots/store graphics after the final UI, using synthetic room and
participant names. Complete the appropriate internal/closed testing, privacy and
foreground-service declarations and verify the current target/API requirements.
Do not publish ads, paid entitlements or payment flows while they remain disabled
and unvalidated. Submission is not completed by merely producing a signed AAB.
