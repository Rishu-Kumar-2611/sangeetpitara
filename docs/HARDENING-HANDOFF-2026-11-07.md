# Production hardening handoff — 7 November 2026

## Publication state

Prepared on `codex/production-hardening`. Public main/website/APK remain at the
previous 1.1.13 release. Final visual refinement and owner device acceptance come
before the next version/cache bump and signed public release. No paid plan changes
were made. Existing unrelated audit artifacts were left unstaged.

## Implemented

- Bounded audio history and user-controlled local JSON export in the web app,
  Android and offline browser/Windows companion. Explicit numeric/enum allowlists
  exclude audio, screen content, identity, messages, invitations, network addresses,
  credentials and arbitrary errors. Browser sampling is independent of panel
  visibility; Android sampling belongs to the room service, including background.
- Separate sender/playback health, actual recent reconnects, packet age, missing
  sequences and recent sender losses. Capture-thread, stale-capture and outgoing
  queue losses have separate counters. Offline dropped packets leave visible
  sequence gaps. Native capture buffers are not mislabeled as wire packets.
- Native hardware/software playback-buffer readings, adaptive target, jitter,
  packet age, missing sequences and actual AudioTrack underruns. Unavailable
  measurements remain unknown; no artificial latency/fidelity score is produced.
- WebSocket JSON depth/shape/UTF-8 controls before dispatch, malformed-request rate
  accounting, generic validation errors, bounded authentication timeouts and safe
  closure on lookup failure. HTTP header/request deadlines are explicit.
- Trusted-hop IP selection replaces blind trust in attacker-supplied leading
  forwarding values. Invalid proxy-hop settings fail production configuration.
  The actual provider chain remains a deployment-time verification gate.
- Idle PostgreSQL errors no longer become uncaught process errors. A real
  disposable-database outage test proves that liveness stays up, readiness fails
  and authentication closes safely instead of silently becoming a guest.
- Protected metrics for relay forwarding/backlog drops, bounded socket-close
  categories/lifetime, RSS, CPU, event-loop delay and handled database-pool errors.
- Malformed desktop-helper URLs cannot escape request/upgrade handlers. Existing
  origin/token and pinned-TLS controls remain enforced. Packaging uses an isolated
  scratch directory and bounded official-runtime downloads.
- AES-256-GCM streaming backups, authenticated temporary decryption, custom archive
  validation and checksum manifests. Existing output files cannot be overwritten.
  Manual GitHub backup workflow prepared; recurring backups are not enabled.
- CI production dependency auditing, full-history credential scanning with pinned
  scanner image, private-file guards, quick relay/reconnect checks and CRLF/LF
  offline-bundle consistency regression. Three narrowly reviewed exceptions cover
  a public TLS fixture key and exact public RFC protocol constants, not credentials.
- Server/CI runtime refreshed to Node 22.23.4 within the existing LTS major.
- Updated diagnostic privacy disclosure, UI integration contract, operations/
  rollback runbook, alert-rule template and owner/store handoff checklist.

## Validation evidence

- Node 22.23.4: `npm run build` and `npm test` passed; 139 tests, zero failures,
  plus origin, payload and RTC authorization checks.
- Desktop and phone browser flows: 20 checks passed, including local diagnostic
  download privacy. Strengthened offline source/backpressure checks passed for
  both layouts. Hosted CI reruns the complete flows on Linux.
- Android: 96 JVM tests passed, plus debug assembly and lint. No physical Android
  device was available. Existing deprecation/nullability warnings remain.
- Production image: configuration rejection, real PostgreSQL readiness, protected
  metrics/backend source, public diagnostic assets and database-backed login passed.
- PostgreSQL integration and the disposable-database outage test passed.
- Actual Neon history restore recovered a deleted synthetic row on an isolated
  branch and preserved all three migration records. Production was untouched.
  Both test branches and the temporary connection file were removed.
- Actual encrypted branch dump passed authenticated decryption and PostgreSQL
  archive listing. The ephemeral test key/archive were discarded; this was a
  rehearsal, not an operational recurring backup.
- Known production dependency vulnerabilities: zero at the audit time. Full Git
  history scan passed after the narrowly reviewed public-fixture exceptions.
- Standalone Windows package passed runtime checksum verification. A hidden local
  test started its bundled Node, served diagnostics and rejected cross-origin
  pairing, then stopped that exact test process.
- Current-runtime synthetic relay runs passed 10, 25, 50, 100 and 200 connections,
  with no baseline missing sequences or unexpected closes. At 200 connections,
  50 listeners rejoined successfully; measured server RSS peaked at 83 MB and
  loopback relay p95 was 6 ms on this computer. These are not WAN/speaker timings.
- A ten-minute baseline run on Node 22.14.0 passed with 100 connections, zero
  baseline sequence gaps/unexpected closes, 25 reconnects, peak RSS 88 MB and
  loopback relay p95 9 ms. The repeated current-runtime result is recorded in
  `ops/soak-results.json` when final validation completes.

## Remaining owner/deployment gates

1. Physical-device endurance, acoustic synchronization, weak-signal and lifecycle
   checks in `docs/OWNER-TESTS-AND-STORE-HANDOFF.md`.
2. Final UI refinement/accessibility, followed by version/cache identity update,
   signed APK/AAB verification and public rollout checks. Do not install a debug
   build over a differently signed public APK or discard the release signing key.
3. Select backup destination/retention and keep a recoverable key separately.
   Configure the required secrets before activating manual or scheduled backups.
   The inspected six-hour Neon history window is not an offsite-backup strategy.
4. Select a private monitoring host and notification recipient. Alert rules are
   prepared, but no active alert receiver has been provisioned.
5. Verify trusted proxy hops on the real hosting path at rollout and recheck
   shared-IP limits. Preserve database migrations and rollback procedures.
6. Complete account-holder Play Console testing, disclosures and store material.

These are targeted hardening and regression results, not an independent penetration
test or a certification of free-host capacity. 1,000 registered users does not mean
1,000 concurrent listeners; the service ceilings remain 200 connections/50 rooms.
The raw PCM transport and its bandwidth cost are unchanged. A compressed internet
transport remains a separately negotiated, cross-platform/quality-tested change;
it was not silently substituted for the sound the owner has already approved.
