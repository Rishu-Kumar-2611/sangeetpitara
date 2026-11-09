# SangeetPitara 1.1.22

## Brief connection drops are barely noticeable

The free Render hosting cuts connections now and then (measured: about once a
minute in some sessions). Each cut used to cost 1.5–3 seconds of silence plus a
"Connection lost" alarm.

- The website retries almost at once (after 150 ms, then backing off), instead
  of waiting at least a second. The Android app's first retry drops from 1 s to
  250 ms.
- Audio already buffered keeps playing while the connection comes back.
- "Connection lost — reconnecting…" only appears if a reconnect takes longer
  than 2.5 seconds.
- Fixed: a failing connection reported both "error" and "close", which
  scheduled two retries and pushed the quick one back.

## Phone diagnostics show what you actually hear

Investigating "the laptop hears my friend but my phone doesn't": in a real
browser-to-phone test, including the exact sequence of phone sharing first and
then the host approving a laptop, the phone received and played the laptop's
audio every time. The phone's previous diagnostics could not show volume or
level, so they can't say why a real phone was silent. They now record:

- the level of the audio the phone plays (0% means silence arrived),
- the app's playback volume and whether playback is allowed (audio focus),
- whether you paused room audio on the phone,
- the phone's own media volume.

The Status tab shows these too, and now refreshes every second (before, it
changed only when a room update arrived, so its numbers could be minutes old).
If the phone's media volume is at 0 while someone else shares, the Room card
says so and a one-time message asks you to turn it up.

New counters on Status also show packets refused as out of order, Opus packets
whose decode produced no audio yet, and packets that failed to process.

## Notes

The first ~minute after a host approves someone, every listener hears nothing
until that person finishes picking what to share in their browser. That is
expected; the cassette shows "STARTING" meanwhile.

## Compatibility

Older apps keep working. Version 1.1.22 / versionCode 10122 / shared asset
cache 20261109-steady1. No database migration.
