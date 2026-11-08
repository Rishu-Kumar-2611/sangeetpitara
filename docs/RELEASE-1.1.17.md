# SangeetPitara 1.1.17

## New look: Studio Console

The website and the Android app share one design: graphite surfaces, one
signal-orange accent, Geist for text and Geist Mono for labels, room codes and
measurements. Themes are Console Dark (default) and Console Light. On desktop
the Room tab shows people, the current source and chat side by side.

## Safer rooms

- Room codes are 8 characters (about 1.1 trillion combinations). Older
  6-character codes still work.
- Each network address can try 20 wrong codes per 10 minutes before joining
  pauses, so active rooms cannot be found by guessing.
- Hosts and co-hosts can **Lock room** (members can reconnect, nobody new can
  join) and get a **New code** (old invites stop admitting new people). Both are
  in Room settings on the website and under the room code in the Android app.
- Connection limits: 200 in total, 20 per address; sockets that never join a
  room close after 60 seconds.

## Operations

- The server warns room members before it restarts.
- A free GitHub Actions uptime check pings the live site every 10 minutes
  during Indian daytime and opens an issue (emailed to the owner) if it is down.
- The encrypted database backup is scheduled daily; it skips with a warning
  until its two repository secrets are configured.

## Removed for now

The About and Contact pages and the support email. Privacy and Terms remain.

## Compatibility

The 1.1.16 Android app keeps working with this server: it accepts the longer
codes, and the server still accepts 6-character codes. Lock room and New code
appear only in 1.1.17. Database migration 004 widens the room-code column; it
runs automatically at startup.

Version 1.1.17 / versionCode 10117 / shared asset cache 20261108-release117.
No paid service is required.
