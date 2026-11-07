# Render → Neon migration completed — 7 November 2026

The public service https://sangeet-pitaraa.onrender.com now uses the production
branch of Neon project wild-term-95375954. No paid plan was enabled.

## Data and verification

- Source: Render dpg-dbfnvgui0phs73d7kkq0-a (Sangeet Pitara), PostgreSQL 18.
- Atomic, read-only row snapshot of all nine public application tables.
- 10 room rows, 3 schema migration rows; users/sessions/moderation/billing empty.
- Source schema matches the checked-in versioned migrations.
- Snapshot SHA-256: 54b127d1391c95067198bcfc154f4f10ce280447f8e816cef0ad22b73e8227f8.
- Private backup: .private-migration/render-snapshot.json (Git ignored).
- A transactional restore to an isolated Neon branch matched every row/column.
- The restored app passed registration, login, room creation/chat, persisted rows
  and session survival across restart on the rehearsal branch.
- Source snapshot was checked unchanged under maintenance before production copy.
- Production restore refused to overwrite business data and committed only after
  full-row comparison of every table, including migration timestamps.
- After cutover, all 10 original room rows and original schema history still match.
- A new public verification room was created, chatted in and ended, then its
  ENDED row was found in Neon. This extra test record is intentionally retained.
- pg_stat_activity confirmed sangeetpitara-render-neon application connections.
- Cutover deployment dep-dbn9v6p5efls73anvbq0 reached live; maintenance lifted.

This is a logical application-data snapshot, not a full PostgreSQL cluster dump.
Schema is reproducible from migrations; the inspected source had only these nine
application tables. No database credentials are stored in the snapshot or Git.

## Configuration

Render DATABASE_URL is the Neon pooled URL and DATABASE_URL_UNPOOLED is direct.
Both enforce sslmode=verify-full and identify the deployed application.
DATABASE_MAINTENANCE_MODE=0; DATABASE_SSL=1; certificate verification stays enabled.
render.yaml now declares external database variables with sync:false, preserving
Dashboard values instead of reconnecting the service to Render on later pushes.
The old Render database remains declared and retained as a rollback source.

## Recovery and rollback

The old Render database has NOT been deleted and is unchanged by the transfer.
Its free instance expiry still applies (25 November 2026). The local snapshot must
be kept separately from that expiring database. To roll back after new user writes,
first freeze API/WebSocket writes, snapshot Neon and reconcile post-cutover changes;
do not simply point at the old database or newer activity would disappear.
The reversible maintenance flag blocks /api/* and new WebSockets while retaining
health/readiness/static pages. Bootstrap room restoration and session cleanup
are skipped in maintenance so the snapshot source remains quiescent.

Preparation regression: 116 Node tests passed on Node 22.14.0. An added integration
test verifies maintenance rejects auth writes and WebSocket entry with 503 while
health probes remain available. Rehearsal, production restore and public live
verification logs are local ignored *.log files. The verification-script duplicate
shutdown bug was corrected and the rehearsal exited successfully after retry.
