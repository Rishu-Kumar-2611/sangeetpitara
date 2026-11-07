# Stream continuity and health indicators — 1.1.13

Browser capture retains up to 128 × 20 ms packets across main-thread stalls, with a three-second age limit and existing socket backlog bounds. It cannot bridge an unbounded outage. Epoch and source authorization remain enforced.

Playout counts starvation immediately (including concealed glitches), earns an adaptive cushion and waits for that cushion before resuming real PCM. Short burst recovery no longer drains the first returned packet before enough audio has accumulated. Existing 3-second adaptive ceiling and bounded ring remain.

A replaced browser/Android instance stops reconnecting. Previously two instances sharing a reconnect identity could repeatedly evict one another. New server close logs include numeric code and a fixed allowlisted cause; guest IDs, room codes and arbitrary close reasons are omitted. This is a concrete possible reconnect cause, not proof of the cause on the user's phone.

## Health defaults

| Metric | Green | Orange | Red |
|---|---|---|---|
| Connection | Connected, 0 reconnects / 60 s | 1–2 reconnects / 60 s | Disconnected or ≥3 reconnects |
| Browser outgoing PCM queue | ≤100 ms | ≤500 ms | >500 ms |
| Listener buffer | Within max(20 ms, 25%) of adaptive target | At least half target, outside ideal band | Empty, refilling or below half target |
| Underruns in last 60 s | 0 | 1 | ≥2 |
| Browser arrival jitter estimate | ≤20 ms | ≤60 ms | >60 ms |
| Browser output context | Running | — | Suspended/closed |

These are app operating defaults, not universal music fidelity standards. Buffer is compared against its adaptive target; a larger earned target is legitimate on a poor network. Jitter and underruns measure transport/playback conditions, not signal strength in dBm or a listening quality score. Sender queue is not end-to-end latency. RMS has no fixed ideal loudness: music dynamics and pauses are valid. Format, epoch and lifetime packet counters are informational. Unmeasured values stay neutral. Words accompany colors.

Android reads actual AudioTrack underruns, keeps a recent 60-second count, and shows not measured when no playback output exists. The hotspot browser reports its own buffering and starvation count. There is no fabricated sender-side listener underrun value.

## Diagnosis limits

For the screenshot window (12:19–12:23 UTC on 7 November), Render had no deployment, no returned warn/error app logs, CPU around 0.008 vCPU, and memory around 38 MB of 512 MB. This does not establish why the phone disconnected. Expected deploy shutdown SIGTERM logs occur outside that window. Close diagnostics added in this release make future failures more actionable.

Automated regression tests cover adaptive burst recovery, partial-prefill recovery, bounded capture backlog, duplicate-tab reconnect behavior and health boundaries. Physical phone background playback, OEM battery restrictions and actual weak-radio listening still require device endurance testing. No software can promise uninterrupted live music through an outage longer than its buffered audio.

## Validation

- Node 22.14.0: npm run build and npm test passed; 127 tests, 0 failures; origin, payload and RTC authorization checks passed. The final run used an isolated Linux filesystem after Windows bind-mounted startup timeouts.
- Playwright desktop and phone: 18 checks passed; two strengthened health-panel checks then passed while proving live PCM packet counts increased. Screenshots inspected at both sizes.
- Android: testDebugUnitTest, assembleDebug and lintDebug passed; 93 JVM tests, 0 failures. Existing deprecation/nullability warnings remain.
- No physical Android phone was connected, so actual OEM background behavior and weak-signal listening are not yet certified.

## Hosted shared-IP regression

The first hosted browser run exposed HTTP 429 responses after repeated room page loads. Font files (.woff2) were being counted against the 120/minute API/WebSocket allowance rather than the 600/minute static allowance. The backend follow-up classifies supported font types as static assets. An integration check loads 140 fonts, verifies config and WebSocket access still work, then confirms excessive API requests remain throttled. This is relevant to users sharing a public IP; it does not establish the cause of every earlier disconnect. The signed APK is unchanged by this server-only follow-up.
