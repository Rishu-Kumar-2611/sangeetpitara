# SangeetPitara 1.1.20

## Delay comes back down after a hiccup

A recorded phone-to-laptop session showed listeners stuck about 2 seconds
behind live after a single network hiccup. Any packet more than 80 ms late
restarted the 8-second wait before the safety buffer could shrink, and that
happens every few seconds on a normal connection.

Now the player keeps only what recent hiccups actually needed. A real stall
still keeps its full buffer for 8 seconds; ordinary jitter lets the delay
return to a fraction of a second. Fixed in the web player and the Android
player, with tests that replay the recorded pattern.

## Frozen connections are noticed quickly

A connection can freeze without closing; in the recording, 12 seconds passed
in silence before the browser gave up on it.

- Web: the app pings the server every 2 seconds. If a ping goes unanswered and
  nothing else arrives for 6 seconds, it reconnects at once. Hidden tabs with
  slowed timers cannot trigger a false alarm.
- Android: the connection is checked every 5 seconds and fails over within
  about 10 seconds.

## Room page

- The website's room page now uses the full window width.
- The room code at the top is large and easy to read.
- Android: the Room screen starts with the same cassette card as the website
  (who is sharing, LIVE / WAITING / PAUSED, reels turning while live), with
  Pause room audio inside it.

## Voice messages like Telegram

On the website and Android, the mic button sits next to the message box.
Tap it to start recording, tap ➤ to stop and send. Cancel discards the
recording. If sending fails, the recording stays with Send and Discard so it
can be retried.

## Compatibility

Older apps keep working. Version 1.1.20 / versionCode 10120 / shared asset
cache 20261108-voice1. No database migration.
