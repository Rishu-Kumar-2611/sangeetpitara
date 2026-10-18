# RoomSound production deployment

This release keeps the existing Node.js HTTP/WebSocket media plane and is
provider-neutral. Use the runtime-only container for the web service. The
Android SDK image remains an explicit build target in `Dockerfile`; it is not
needed to run the web service.

## Production acceptance criteria

- A deployment starts on Node `22.14.0` from the checked-in lockfile.
- A configured PostgreSQL-compatible database is migrated before the HTTP
  listener accepts traffic.
- `GET /health` returns HTTP 200 and JSON with `ok: true`.
- The reverse proxy forwards HTTP and WebSocket upgrade requests and sets
  `X-Forwarded-For` only when `TRUST_PROXY=1` is enabled.
- `ALLOWED_ORIGINS` contains the browser's exact HTTPS origin.
- TURN values are present when participants may be on different networks.
- Secrets are injected by the platform and are absent from the image, Compose
  file, Render blueprint, and tracked environment examples.

The current application is intentionally single-process for live WebSocket
membership and WebRTC mesh media. Durable PostgreSQL room-directory metadata,
accounts, moderation records, billing events, and entitlements survive a
restart; active sockets, live capture, requests, and audio do not. There is no
recording. The release target is 100 concurrent users with at most 10 users in
a room. Run one web instance unless a future shared-room-state/SFU design adds
cross-instance coordination.

## Runtime-only container

`Dockerfile.runtime` copies only the Node/WebSocket runtime and browser assets.
It does not run Gradle, download an Android SDK, or depend on Android files.

```sh
npm ci
npm test
npm run check
docker build -f Dockerfile.runtime -t roomsound:local .
```

The image exposes port `4173` by default. Platforms that inject `PORT` can use
that value without changing the image. The image health check polls
`http://127.0.0.1:$PORT/health`.

## Docker Compose

The checked-in `compose.yaml` starts only the Node service by default. It uses
the in-memory repository when `DATABASE_URL` is empty. Postgres and Redis are
optional profiles:

```sh
cp ops/env.production.example .env
# Fill local-only DATABASE_URL/TURN values as needed; do not use this file as a
# production secret store.
```

To run the local Postgres profile, set a local password and point the app at
the Compose service before starting it. The URL must use the service hostname
`postgres`, not `localhost`:

```sh
POSTGRES_PASSWORD='local-only-value' \
DATABASE_URL='postgres://roomsound:local-only-value@postgres:5432/roomsound' \
docker compose --profile postgres up --build
```

Compose refuses to render the Postgres service when `POSTGRES_PASSWORD` is not
provided; the example contains no fallback password.

On PowerShell, set the two environment variables with `$env:POSTGRES_PASSWORD`
and `$env:DATABASE_URL` before running `docker compose`. The Redis profile is an
optional cache seam and is not read by the current room server:

```sh
docker compose --profile redis up --build
```

Do not expose Postgres or Redis ports to the public network. Compose health
checks wait for those optional services when their profile is enabled.

## Render

`render.yaml` is a Render Blueprint for a Docker web service backed by a
managed PostgreSQL database. In the Render dashboard, review the generated
service, set `ALLOWED_ORIGINS`, TURN values, and any billing secrets, then apply
the blueprint. Render supplies `PORT`; the blueprint sets `/health` as the
deployment health check and enables TLS at the platform edge.

The `STRIPE_*` values are `sync: false`. Leave them unset to keep billing
disabled; configure the secret key, webhook secret, price ID, and return URLs
only after the checkout/tax/refund policy has been approved.

## Health, readiness, metrics, and shutdown

RoomSound exposes these operational endpoints:

```text
GET /health  -> 200 {"ok":true,"service":"roomsound","websocket":true,...}
GET /ready   -> 200 when startup and migrations are ready, otherwise 503
GET /metrics -> bounded Prometheus text metrics; protect this endpoint at the proxy
```

Use `/health` for liveness and `/ready` for readiness in an orchestrator. The
process constructs the repository, applies PostgreSQL migrations, restores the
durable room directory, and only then opens the listener. A failed database
migration/restore exits before a listener is opened and the platform should
retry the service. Do not route `/config` or a browser page as a health check.

On `SIGTERM`/`SIGINT`, the server closes WebSocket rooms and the repository,
then exits. Give the container at least 5 seconds of termination grace. A
reverse proxy must allow WebSocket upgrades and should use a WebSocket idle
timeout longer than the expected room session.

## Database and secret operations

1. Provision PostgreSQL and keep `DATABASE_URL` in the platform secret store.
2. Set `DATABASE_SSL=1` for managed databases; keep certificate verification
   enabled unless the provider explicitly documents another trust model.
3. Deploy the image. Startup applies ordered SQL files in `migrations/` under a
   PostgreSQL advisory lock. `npm run migrate` is available for an explicit
   migration job using the same secret.
4. Back up the database and test restoring it before enabling account login.
5. Rotate `TURN_CREDENTIAL`, session/database credentials, and billing secrets
   through the platform; never put them in a Docker layer or tracked `.env`.

## Account, moderation, and legal launch requirements

Set `REQUIRE_AUTH=1` for a public SaaS deployment. The browser provides
same-origin email/password registration and login; WebSocket connections use the
HttpOnly session cookie. Android remains compatible with guest mode until its
native account/token flow is enabled, so do not turn on `REQUIRE_AUTH=1` for a
deployment that still needs the current guest-only Android build.

Replace the legal placeholders in `docs/PRIVACY.md`, `docs/TERMS.md`, and
`docs/ABUSE.md`, publish the pages, and set `ADMIN_EMAILS` or database admin
flags before accepting reports. Do not expose unrestricted ban operations to
the public internet; put them behind an internal admin console or network
policy.

## Operational smoke checks

After a deployment, run the following from a network that can reach the public
origin (replace the URL; do not print response headers containing cookies):

```sh
curl --fail --silent --show-error https://roomsound.example/health
# Discard /config because its TURN response can contain a credential.
curl --fail --silent --show-error -o /dev/null https://roomsound.example/config
npm run smoke
```

The browser room flow still requires WSS through the proxy and a valid TURN
configuration for cross-network audio. Check the application logs for startup,
health, migration, and graceful-shutdown messages without logging environment
values or webhook payloads.
