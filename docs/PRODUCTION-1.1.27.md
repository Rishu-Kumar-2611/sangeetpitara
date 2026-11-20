# Production hardening release 1.1.27

Prepared 20 November 2026. This release improves the existing private audio-room app for a single production server. It does not certify every phone, carrier or hosting plan.

## Room recovery and audio

PostgreSQL stores a bounded recovery checkpoint on membership changes, every 30 seconds, and during graceful shutdown. It contains hashed guest/reconnect capabilities, member IDs, host/co-host roles, locks, slow mode, retired invite codes and ban digests. Names, live audio, chat and voice messages are excluded. Checkpoints expire after 15 minutes. The same device can reclaim its membership with its private reconnect secret; knowing a guest ID or room code alone cannot reclaim another member. Hosts may need to restart sharing after reconnecting. A crash can lose changes since the last successful checkpoint, and overlapping deployments are not a multi-server room protocol. Deploy at a quiet time.

The production image launches Node directly so shutdown signals reach the server. Shutdown rejects new connections, notifies clients, checkpoints rooms, flushes usage and closes sockets within the platform grace period. Keep one running instance and WEB_CONCURRENCY=1. Scaling beyond one instance requires a shared room coordinator and media routing.

Opus queues now use a bitrate-based backlog bound rather than allowing over a minute of old compressed audio to accumulate. PCM continuity behavior remains compatible. Check connection verifies readiness without asking for capture permissions. Recover audio resumes the local output and reconnects when appropriate; its result is not proof of audible playback. The Cushion control adjusts buffering and does not claim acoustic synchronization across speakers.

## Owner security

Visit /admin and sign in with the existing owner account, password and a fresh authenticator code. An unused recovery code can replace the authenticator code. The owner cookie is Secure in production, HttpOnly and SameSite=Strict, expires after one hour, and has a 15-minute idle timeout. Owner APIs recheck the configured owner identity, database role and session version. Privileged legacy moderation/account APIs require the same MFA-authorized owner session.

The Security section provides password changes, active-session viewing, sign out everywhere and eight single-use recovery codes. Changing the password requires the current password plus a fresh factor, rejects the old password as the new value, revokes all sessions and recovery codes, and signs the owner out. A password reset racing a login cannot issue a valid stale-credential session. Save new recovery codes privately when shown; only hashes are persisted. Each code works once, and generating a replacement set invalidates the earlier set. Global password hashing work and per-address login attempts are bounded.

Production account registration is disabled unless PUBLIC_REGISTRATION_ENABLED=1. Anonymous room creation and joining continue to work without accounts. Partial owner configuration or more than one Node worker fails startup. No default owner password or key is shipped. Operator recovery remains in ops/provision-owner.mjs; it revokes sessions and recovery codes.

## Moderation and capacity

Members can report another member to the owner. The server binds the report to current membership and rate limits it. Hosts/co-hosts can select 2/5/10-second chat slow mode, turn it off, and remove a participant message. The owner dashboard lists reports and records review, dismissal or resolution. A report is a request for review, not an automatic ban.

Cloud defaults are 200 simultaneous connections, 64 per client address and 50 active rooms. These are safety ceilings, not a guarantee that the hosting plan will deliver reliable audio at the ceiling. Android Nearby admits 24 connections including its host and rejects a 25th connection with a clear capacity message. Local browser Nearby HTTP/WebSocket traffic is unencrypted and intended for trusted Wi-Fi/hotspots.

## Statistics and privacy

Daily usage is retained up to 365 days; retry receipts expire after seven days. The owner can export daily CSV data. Device counts estimate app/browser identities and listening time estimates delivered relay audio, not people or verified audible playback. Nearby offline usage is excluded. Pending collection is bounded to 5,000 rows and a 24-hour retry horizon; outages and discarded collection are surfaced. PostgreSQL pruning runs hourly.

The public privacy/terms pages distinguish live broadcasts from optional voice recordings, describe reconnect capabilities and recovery-code handling, and explain Nearby transport. Support links use the project's public GitHub issue tracker at the owner's request. Do not post private content, room codes, passwords, keys or database URLs there.

## Backups and rollback

The database-backup workflow fails clearly if DATABASE_BACKUP_URL or BACKUP_ENCRYPTION_KEY is missing. It uploads encrypted archives with seven-day artifact retention. Keep the encryption key separately and monitor actual workflow outcomes; the existence of workflow code does not prove production backup secrets are configured.

Run npm run test:backup to create a real PostgreSQL custom-format dump, encrypt and authenticate it, restore it into a separate disposable database, and verify a known row. The rehearsal accepts no production database URL. It complements provider recovery drills; it does not restore production or prove offsite retention.

Migrations 006 and 007 add bounded room recovery and owner-session versioning/recovery-code storage. Keep them applied during application rollback. Roll back website code to a known verified commit if needed; an Android rollback requires a higher versionCode signed with the existing release key. Do not restore the production database merely to revert UI code.

## Release checks

Use the pinned Node 22.23.4 runtime. Run npm ci, npm run build, npm test, the desktop/phone Playwright suite, checks/postgres-integration.mjs against a disposable PostgreSQL database, the production-container smoke test, npm run test:backup, dependency/credential scans and the quick capacity/latency checks. Android requires JVM tests, debug assembly and lint; production release signing stays in the existing GitHub release workflow with the existing certificate.

Locally verified during this implementation: Android 116 JVM tests with zero failures/skips, debug assembly and lint; encrypted PostgreSQL backup/restore rehearsal; real PostgreSQL recovery/authentication/billing integration; production dependency audit with zero reported vulnerabilities; 25-connection loopback capacity and bounded playout checks. The final merged Node suite passed all 187 tests plus origin, payload and RTC checks. Production-container readiness, real PostgreSQL integration and isolated release-download/control checks also passed. The release checkout and production image separately passed those checks, and a 198-commit credential scan found no leaks after restricting the existing public RFC-vector exception to the two owner test files. Browser verification, hosted CI and the deployed version must pass before rollout is declared complete. CLI-generated logs are kept outside the repository.

Before a broad public launch, complete real-phone foreground/background, screen lock, audio focus/calls, Bluetooth, Wi-Fi/mobile/hotspot and long listening tests, then a 10–20-person WAN event. Browser automation and loopback tests cannot establish these results. An existing scheduled uptime workflow checks health/readiness and raises recovery/outage issues. A successful production backup run on 20 November created and verified an encrypted archive with seven-day artifact retention. Keep its encryption key recoverable separately, review failure notifications, and choose a dedicated metrics notification recipient before promising continuous operator coverage. Free hosting can still sleep or restart; a paid availability commitment requires an explicit hosting decision.
