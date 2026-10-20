# RoomSound device QA checklist

Use this checklist with the current TURN-backed local server before changing
the relay provider or moving to a larger deployment architecture.

## Test setup

- [ ] Start the server with `npm start` from the repository root.
- [ ] Confirm the startup log says `TURN configured`.
- [ ] Confirm the safe `/config` check reports `TURN present` without printing
      the username or credential.
- [ ] Open the laptop browser at `http://localhost:4173`.
- [ ] Configure the Android app with the laptop LAN WebSocket endpoint, for
      example `ws://10.229.42.89:4173`.
- [ ] Use a fresh room code for each independent scenario.
- [ ] Keep TURN credentials in the ignored local `.env` only.

## Core audio flow

### Laptop to Android

- [ ] Create a room in the laptop browser.
- [ ] Join from Android.
- [ ] Start browser **device/browser audio** and choose a tab or screen with audio.
- [ ] Confirm Android hears the test signal.
- [ ] Confirm browser telemetry reaches `connected` and shows received RTP.
- [ ] Run continuously for 5 minutes without a force-close or UI stall.

### Laptop device/browser audio to Android

- [ ] Stop browser device/browser audio.
- [ ] Start browser **Device / browser audio** from `localhost`.
- [ ] Select a tab or window that is actively playing audio and enable
      **Share audio** in the browser picker.
- [ ] Confirm Android hears the source.
- [ ] Confirm RTP counters continue increasing.

### Android to laptop

- [ ] Stop the browser source.
- [ ] In the Android app's **Playback sharing** panel, enable Android
      Notification Access if automatic pause-on-handoff is required.
- [ ] Request audio control from Android if the room requires approval.
- [ ] Approve the request in the laptop browser.
- [ ] Grant Android playback-capture consent.
- [ ] Play an eligible Android audio source.
- [ ] Confirm the laptop hears it.
- [ ] Approve a competing source and confirm the Android media app pauses when
      Notification Access is enabled; record any player that does not expose a
      controllable media session.
- [ ] Confirm native diagnostics show nonzero offered and ADM PCM samples.
- [ ] Confirm `pcmAdmSamples` does not rapidly outrun captured samples and
      `underrunSamples` remains stable or grows slowly.

## Room control

- [ ] Reject a participant request and confirm capture does not start.
- [ ] Approve a participant request and confirm the source changes cleanly.
- [ ] Use **Take control back** and confirm the original source is revoked.
- [ ] Stop and resume Android sharing with fresh system consent.
- [ ] Leave and rejoin the room using the same Android guest identity.
- [ ] Remove a participant and confirm the removed client does not reconnect.
- [ ] Promote a co-host, disconnect the host, and confirm promotion behavior.

## Lifecycle and network resilience

- [ ] Background Android RoomSound for 30–60 minutes while audio is active.
- [ ] Lock the Android screen and confirm the foreground service remains active.
- [ ] Reopen the app and confirm service-owned room/session reattachment.
- [ ] Stop the source, force a brief Wi-Fi drop, reconnect, and retry audio.
- [ ] Test a Wi-Fi-to-mobile-data transition if available.
- [ ] Deny capture consent, confirm a clear error, and retry successfully.
- [ ] Test an Android source that opts out of playback capture and confirm the
      app reports no active playback rather than claiming successful audio.

## Release gates

- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm run smoke` with the server running
- [ ] `android/gradlew :app:assembleDebug --offline --no-daemon --console=plain`
      using an external `ROOMSOUND_BUILD_DIR` when the checkout is synchronized.
- [ ] Build a signed release APK with signing material outside Git.
- [ ] Verify the release manifest does not enable Android cleartext traffic.
- [ ] Install and test the signed release APK on a physical Android 10+
      device.

## Evidence to record

For each failed scenario, record only sanitized diagnostics:

- Room/source epoch.
- WebRTC connection and ICE states.
- Sent/received RTP packets and packet loss.
- Android capture frames and non-silent frames.
- PCM offered/ADM sample counts, RMS, and underruns.
- Whether the app was foregrounded, backgrounded, or screen-locked.
- Android version and source application type.

Never record TURN credentials, private keys, or full unredacted environment
files in this checklist.
