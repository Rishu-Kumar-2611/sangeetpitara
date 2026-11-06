# Low-latency release 1.1.3

The Android active output target is reduced from 600 ms to 40 ms, respecting
the device minimum. Low-latency AudioTrack performance is requested. Actual
underruns can grow the active buffer by 20 ms up to its reserved capacity
(normally 120 ms). This is an output-buffer budget, not a measured acoustic
end-to-end latency guarantee.

Native software backlog is limited to 240 ms rather than 2.4 seconds; playback
catches up past 160 ms, landing at 40 ms instead of retaining up to 900/250 ms.
Android/browser/socket sender queues are bounded near 125 ms, replacing the
old 2-second Android send queue and 1-second browser/server queue. Capture
worklet delivery is bounded and audio older than 120 ms is not published.

Browser default cushion is 40 ms with a 40 ms minimum startup prefill rather
than 150/200 ms. Jitter adaptation is measured and capped at 120 ms above the
chosen base. Stale bursts are skipped with a crossfade instead of leaving the
listener permanently behind. Explicit larger user cushions remain available
for unreliable networks; preserving every sample in 500 ms delivery bursts
necessarily costs at least comparable buffering.

Deterministic execution of the actual worklet with real-time packet production
and 40 ms simulated network delay measured median audio age of 250 ms before
and 111 ms after; p95 259 ms before and 120 ms after, without underruns on the
stable path. With 100 ms arrival bursts, median was 152 ms, p95 161 ms, with no
underruns or trimming. These exclude capture hardware, OS/DAC, Bluetooth and
real internet latency. Run `node checks/latency-benchmark.mjs --check` locally;
CI uses `--current-only` to avoid depending on historical Git objects.

This release does not claim zero latency or sample-accurate synchronization.
Playback captured from an external app is already audible at the host before
it can reach the network; this app cannot delay that external player's output
universally. Bluetooth and Internet distance add unavoidable delay. Exact
speaker alignment would require clock-synchronized scheduled playout and
control of the host's local playback, a separate change with its own buffer
tradeoff. Physical paired-device acoustic testing remains required to quantify
the actual listener-to-host skew.
