# SangeetPitara 1.1.19

## Fixed: music stopping on a background tab

When a phone shared audio to a laptop whose browser tab was in the background,
the music could stop after a while and only came back after Pause and Resume.
The phone briefly reconnected and restarted its packet numbering, and the
listener then discarded every new packet as "old". Two fixes:

- Senders (Android and web) keep counting from where they were after a
  reconnect within the same share.
- Listeners (web and Android) accept a sender that restarts its numbering after
  25 packets in a row, about half a second, instead of staying silent.

The Health tab now shows the actual format in use (Opus or PCM16) instead of
always saying PCM16.

## Invite links open the app

Shared invites are now `https://sangeet-pitaraa.onrender.com/join/CODE`.

- On an Android phone with the app installed, tapping the link opens the app on
  the Join screen with the code filled in. Android checks this through
  `/.well-known/assetlinks.json`, which the server now serves.
- Without the app, the link opens the website's Join form, as before. Old
  `?room=CODE` links keep working.
- The Android room screen has a new **Share invite link** button.

## Pause on Android

Android listeners get **Pause room audio** / **Resume live**, matching the web.
The server stops sending to a paused phone, which also saves data. Resume
starts again from the live stream. A pause survives a brief reconnect.

## Safety check for the relay setting

`MEDIA_RELAY_ENABLED=0` with no TURN server would leave listeners on other
networks with silence. The server now keeps the relay on in that case and logs
a warning. To really switch it off, configure TURN or set
`MEDIA_RELAY_FORCE_DIRECT=1`.

## Accessibility

- New automated WCAG 2.1 AA check (axe) over the welcome, join, create and
  every room tab, in both themes and at phone and desktop sizes.
- Fixed: the phone-size room menu button had no name for screen readers.

## Clean-up

- Removed fonts the Android app no longer uses (Mukta, Poppins, one Geist Mono
  weight), two unused strings and one unused web function. No behaviour change.
- `ROOM_CREATION_LIMIT` (default 10 per address per 10 minutes, unchanged) can
  now be set for test servers.

## Compatibility

Older apps keep working. Version 1.1.19 / versionCode 10119 / shared asset
cache 20261108-invite1. No database migration.
