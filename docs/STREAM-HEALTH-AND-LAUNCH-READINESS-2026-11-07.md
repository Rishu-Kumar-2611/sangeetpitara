# Listening health and remaining launch work

Reviewed 7 November 2026 against the supplied screenshot and current 1.1.11
source/public service, with the phone-control correction prepared for 1.1.12.
This is a targeted assessment, not a new penetration test or a physical audio
measurement. The user reports good sound quality with occasional glitches.

## Screenshot interpretation

The card says PUBLISHING RELAY: it measures the sender, not the listener's speaker.

| Reading | What it establishes | What it cannot establish |
|---|---|---|
| PCM16, 48 kHz | Configured raw PCM format; the current relay is mono | Actual fidelity, source quality, stereo reproduction or perceived quality score |
| AudioWorklet capture | Browser worklet capture path is selected | Stable networking or glitch-free output |
| 47,591 frames / 20 ms | About 951.82 seconds (15m 52s) of packets submitted to the socket | Continuous listening for that duration, delivery acknowledgements or 20 ms end-to-end latency |
| 0 KB socket | Near-zero sender WebSocket queue at that instant, rounded to KB | Zero latency, no TCP/receiver queues, or successful speaker playback |
| 0 underruns | The UI's playback-underrun field is zero | Listener continuity: this field is reused on the publisher card and is not a sender-to-speaker health measurement |
| 0% live RMS | Instantaneous displayed amplitude is zero or rounds to zero | Wi-Fi strength, loss rate or poor music quality; a paused/quiet/stale meter needs distinction |
| Epoch 5 | Current source authorization generation | Exactly five network failures or five listeners |
| Five reconnection entries around 17:49–17:53 | Several connection-close/retry events occurred within roughly four minutes | Their root cause or five independent network faults |

Sound clarity is satisfactory according to the actual listening test. Continuity
is the weak point: the reconnect history is consistent with the reported glitches.
The image cannot measure acoustic delay, participant synchronization, clipping,
receiver packet gaps or actual radio signal strength. The Hi-Fi/Relay badge is a
format/status label, not a calculated quality score.

Most useful next evidence: a listener's LISTENING RELAY panel during music and a
glitch, with the time and online/local mode. Record close code/reason, reconnect
duration, packet sequence gaps, receiver buffer history and output underruns.

## Phone controls corrected for 1.1.12

An internet-room web moderator can grant DEVICE_AUDIO, while Android's capture
entry point previously accepted only ANDROID_DEVICE_AUDIO. Android now accepts
either supported label only for its own server-assigned STARTING/LIVE slot. It
still requires Android consent and a fresh native LIVE epoch before forwarding
audio. Another member's grant and arbitrary source types remain rejected.

Expired capture attempts clear stale Activity consent flags. Request is hidden
once control is already approved, rather than presenting an unusable action.
Leave remains enabled during socket retries; common action failures are shown as
visible messages instead of only being appended to a hidden activity log.

Regression coverage combines a real internet-room generic grant → native start →
exact reverse PCM delivery → explicit leave flow with native approval-policy tests.
Physical APK consent/button behavior must still be checked on a phone.

Validation for the control fix: build check and 120 Node tests passed; 92 Android
JVM tests, debug assembly and lint passed. Thirteen browser checks passed in the
initial run; the remaining phone flow exceeded its 30-second budget during the
parallel build and passed when rerun alone. No physical Android device was
connected. The release workflow reruns the complete browser suite independently.

## Remaining production work, in priority order

1. **Connection continuity and observability.** Correlate sender/listener/server
   logs for these reconnects. Record close codes, server restarts, source lease
   changes and recovery times. Fix the measured cause instead of blindly adding
   delay. Split sender and receiver diagnostics; add rolling real health states,
   drop counts and listener-side buffer/underrun trends.
2. **Paired-device endurance and synchronization.** Run long sessions on several
   physical Android models and Windows browsers. Include repeated pause/resume,
   phone/laptop source handoff, revoked/cancelled consent, locked screens, app
   switching, battery saving, calls, Bluetooth and weak/interrupted Wi-Fi/mobile.
   Measure acoustic end-to-end delay and inter-listener skew, not packet duration.
3. **Capacity and zero-budget limits.** Load-test concurrent listeners/reconnects
   and measure CPU, memory and egress. The internet server currently caps 200
   connections and 50 rooms; registered users are not concurrent listeners. Current
   PCM needs about 0.8 Mbit/s per listener, approximately 0.35 GB per listening hour
   before all transport overhead. Server fan-out multiplies egress. Evaluate a
   compressed internet transport without degrading music quality. Local rooms
   have a separate ten-person limit.
4. **Recovery operations.** Neon migration is complete and public PostgreSQL
   readiness passes. Verify recurring backup coverage/retention under the actual
   plan and rehearse restoring a fresh Neon backup outside production. Establish
   safe rollback, uptime/crash alerts, redacted support diagnostics and incident
   procedures. A healthy endpoint now does not explain a historical audio outage.
5. **Security and abuse review.** Recheck guest recovery, host/co-host permissions,
   revocation, admission/reporting, rate limits and reverse-proxy IP trust. Test
   the loopback companion against untrusted origins, malformed frames and wrong
   host certificates. Review Node/JDK/Android/dependency updates continuously.
   Earlier identity and public-backend-source issues were fixed; do not present
   the old 1.1.2 audit as current evidence of those vulnerabilities.
6. **Usability and accessibility.** Test TalkBack/keyboard navigation, large text,
   small phones, all themes, denial/recovery of notifications and capture consent,
   and the Windows extraction/launcher/system-audio-checkbox flow with new users.
7. **Distribution, privacy and support.** Signed APK/AAB and release verification
   exist. Finish Play Console internal/closed testing, required declarations,
   capture/privacy/Data Safety disclosures, store assets, retention/deletion and
   working support processes. Review actual current store requirements before
   submission. Establish a clear Windows companion update process.
8. **Optional payments/ads.** Keep them disabled while not needed. Before charging,
   make billing event/entitlement updates transactional and safe under duplicates,
   failures and reordered events; verify provider test flows and disclosures.

Render's free service has idle spin-down and other free-tier limits, but active
incoming WebSocket messages keep it awake. The screenshot does not prove that
hosting caused these reconnects. See [Render free service limits](https://render.com/docs/free)
and [WebSocket activity behavior](https://render.com/changelog/free-web-services-now-remain-active-while-receiving-websocket-messages).
Physical/background test coverage should follow [Android core app quality](https://developer.android.com/docs/quality-guidelines/core-app-quality).

Assessment: suitable for a controlled beta after device verification; not yet
proven for an unrestricted launch or 1,000 simultaneous listeners. Preserve the
reported good sound quality and prioritize continuity and trustworthy telemetry.
