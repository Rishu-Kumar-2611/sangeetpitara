# SangeetPitara 1.1.16

## Phone navigation

Room, Chat, People and Health appear first in the room, followed by the theme selector, room information and selected content. Portrait navigation sticks to the top when scrolling; there is no bottom bar covering the composer or listening controls. The welcome page retains its own theme control position.

## Audio continuity

The reported test was laptop-browser sharing to phone-browser listening. The screenshot showed 203 sequence gaps, zero recent underruns, 15 ms arrival jitter, and a buffer near the former three-second ceiling. This does not establish an Internet bandwidth fault or prove the exact source of the gaps.

- Browser capture retains up to eight seconds of worklet messages during a busy main thread, with a nine-second age guard instead of dropping after three seconds. Healthy sends are still immediate.
- Browser playout preserves delayed bursts until its twelve-second hard ring bound, instead of trimming audio near the adaptive target plus 80 ms. The adaptive target can grow to eight seconds after measured stalls; its healthy starting delay remains 40 ms.
- Relay and Android sending queues are bounded to 1 MiB, and Android receiving queues to ten seconds. Binary frame/byte limits accommodate bounded catch-up bursts and remain enforced. Authorization and epoch checks are unchanged.
- Health distinguishes missing sequence numbers from actual playback trimming and reports the latest packet duration rather than assuming every publisher emits 20 ms frames. Local diagnostic exports include playback-trim events without audio or chat content.

## Verification

Regression tests cover a seven-second capture-thread stall with ordered retained packets, five-second playback recovery without trimming, immediate burst retention, and bounded overflow/recovery on longer outages. A two-browser test blocks the sender's UI thread for 6.5 seconds and checks listener packet progress, zero sequence gaps and zero playback trimming. Responsive checks verify navigation is above the theme and content.

These bounds protect recoverable stalls; already-discarded audio cannot be reconstructed, and sustained outages or device capture suspension can still interrupt listening. The screenshot alone cannot identify a user's exact failure path. The new diagnostics make a further occurrence easier to attribute.

No database migration or paid service change. Version 1.1.16 / versionCode 10116 / shared asset cache 20261108-continuity1.
