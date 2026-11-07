# Recording review and production readiness — 7 November 2026

## Evidence and scope

Reviewed the supplied 11.40-second, 1918×1078 laptop recording at one-second intervals, with full-resolution inspection of the health panel and activity history. This is a targeted recording/code review, not another full security audit or an independent acoustic fidelity test. The user reports good listening quality in both directions with one or two tolerable glitches. The visible panel remains PUBLISHING RELAY; a receiving device's buffer, jitter and underruns are not shown.

## Recorded factors

| Factor | Observation | Interpretation and limit |
|---|---|---|
| Connection | Connected / Healthy at the visible checkpoints | No disconnect is visible in this short clip. Does not establish long-session reliability. |
| Recent reconnect indicator | Connection remains green, with a displayed ideal of 0 reconnects / 60 s | The caption states a target, not a separate measured reconnect count. The color indicates no recorded recent reconnects under the current policy. |
| Outgoing queue | 0 ms at readable checkpoints | No persistent browser-side send backlog is visible. This rounded estimate excludes receiver, TCP/server, hardware and Bluetooth delay. |
| Audio packets | 2,828 at approximately 0.5 s; 3,329 at approximately 10.5 s | +501 over about 10 s, approximately 50.1 packets/s, close to the expected 50 × 20 ms. UI refresh timing makes short count jumps unsuitable as a jitter measurement. Counts show socket submission, not proof of speaker delivery. |
| Signal RMS | Sampled readable levels approximately 8.0%–33.2% | Audio energy varies normally with the source. RMS is not Wi-Fi strength, quality percentage or a clipping detector. No fixed ideal RMS is appropriate for all music. |
| Format | 48 kHz PCM16 mono | Sensible high-quality sampling format; mono removes stereo separation. It does not establish source fidelity or bit-perfect playback. |
| Epoch | 3 throughout the inspected clip | Same source generation in this window. Epoch 3 is not three failures. |
| Overall badge | Healthy | Appropriate for the measured sender connection/queue, not an end-to-end guarantee for every participant. |
| Listening volume / sync | 79% / 20 ms | User settings. 20 ms is not measured phone-to-speaker latency, and 79% is not a quality rating. |
| Approval activity | Approval and sharing-start events visible | Supports the current sharing workflow. Both self-facing and member-facing messages appear, creating some duplicate-looking activity text. The clip does not demonstrate a complete source handoff. |
| Listener buffer, jitter, underruns, loss and synchronization | Not visible in this publisher recording | Cannot quantify the reported glitches or establish their cause from this clip. Need receiving-device time histories and event correlation. |

The music quality is satisfactory according to the user's actual listening test. The recorded sender path looks healthy at these checkpoints. Continuity and long-session resilience need further evidence. No claim of zero underruns or zero latency is justified.

## Work to prioritize

1. Receiver-side incident evidence: show actual current reconnect count, last-packet age and recent missing sequences; retain buffer target/fill, jitter, output state, underrun and reconnect histories. Add a user-triggered, privacy-redacted diagnostic export. Scope the overall badge as Sender health or Playback health so it cannot imply all listeners are healthy.
2. Paired physical-device endurance: 60-minute stable-network sessions in both directions, then background/locked screen, battery saver, pause/resume, repeated source handoff, calls/headphones/Bluetooth, Wi-Fi/mobile changes and hotspot-host interruptions. Correlate clocks and events. Suggested internal stable-network gate: no unexpected room exit or audible cut; under outages recover without requiring a new room. These are proposed project acceptance criteria, not official platform thresholds.
3. Measure actual synchronization: record the same transient from multiple speakers in a single recording and compare arrival times; measure phone-to-laptop and laptop-to-phone separately. Transport packet duration and the sync slider cannot supply these results.
4. Capacity and data cost: current source caps 200 connections total, 40 per IP, and 50 active online rooms. Caps are not a demonstrated safe capacity. Test 10/25/50/100 concurrent listeners, then the configured ceiling if earlier stages pass, including reconnect storms, and report CPU/memory/egress and listener glitches. Raw 48 kHz × 16-bit mono is 768 kbit/s: about 345.6 MB per listener-hour before framing and networking overhead. 100 listeners use about 34.56 GB/hour of payload fan-out. Evaluate music-mode Opus for internet rooms with listening comparisons; preserve current PCM for local rooms where appropriate. 1,000 registered users is different from 1,000 simultaneous streams.
5. Operations and database recovery: verify the actual Neon restore window and rehearse recovery into an isolated branch/database. Verify rollback, alerts, redacted crash diagnostics and deploy/reconnect behavior. Do not migrate the database again merely to address streaming jitter: the audio relay is a separate path.
6. Security/release review: recheck room authority, source revocation, reconnect capabilities, shared-IP limits, origin/certificate checks, malformed input, dependencies and secret handling. Previous fixes and automated tests do not replace an adversarial review. Retain original APK signing identity and reliable updates.
7. Usability/accessibility: keep the theme, but compact the tall health panel behind a short summary, prevent sticky room headers covering controls on scroll, streamline duplicate activity messages, and check keyboard, TalkBack, large text and small phones. Include new-user tests for the Windows companion setup and capture consent.
8. Distribution/support: complete applicable Play testing, privacy/Data Safety/capture disclosures, store material, update/rollback procedures and working support. Keep ads/payments disabled until their own validation is completed.

Current assessment: suitable for a controlled beta with the above measurement limits; not yet proven for an unrestricted production launch or 1,000 simultaneous listeners. The next audio priority is receiving-side continuity evidence and physical-device endurance, rather than higher sample rates or another latency reduction.

## Existing automated evidence

For the latest backend commit, hosted Node checks passed 128 tests plus origin/payload/RTC checks, all 18 browser checks passed, and production-container/database integration checks passed. Android validation passed 93 JVM tests, assembly and lint. These validate specific code paths; the user's physical test adds useful real-world evidence but does not replace a multi-device endurance matrix.

## References checked

- Android core app quality: https://developer.android.com/docs/quality-guidelines/core-app-quality
- Render WebSocket behavior and outbound bandwidth: https://render.com/docs/websocket
- Render free-tier limitations: https://render.com/docs/free
- Neon project/restore-window settings: https://neon.com/docs/manage/projects
- Opus music/audio codec: https://opus-codec.org/
- Current Google Play technical quality guidance: https://support.google.com/googleplay/android-developer/answer/17492799
