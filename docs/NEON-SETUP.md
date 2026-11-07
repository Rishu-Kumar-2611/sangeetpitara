# Neon PostgreSQL setup

Configured project wild-term-95375954 in organization org-jolly-rice-79969254,
branch production. `neon deploy` succeeded and pulled credentials into the
ignored .env file. No database credentials belong in Git or Android/browser code.

The existing pg driver remains the runtime driver for the long-running Node
server. DATABASE_URL is the pooled connection. DATABASE_URL_UNPOOLED is used
for versioned migrations and then closed; runtime requests reuse the pool.

`npm run build` validates deployable JavaScript (this application serves plain
JavaScript and HTML and has no frontend compilation step). It passed on Node
22.14.0. Actual Neon checks passed for schema migration, PostgreSQL readiness,
HTTP registration/login, authenticated WebSocket room creation/chat, SQL account
and room persistence, session survival across restart, and selected production
branch app readiness. Test accounts were created only in an isolated verification
branch, not production.

For future live Neon checks, create an expiring branch from production and set
NEON_VERIFY_BRANCH=codex-setup-verify-<unique-suffix>, then run
`node checks/neon-setup.mjs`. The optional --initialize-production flag explicitly
initializes the selected production schema and verifies readiness. Never point
checks/postgres-integration.mjs at the production database.

The public Render deployment still uses the original Render database. Existing
Render user data has NOT been imported into Neon. Before switching production:
export/securely back up the source database, restore into Neon, verify row counts
and application compatibility, briefly stop writes for the final transfer, then
update Render's database variables AND its Blueprint reference together. Keep
rollback access to the source. Do not switch the live service to an empty Neon
database. The currently available Render connector cannot provide source database
connection credentials; an external source connection must be supplied securely
for pg_dump/restore (never in chat).

Observed nonfatal setup warnings: Copilot CLI was absent (other Neon plugin
installation succeeded); local system Node is 26 while the app pins 22; pg warns
about future sslmode=require semantics. Current connections verified TLS under
the installed pg version. Prefer sslmode=verify-full for explicitly verified TLS.
