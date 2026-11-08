# SangeetPitara 1.1.18

## Opus audio: about 7x less data

Rooms now send Opus (96 kbps by default) instead of uncompressed PCM16 whenever
everyone in the room can play it. A listener receives about 13 KB/s instead of
about 97 KB/s, which keeps the free hosting plan's bandwidth going much further.
If anyone in the room uses an older app or a browser without Opus support, the
whole room uses PCM16 as before. Opus can be switched off on the server at any
time with `MEDIA_RELAY_OPUS=0`.

## Listening stays close to live

A network hiccup or a paused source no longer leaves a lasting delay. Listeners
keep at most a 2 second safety buffer, release it within seconds once the
connection is steady, and skip ahead if they fall more than a second behind.
Gaps longer than 2 seconds are treated as a paused source, not network jitter.

## Room screen

- The Room tab shows only the listening surface. People and Chat have their own
  tabs.
- The now-playing tile is a cassette whose reels turn while audio is live, with
  live waves underneath. The host now sees the waves too.
- Listeners can **Pause** on their own device; the server stops sending to them
  and **Resume live** rejoins the live stream. The People tab shows who has
  paused.

## Remove or Ban

Hosts and co-hosts now choose between **Remove** (the person can rejoin with the
room code) and **Ban** (they cannot rejoin this room; confirmed with a second tap
on the web and a dialog on Android).

## Website

The information box beside the landing headline is replaced by an animated
cassette deck.

## Compatibility

Apps 1.1.17 and older keep working: they receive PCM16, and their Remove button
now removes without banning. Version 1.1.18 / versionCode 10118 / shared asset
cache 20261108-listen1. No database migration.
