# Security, moderation, and observability foundations

This document describes the reusable server-side contracts added for RoomSound.
The modules remain dependency-light and do not record audio. They are integrated
with the HTTP/WebSocket server, account repository, moderation routes, startup
health, metrics, and redacted audit logging. They can be exercised offline with
`node --test`.

## Modules

- `security.mjs`
  - `readJsonBody(request, options)` and `parseJsonBody(body, options)` bound
    bytes, nesting, fields, arrays, and strings; reject invalid UTF-8,
    prototype-pollution keys, invalid JSON, and non-object payloads by default.
  - `constantTimeEqual(left, right)`/`safeEqual` compare secret-like values
    using fixed-size SHA-256 digests and `timingSafeEqual`.
  - `redactSecrets(value)`/`redactLogValue` clone values for logs or metadata,
    redact secret-shaped fields, room/invite codes, bearer tokens, cookies, and
    token-bearing strings, and never mutate the input.
- `moderation.mjs`
  - `createReport`, `createBlock`, and `createBan` produce bounded, normalized
    data contracts with explicit IDs, timestamps, status, and expiry fields.
  - `validateReport`, `validateBlock`, and `validateBan` return
    `{ valid, errors }`; the corresponding `assertValid*` functions throw a
    `ModerationValidationError`.
  - `transitionReport`, `isBlocked`, and `isBanned` keep status transitions and
    expiry/scope checks deterministic. Moderation records use canonical
    `roomId`; room invite codes are not part of the stored contract.
- `audit.mjs`
  - `createAuditEvent` validates allowlisted event names and redacts metadata.
  - `createAuditRecorder` provides a bounded append-only in-process buffer and
    an optional sink. Sink failures are reported through `onSinkError` and do
    not break a request path.
- `observability.mjs`
  - `createStructuredLogger`/`createLogger` emits one JSON object per line and
    redacts every context, field, and error before writing to its sink.
  - `createMetricsRegistry` provides bounded counters, gauges, histograms, a
    JSON snapshot, and Prometheus text output. Secret-like label values are
    redacted.
  - `createHealthState` provides liveness, readiness checks with timeouts, and
    conventional HTTP response descriptors (`200` for live/ready and `503`
    while not ready).

## Server integration now in place

1. **HTTP body parsing** — `server.mjs` uses bounded `readJsonBody` for auth,
   moderation, and billing control routes, and `readRawBody` before Stripe
   signature verification. Request bodies, cookies, and authorization headers
   are not logged.

   ```js
   import { readJsonBody } from './security.mjs';
   const credentials = await readJsonBody(req, {
     maxBytes: 16 * 1024,
     requireObject: true,
     requireJsonContentType: true,
   });
   ```

   Map `RequestBodyError.status` and `.code` to the existing JSON error
   response. Do not put request bodies, cookies, or authorization headers in
   logs.

2. **Logger and audit recorder** — after repository/auth initialization, the
   server creates one process logger and recorder:

   ```js
   const logger = createLogger({ service: 'roomsound' });
   const audit = createAuditRecorder({ sink: (event) => logger.info('audit', event) });
   ```

   Startup, auth errors, shutdown, and billing/moderation boundaries use the
   structured logger. Audit events are bounded in memory and can be redirected
   to an external sink without exposing secrets.

3. **Health/readiness/metrics** — startup creates the health state and metrics
   registry, restores the durable room directory, and calls `setReady(true)`
   after the listener starts. The server exposes `/health`, `/ready`, and
   `/metrics`.

   ```js
   if (requestPath === '/health') return sendJson(res, 200, healthState.health());
   if (requestPath === '/ready') {
     const response = await healthState.readinessResponse();
     return sendJson(res, response.statusCode, response.body);
   }
   if (requestPath === '/metrics') {
     res.writeHead(200, {
       'Content-Type': metrics.contentType,
       'Cache-Control': 'no-store',
     });
     return res.end(metrics.renderPrometheus());
   }
   ```

   Increment bounded metrics from the existing `checkRateLimit`, WebSocket
   message handler, room count, and auth result branches. Never use room codes,
   access tokens, cookies, emails, or arbitrary user text as metric labels.

4. **Moderation commands** — authenticated HTTP report/block/ban endpoints
   normalize with `createReport`, `createBlock`, and `createBan`, persist through
   PostgreSQL or the offline adapter, and record redacted audit events. Ban and
   room-host block checks run before room entry. An internal admin console is
   still required before exposing administrator ban operations broadly.

5. **HTTP status mapping** — liveness is `200` whenever the process can answer;
   readiness is `503` until `setReady(true)` and whenever a registered
   dependency check fails. Keep readiness details limited to safe check names
   and redacted metadata; return generic failure codes rather than database
   URLs, credentials, or stack traces.

These integrations deliberately do not change the media plane and do not
introduce recording.
