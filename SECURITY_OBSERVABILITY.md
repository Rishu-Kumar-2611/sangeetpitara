# Security, moderation, and observability foundations

This document describes the reusable server-side contracts added for RoomSound.
The modules are intentionally independent of the WebSocket room implementation,
the account repository, and audio capture. They can be exercised offline with
`node --test` and do not record audio.

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

## Exact server integration points

The current server remains unchanged by this foundation task. The next server
integration should make the following focused changes:

1. **HTTP body parsing** — in `server.mjs`, replace the local
   `readJsonBody(req)` used by `handleAuthRequest` with:

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

2. **Logger and audit recorder** — after repository/auth initialization, create
   one process logger and recorder:

   ```js
   const logger = createLogger({ service: 'roomsound' });
   const audit = createAuditRecorder({ sink: (event) => logger.info('audit', event) });
   ```

   Replace `console.log`/`console.error` in startup, auth errors, and shutdown
   with `logger.info`/`logger.error`. Record events at these existing flow
   boundaries: room creation/join/leave/end, successful/failed auth, rate
   limiting, rejected requests, and moderator actions. Pass canonical member
   or room IDs as top-level fields; put user-provided details in `metadata` so
   the shared redactor is always applied.

3. **Health/readiness/metrics** — create the health state and metrics registry
   during startup, register the repository as a readiness check, and call
   `healthState.setReady(true)` only after repository initialization and the
   HTTP/WebSocket listeners are ready. Add routes beside the current `/health`
   route:

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

4. **Moderation commands** — in `handleMessage`, after `currentMember(ws)` and
   before room state changes, normalize incoming report/block/ban payloads with
   `createReport`, `createBlock`, or `createBan`. Persist the resulting records
   through the persistence layer owned by the account/storage work; this task
   deliberately does not alter that layer. Enforce `isBlocked`/`isBanned`
   before join, chat, control requests, and source changes. Record each action
   with an `audit.record({ type: 'moderation.*', actorId, targetId, roomId })`.

5. **HTTP status mapping** — liveness is `200` whenever the process can answer;
   readiness is `503` until `setReady(true)` and whenever a registered
   dependency check fails. Keep readiness details limited to safe check names
   and redacted metadata; return generic failure codes rather than database
   URLs, credentials, or stack traces.

These integration points deliberately do not change the media plane and do not
introduce recording or a new dependency.
