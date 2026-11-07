# Network resilience in 1.1.4

Healthy connections keep the 1.1.3 low-latency starting point. On measured delivery
gaps the browser and Android listener earn up to three seconds of extra cushion.
Browser playback retains that cushion through repeated stalls and reduces it only
after 30 seconds of stable delivery. Android retains its earned cushion for the
current source session. Delayed PCM is preserved within bounded recovery queues;
only congestion beyond those bounds skips audio to prevent unbounded memory use.

Sender and per-listener relay queues allow about four seconds of mono PCM16
(two seconds of stereo). These limits do not add delay to healthy sends. The
server byte-rate limit includes a bounded recovery-burst allowance.

Android no longer lets periodic capture snapshots cancel consent merely because
the room socket is reconnecting. Media remains unauthorized until fresh room state
arrives. A reconnect within 15 seconds retains the source epoch; native publisher
sequence numbers survive a stop/start within that epoch. Server close handshakes
are acknowledged promptly, reconnect backoff resets after joining, and Android
uses the server heartbeat rather than a competing 15-second ping failure timer.
Server liveness tolerates 90 seconds without inbound activity; real traffic and
pongs refresh it. Source grace is separate and expires after 15 seconds once the
socket is known disconnected. Deliberate leaving, removal and source handoff still
revoke authority; another source cannot be displaced by reconnecting old capture.

Validation includes the actual browser worklet under repeated 100/500/1000 ms
bursts, a recoverable 1.5-second backlog, bounded recovery from an eight-second
outage, native packet order/revocation with an earned cushion, and real WebSocket
source reconnect/epoch/byte forwarding plus grace expiration. Healthy-path
simulation remains median 111 ms and p95 120 ms (40 ms simulated network).
These are software simulations, not physical phone/Bluetooth measurements.

A new or longer-than-buffer outage can still cause an initial break while the
buffer refills. Repeating or fading the last waveform cannot restore missing
music. Sustained bandwidth below PCM requirements (about 0.8 Mbit/s mono, or
1.6 Mbit/s stereo with overhead) cannot be repaired with more buffering; a future
compressed transport is needed for consistently slower links. No uninterrupted
playback guarantee is made for arbitrary mobile connections.

Local release validation: 116 Node tests passed under Node 22.14.0, including
real WebSocket recovery and grace expiration; 79 Android JVM tests passed;
Android debug assembly and lint passed; all four desktop/phone Playwright flows
passed. The isolated release asset check and room-control smoke test passed.
No physical Android device was connected for paired-device audio testing.

The browser compatibility scheduler also preserves repeated half-second bursts,
earns up to three seconds of refill cushion, and clears only excessive queues
beyond four seconds. Behavioral tests verify contiguous scheduling and recovery
bounds. Its web-only follow-up uses cache token 20261106-resilience2; the signed
Android 1.1.4 release already contains the native resilience fixes.
