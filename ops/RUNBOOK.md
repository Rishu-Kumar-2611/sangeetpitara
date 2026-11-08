# Operations and release handoff

These changes are prepared on `codex/production-hardening`. The server and CI
now pin Node 22.23.4 within the existing Node 22 LTS line. Public release remains
1.1.13 until the final UI pass and release checks. No paid resources were selected.

## Audio incident

Save audio diagnostics on both the sending and receiving devices immediately
after a glitch. Exports contain bounded local numeric history and fixed event
types; no sound, display capture, names, chat, room codes, IPs, URLs or credentials.
Match approximate time, source epoch, capture/stale/socket drop counters, packet gaps, buffer target/fill, output state,
underruns and reconnects. Android accepted capture buffers are not transmitted packet counts. Device clocks may differ. Packet age is a transport
measurement, not an acoustic end-to-end delay. Android samples in the service;
browser telemetry can be delayed when the browser suspends its page.

Check protected `/metrics` for relay backlog drops, bounded closure categories,
connection lifetime, process RSS/CPU and event-loop delay. Correlate Render deploys
and process restarts. Never paste database URLs, bearer tokens or full invite links
into tickets or chat. Diagnostics are downloaded only on request, not uploaded.

## Monitoring

`ops/alerts.yml` is a ready-to-configure Prometheus rule set, not a running alert
service. The owner must select a private monitoring host and notification recipient
before enabling it. Readiness is `/ready`; `/health` only establishes liveness.
Do not use frequent synthetic requests just to prevent free-tier idle sleep.

## Database recovery

The inspected Neon project had a 21,600-second (six-hour) history window on
7 November 2026. Recheck this setting after plan/project changes. A real isolated
point-in-time rehearsal recovered a deleted synthetic row and preserved migration
history. Production data was not modified. Both agent-created test branches and
the ephemeral encrypted test archive were removed after verification.

Use `npm run test:recovery -- --branch codex-recovery-YYYYMMDD --connection-file
<private-direct-url-file>` only on a disposable branch. The tool refuses root
branches, requires a recovery-only branch name, and preserves the prior branch
when restoring its own history. The preserved branch is named `<branch>-preserved`;
remove only the verified test branches after use. Restoring a test branch is not
authorization to overwrite production.

## Encrypted backups

The `SPBK0001` format uses AES-256-GCM, a fresh random nonce and an externally
supplied 32-byte hex key. Authentication completes before the decrypted temporary
archive is passed to `pg_restore --list`; plaintext is removed afterward. Existing
files are never overwritten. Docker supplies PostgreSQL 18 tools; verify version
compatibility if the database is upgraded.

Set `BACKUP_ENCRYPTION_KEY` privately, keep a recoverable offline copy separately,
and supply `DATABASE_URL_UNPOOLED` through a private environment file or use
`--connection-file`. Never pass a password/key in command arguments or send it in
chat. Use a dedicated least-privilege dump role where possible.

```
node --env-file=.env ops/database-backup.mjs create --output <private-file.sgb>
node ops/database-backup.mjs verify --file <private-file.sgb>
```

`database-backup.yml` runs daily at 21:30 UTC (03:00 IST) and can also be started
manually. It requires repository secrets `DATABASE_BACKUP_URL` and
`BACKUP_ENCRYPTION_KEY`; until both exist, scheduled runs end with a warning and
manual runs fail. It uploads only encrypted archives and checksum manifests to
GitHub Actions artifacts with seven-day retention. Schedules run only from the
default branch, and GitHub pauses them after 60 days without repository activity.
Copy archives somewhere offsite if seven days of history is not enough. Losing the encryption key makes
those archives unrecoverable. Archive validation is not a complete database restore;
periodically restore to a separate database and exercise the app before relying
on a backup for disaster recovery.

## Opus relay

Rooms negotiate Opus per room: the server sends it only while every online
member reports it can decode it, otherwise everyone gets PCM16. At the default
96 kbps a listener receives about 13 KB/s instead of about 97 KB/s, roughly 7x
less server bandwidth. `/config` publishes `mediaRelay.codecs` and
`mediaRelay.opusBitrate`; each room state carries `room.relayCodec`.

- Emergency off switch: set `MEDIA_RELAY_OPUS=0` on the web service and restart.
  Every room returns to PCM16 at once; no app release is needed.
- Tune quality versus bandwidth with `MEDIA_RELAY_OPUS_BITRATE` (32000-128000).
- Android only offers Opus after a MediaCodec encode/decode self-test. On a debug
  build, run it by hand with
  `adb shell am broadcast -n com.roomsound.android/com.roomsound.android.debug.OpusSelfTestReceiver`
  and read `adb logcat -s OpusSelfTest`.
- Before calling it done, listen on two real phones in both directions.

## Capacity and cost

`npm run test:capacity` starts loopback-only, in-memory synthetic servers. It never
accepts an external load-test URL or reads `.env`. Current measurements are in
`ops/capacity-results.json`. They cover relay delivery and reconnects on this
computer, not WAN audio, Android output, free-host quotas or a long soak.

The default ceilings are 200 connections, 20 per IP and 50 rooms. They can be
tuned with `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP` and `MAX_ACTIVE_ROOMS`; test
before raising them. Sockets that do not join a room within 60 seconds are closed
(`UNJOINED_SOCKET_TIMEOUT_MS`). Each client address may submit 20 wrong or stale
room codes per 10 minutes (`JOIN_FAILURE_LIMIT`) before joins pause. Room codes are
8 characters from a 32-symbol alphabet; legacy 6-character codes are still accepted.
Hosts and co-hosts can lock a room or replace its code from Room settings; a
replaced code still lets existing members reconnect but admits no one new.
Per-address limits cannot stop a distributed flood: put the service behind an edge
rate limiter or firewall before a public launch. Raw mono PCM is 768 kbit/s plus overhead per listener. Consider a
separately negotiated compressed internet transport only after listening and
cross-platform compatibility tests; this change preserves the current sound path.

## Proxy trust release gate

`TRUST_PROXY=1` is valid only when the service cannot be reached around its trusted
TLS proxy. `TRUST_PROXY_HOPS` selects an address from the right of the forwarding
chain (default 1), not an untrusted caller-supplied leftmost address. Before public
rollout, verify the actual Render proxy chain and set the trusted hop count. A
wrong count can group unrelated users behind a proxy and trigger shared-IP caps.
Do not increase trust based solely on a header sent by a client. Local tests cover
spoofed leading values; provider routing must be verified at deployment.

## Release and rollback

Keep health calculations/export schemas in their separate modules while refining
the UI. Preserve existing button IDs and room/service ownership. Never let a visual
rerender stop capture, recreate a socket or reset a player. Add new public modules
to the HTTP allowlist, runtime image and syntax checks; resync offline bundles.

Before tagging: run build/tests, browser checks, native assembly/lint, strict
dependency/secret scans, container and PostgreSQL checks. Increment version/cache
identities together, sign with the existing release key, verify APK certificate,
and build all download assets. Publish artifacts before switching the website.
Verify `/ready`, version, module hashes and redirects after rollout.

Every restart ends all live rooms, because room membership and audio live in
process memory. `render.yaml` therefore sets `autoDeployTrigger: "off"`. Deploy
from the Render dashboard or a deploy hook at a quiet time, after checking that
`/health` reports few or no `rooms`. On shutdown the server tells connected members
that it is restarting and that they may need to create a new room.

Rollback website source/config to a verified commit if needed. APK rollback needs
a new higher versionCode signed with the same key; old version codes cannot be
installed as normal updates. Never change a database restore target merely to
roll back a UI release. Preserve the old database migration path until a separate
recovery decision is made.

## Owner device checks

Test at least one hour in both audio directions, then locked screen/background,
battery saver, pause/resume, consent cancellation, source handoff, calls,
Bluetooth/headphone changes and weak/interrupted Wi-Fi/mobile/hotspot. Save paired
diagnostics immediately after any cut. Proposed stable-network gate: no unexpected
room exits or audible cuts. Measure multi-speaker timing using one recording of a
shared transient. Test TalkBack, large text and real small-phone layouts. Complete
Play Console testing/disclosures and choose backup/monitoring policies in the
owner's accounts; do not send credentials to the agent.
