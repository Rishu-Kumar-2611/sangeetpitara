import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AuthConflictError,
  AuthValidationError,
  InvalidCredentialsError,
  clearSessionCookie,
  createAuthService,
  sessionCookieSecure,
  sessionTokenFromRequest,
  serializeSessionCookie,
} from './auth.mjs';
import { createAuditRecorder } from './audit.mjs';
import { createBillingService, entitlementAllows, normalizeEntitlement } from './billing.mjs';
import {
  createBan,
  createBlock,
  createReport,
  isBanActive,
  isBlockActive,
} from './moderation.mjs';
import { createStructuredLogger, createHealthState, createMetricsRegistry } from './observability.mjs';
import { createRepositoryFromEnv } from './persistence.mjs';
import {
  constantTimeEqual,
  readJsonBody as readSecureJsonBody,
  readRawBody,
  RequestBodyError as SecureRequestBodyError,
} from './security.mjs';
import { DEFAULT_REWARDED_ACCESS_CONFIG, normalizeRewardedAccessConfig } from './ads.mjs';
import {
  validatePcm16FrameHeader,
  MEDIA_RELAY_CHANNELS,
  MEDIA_RELAY_MAX_FRAME_BYTES,
  MEDIA_RELAY_MAX_PAYLOAD_BYTES,
  MEDIA_RELAY_SAMPLE_RATE,
} from './media-relay.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const rootPath = resolve(root);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const canonicalPublicHost = String(
  process.env.CANONICAL_PUBLIC_HOST
    || (process.env.NODE_ENV === 'production' ? 'sangeet-pitaraa.onrender.com' : ''),
).trim().toLowerCase();
const legacyPublicHosts = new Set(
  String(process.env.LEGACY_PUBLIC_HOSTS || 'sangeet-pitara.onrender.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const rooms = new Map();
const requestTtlMs = 45_000;

const requestJitterMs = 5_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_KEEP = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const STATIC_RATE_LIMIT_MAX = 600;
const BINARY_FRAME_WINDOW_MS = 5_000;
// Android playback capture emits 10 ms PCM frames (100 frames/sec). Keep a
// little headroom above that cadence while still bounding a client's relay
// work; browser packetizers use 20 ms frames and remain well below this cap.
const BINARY_FRAME_RATE_MAX = 600;
// Allow up to 64 KiB (~680 ms at 48 kHz mono PCM16) per listener socket so
// normal mobile/Wi-Fi TCP retransmission bursts do not drop audio frames.
const MAX_RELAY_BUFFERED_BYTES = 64 * 1024;
const STREAMING_STATIC_THRESHOLD_BYTES = 256 * 1024;
const turnEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.TURN_ENABLED || '').trim().toLowerCase());
const TURN_URLS = turnEnabled && process.env.TURN_URLS
  ? process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const mediaRelay = {
  enabled: !['0', 'false', 'off', 'no'].includes(String(process.env.MEDIA_RELAY_ENABLED ?? '1').trim().toLowerCase()),
  mode: 'pcm16',
  sampleRate: MEDIA_RELAY_SAMPLE_RATE,
  channels: MEDIA_RELAY_CHANNELS,
};
const adsenseClient = String(process.env.ADSENSE_CLIENT || '').trim();
const adsenseLandingSlot = String(process.env.ADSENSE_LANDING_SLOT || '').trim();
const adsenseRoomSlot = String(process.env.ADSENSE_ROOM_SLOT || '').trim();
const adsense = {
  enabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.ADSENSE_ENABLED || '').trim().toLowerCase())
    && /^ca-pub-\d+$/.test(adsenseClient)
    && /^\d+$/.test(adsenseLandingSlot)
    && /^\d+$/.test(adsenseRoomSlot),
  provider: 'adsense',
  client: adsenseClient,
  landingSlot: adsenseLandingSlot,
  roomSlot: adsenseRoomSlot,
};
const rewardedAccess = normalizeRewardedAccessConfig({
  enabled: ['1', 'true', 'yes', 'on', 'enabled'].includes(String(process.env.REWARDED_ACCESS_ENABLED || '').trim().toLowerCase()),
  provider: process.env.REWARDED_AD_PROVIDER || DEFAULT_REWARDED_ACCESS_CONFIG.provider,
  mode: process.env.REWARDED_AD_MODE || DEFAULT_REWARDED_ACCESS_CONFIG.mode,
  rewardDurationSeconds: process.env.REWARDED_AD_DURATION_SECONDS || DEFAULT_REWARDED_ACCESS_CONFIG.rewardDurationSeconds,
  accessDurationHours: process.env.REWARDED_ACCESS_DURATION_HOURS || DEFAULT_REWARDED_ACCESS_CONFIG.accessDurationHours,
});
const repository = await createRepositoryFromEnv(process.env);
const auth = createAuthService({
  repository,
  sessionTtlMs: process.env.SESSION_TTL_MS,
});
const secureSessionCookie = sessionCookieSecure(process.env);
const roomAuthRequired = false;
const billing = createBillingService({ env: process.env });
const logger = createStructuredLogger({
  service: 'roomsound',
  level: process.env.LOG_LEVEL || 'info',
  context: { repository: repository.kind },
});
const metrics = createMetricsRegistry({ prefix: 'roomsound' });
const httpRequests = metrics.registerCounter('http_requests', 'HTTP requests handled by route and status.');
const websocketConnections = metrics.registerGauge('websocket_connections', 'Currently open WebSocket connections.');
const activeRooms = metrics.registerGauge('active_rooms', 'Currently active in-memory rooms.');
const audit = createAuditRecorder({
  sink: (event) => logger.info('audit event', event),
  onSinkError: (error) => logger.warn('audit sink failed', { error }),
});
const health = createHealthState({
  service: 'roomsound',
  version: process.env.APP_VERSION || '0.1.0',
  ready: false,
  checks: {
    repository: async () => ({ ok: await repository.healthCheck(), kind: repository.kind }),
  },
});

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), display-capture=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-DNS-Prefetch-Control': 'off',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Origin-Agent-Cluster': '?1',
};

const rateLimit = new Map();
const staticRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) if (now > entry.resetAt) rateLimit.delete(ip);
  for (const [ip, entry] of staticRateLimit) if (now > entry.resetAt) staticRateLimit.delete(ip);
}, 60_000).unref();

function checkRateLimit(ip, { isStaticAsset = false } = {}) {
  const now = Date.now();
  const bucket = isStaticAsset ? staticRateLimit : rateLimit;
  const max = isStaticAsset ? STATIC_RATE_LIMIT_MAX : RATE_LIMIT_MAX;
  let entry = bucket.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    bucket.set(ip, entry);
  }
  entry.count += 1;
  return entry.count <= max;
}

function isAllowedOrigin(origin, allowedList) {
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  return allowedList.some((candidate) => {
    if (origin === candidate) return true;
    try {
      const allowedUrl = new URL(candidate);
      if (originUrl.protocol !== allowedUrl.protocol) return false;
      if (originUrl.host === allowedUrl.host) return true;
      if (originUrl.host.endsWith(`.${allowedUrl.host}`)) return true;
    } catch {
      return false;
    }
    return false;
  });
}

function getClientIp(req) {
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const randomId = () => crypto.randomUUID();
const randomCode = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

function lanAddresses() {
  if (process.env.NODE_ENV === 'production' && process.env.SHOW_LAN !== '1') return [];
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function clearSocketRoom(ws) {
  ws.roomId = null;
  ws.memberId = null;
}

function safeText(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

const SUPPORTED_SOURCE_TYPES = new Set([
  'DEVICE_AUDIO',
  'ANDROID_DEVICE_AUDIO',
  'WEB_TAB_AUDIO',
  'TEST_TONE',
]);

function requestedSourceType(value) {
  const type = safeText(value, 60).toUpperCase();
  return type || 'DEVICE_AUDIO';
}

function isSupportedSourceType(value) {
  return SUPPORTED_SOURCE_TYPES.has(value);
}

function findMember(room, memberId) {
  return room.members.get(memberId);
}

function isModerator(room, member) {
  return Boolean(member && (member.id === room.hostId || member.id === room.cohostId));
}

function publicMember(member, room) {
  return {
    id: member.id,
    guestId: member.guestId,
    name: member.name,
    role: member.role,
    online: Boolean(member.ws),
    isSource: room.activeSourceId === member.id,
    joinedAt: member.joinedAt,
  };
}

function clientState(room, viewer) {
  const requests = [...room.requests.values()]
    .filter((request) => request.status === 'PENDING')
    .filter((request) => isModerator(room, viewer) || request.requesterId === viewer?.id)
    .map((request) => ({ ...request }));

  return {
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      hostId: room.hostId,
      cohostId: room.cohostId,
      activeSourceId: room.activeSourceId,
      activeSourceType: room.activeSourceType,
      sourceStatus: room.sourceStatus,
      sourceEpoch: room.sourceEpoch,
      resumeSourceId: room.resumeSourceId,
      createdAt: room.createdAt,
    },
    self: viewer ? publicMember(viewer, room) : null,
    members: [...room.members.values()].map((member) => publicMember(member, room)),
    requests,
    messages: room.messages.slice(-80),
  };
}

function broadcastState(room, excludeMemberId = null) {
  for (const member of room.members.values()) {
    if (excludeMemberId && member.id === excludeMemberId) continue;
    if (member.ws) send(member.ws, { type: 'state', state: clientState(room, member) });
  }
}

function broadcast(room, payload) {
  for (const member of room.members.values()) send(member.ws, payload);
}

function sendError(ws, message) {
  send(ws, { type: 'error', message });
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  return readSecureJsonBody(req, {
    maxBytes: 16 * 1024,
    requireJsonContentType: true,
  });
}

function authErrorResponse(error) {
  if (error instanceof AuthValidationError) {
    return { status: 400, body: { error: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) } };
  }
  if (error instanceof AuthConflictError) {
    return { status: 409, body: { error: error.message, code: error.code } };
  }
  if (error instanceof InvalidCredentialsError) {
    return { status: 401, body: { error: error.message, code: error.code } };
  }
  return null;
}

function sessionCookieMaxAgeSeconds(expiresAt) {
  const remaining = Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : Math.ceil(auth.sessionTtlMs / 1000);
}

async function requestUser(req) {
  return auth.currentUser(sessionTokenFromRequest(req));
}

function configuredAdminEmails() {
  return new Set(String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function isAdminUser(user) {
  return Boolean(user?.isAdmin || configuredAdminEmails().has(String(user?.email || '').toLowerCase()));
}

async function handleProductApiRequest(req, res, requestPath) {
  const path = requestPath.replace(/\/+$/, '') || '/';
  const isReports = path === '/api/moderation/reports';
  const isBlocks = path === '/api/moderation/blocks';
  const blockMatch = path.match(/^\/api\/moderation\/blocks\/([^/]+)$/);
  const isBans = path === '/api/moderation/bans';
  const accountRevokeMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/revoke$/);
  const isBillingWebhook = path === '/api/billing/webhook';
  const isCheckout = path === '/api/billing/checkout';
  const isPortal = path === '/api/billing/portal';
  if (!isReports && !isBlocks && !blockMatch && !isBans && !accountRevokeMatch && !isBillingWebhook && !isCheckout && !isPortal) return false;

  try {
    if (isBillingWebhook) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' });
        return true;
      }
      if (!billing.enabled) {
        sendJson(res, 503, { error: 'Billing is not configured.', code: 'BILLING_DISABLED' });
        return true;
      }
      const rawBody = await readRawBody(req, { maxBytes: 256 * 1024 });
      const signature = req.headers['stripe-signature'];
      const verification = billing.verifyWebhook(rawBody, signature);
      if (!verification.ok) {
        audit.record({ type: 'security.request_rejected', severity: 'warn', metadata: { route: 'billing_webhook', reason: verification.code } });
        sendJson(res, 400, { error: 'Invalid billing signature.', code: verification.code });
        return true;
      }
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); } catch { sendJson(res, 400, { error: 'Invalid webhook JSON.' }); return true; }
      const eventId = String(event?.id || '').trim();
      if (!eventId) { sendJson(res, 400, { error: 'Webhook event id is required.' }); return true; }
      const fresh = await repository.recordBillingEvent('stripe', eventId);
      if (!fresh) { sendJson(res, 200, { ok: true, duplicate: true }); return true; }
      const object = event?.data?.object || {};
      const metadata = object.metadata || {};
      const subjectId = String(metadata.userId || metadata.subjectId || '').trim();
      if (!subjectId) { sendJson(res, 200, { ok: true, ignored: true }); return true; }
      const status = event.type?.endsWith('.deleted') ? 'canceled' : String(object.status || 'inactive').toLowerCase();
      const entitlement = normalizeEntitlement({
        subjectId,
        provider: 'stripe',
        customerId: object.customer || object.customer_id,
        subscriptionId: object.id,
        priceId: object.items?.data?.[0]?.price?.id || metadata.priceId,
        plan: metadata.plan || 'pro',
        status,
        currentPeriodEnd: object.current_period_end,
        cancelAtPeriodEnd: object.cancel_at_period_end,
        updatedAt: new Date(),
      });
      await repository.upsertEntitlement(entitlement);
      audit.record({ type: 'custom.billing.entitlement_updated', severity: 'info', actorId: subjectId, metadata: { provider: 'stripe', eventType: event.type } });
      sendJson(res, 200, { ok: true });
      return true;
    }

    const user = await requestUser(req);
    if (!user) {
      sendJson(res, 401, { error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
      return true;
    }

    if (isCheckout) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }); return true; }
      const body = await readJsonBody(req);
      const result = await billing.createCheckoutSession({
        userId: user.id,
        email: user.email,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
      });
      if (!result.ok) { sendJson(res, result.status === 400 ? 400 : 503, { error: result.error || 'Checkout is not configured.', code: result.code }); return true; }
      sendJson(res, 200, { url: result.payload.url, sessionId: result.payload.id });
      return true;
    }

    if (isPortal) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }); return true; }
      const entitlement = await repository.getEntitlement?.(user.id);
      const body = await readJsonBody(req);
      const result = await billing.createPortalSession({ customerId: entitlement?.customerId, returnUrl: body.returnUrl });
      if (!result.ok) { sendJson(res, result.status === 400 ? 400 : 503, { error: result.error || 'Billing portal is not configured.', code: result.code }); return true; }
      sendJson(res, 200, { url: result.payload.url });
      return true;
    }

    if (isReports) {
      if (req.method === 'GET') {
        const reports = await repository.listReports({ reporterId: isAdminUser(user) ? null : user.id });
        sendJson(res, 200, { reports });
        return true;
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' }); return true; }
      const body = await readJsonBody(req);
      const report = createReport({ ...body, reporterId: user.id });
      const stored = await repository.createReport(report);
      audit.record({ type: 'moderation.report.created', severity: 'info', actorId: user.id, targetId: report.targetId, roomId: report.roomId || undefined });
      sendJson(res, 201, { report: stored });
      return true;
    }

    if (isBlocks) {
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }); return true; }
      const body = await readJsonBody(req);
      const block = createBlock({ ...body, blockerId: user.id });
      const stored = await repository.createBlock(block);
      audit.record({ type: 'moderation.block.created', severity: 'info', actorId: user.id, targetId: block.blockedId, roomId: block.roomId || undefined });
      sendJson(res, 201, { block: stored });
      return true;
    }

    if (blockMatch) {
      if (req.method !== 'DELETE') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'DELETE' }); return true; }
      const blocks = await repository.listBlocks({ blockerId: user.id });
      const block = blocks.find((candidate) => candidate.id === blockMatch[1]);
      if (!block) { sendJson(res, 404, { error: 'Block not found.' }); return true; }
      await repository.deactivateBlock(block.id);
      audit.record({ type: 'moderation.block.removed', severity: 'info', actorId: user.id, targetId: block.blockedId, roomId: block.roomId || undefined });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (isBans) {
      if (!isAdminUser(user)) { sendJson(res, 403, { error: 'Administrator access required.' }); return true; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }); return true; }
      const body = await readJsonBody(req);
      const ban = createBan({ ...body, issuedBy: user.id });
      const stored = await repository.createBan(ban);
      audit.record({ type: 'moderation.ban.created', severity: 'warn', actorId: user.id, targetId: ban.subjectId, roomId: ban.roomId || undefined });
      sendJson(res, 201, { ban: stored });
      return true;
    }

    if (accountRevokeMatch) {
      if (!isAdminUser(user)) { sendJson(res, 403, { error: 'Administrator access required.' }); return true; }
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'POST' }); return true; }
      const targetId = decodeURIComponent(accountRevokeMatch[1]);
      if (targetId === user.id) { sendJson(res, 400, { error: 'Use a separate administrator account to revoke this account.' }); return true; }
      const revoked = await auth.revokeAccount(targetId);
      if (!revoked) { sendJson(res, 404, { error: 'Account not found or already revoked.' }); return true; }
      for (const socket of wss.clients) {
        if (socket.authenticatedUser?.id === targetId) {
          send(socket, { type: 'error', message: 'This account has been revoked.' });
          socket.close(4003, 'Account revoked');
        }
      }
      audit.record({ type: 'admin.account.revoked', severity: 'warn', actorId: user.id, targetId });
      sendJson(res, 200, { ok: true });
      return true;
    }
  } catch (error) {
    if (error instanceof SecureRequestBodyError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return true;
    }
    if (error?.status && error?.code) {
      sendJson(res, error.status, { error: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) });
      return true;
    }
    logger.error('Product API request failed', { error, route: requestPath });
    sendJson(res, 500, { error: 'Service unavailable.', code: 'PRODUCT_API_ERROR' });
    return true;
  }
  return true;
}

async function handleAuthRequest(req, res, requestPath) {
  const path = requestPath.replace(/\/+$/, '') || '/';
  const isRegister = path === '/api/auth/register';
  const isLogin = path === '/api/auth/login';
  const isLogout = path === '/api/auth/logout';
  const isCurrentUser = path === '/api/auth/me' || path === '/api/auth/current-user';
  if (!isRegister && !isLogin && !isLogout && !isCurrentUser) return false;

  const method = isCurrentUser ? 'GET' : 'POST';
  if (req.method !== method) {
    sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: method });
    return true;
  }

  try {
    if (isCurrentUser) {
      const user = await auth.currentUser(sessionTokenFromRequest(req));
      if (!user) {
        sendJson(res, 401, { error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' }, { Vary: 'Cookie, Authorization' });
      } else {
        sendJson(res, 200, { user }, { Vary: 'Cookie, Authorization' });
      }
      return true;
    }

    if (isLogout) {
      await auth.logout(sessionTokenFromRequest(req));
      audit.record({ type: 'auth.logout', severity: 'info' });
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie({ secure: secureSessionCookie }) });
      return true;
    }

    const credentials = await readJsonBody(req);
    const result = isRegister ? await auth.register(credentials) : await auth.login(credentials);
    audit.record({
      type: 'auth.login.succeeded',
      severity: 'info',
      actorId: result.user.id,
      metadata: { operation: isRegister ? 'register' : 'login' },
    });
    sendJson(res, isRegister ? 201 : 200, { user: result.user }, {
      'Set-Cookie': serializeSessionCookie(result.token, {
        maxAgeSeconds: sessionCookieMaxAgeSeconds(result.expiresAt),
        secure: secureSessionCookie,
      }),
    });
    return true;
  } catch (error) {
    if (error instanceof SecureRequestBodyError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return true;
    }
    const response = authErrorResponse(error);
    if (response) {
      if (error instanceof InvalidCredentialsError) audit.record({ type: 'auth.login.failed', severity: 'warn' });
      sendJson(res, response.status, response.body);
      return true;
    }
    logger.error('Authentication request failed', { error });
    sendJson(res, 500, { error: 'Authentication service unavailable.', code: 'AUTHENTICATION_ERROR' });
    return true;
  }
}

const ROOM_CODE_PATTERN = /^[A-F0-9]{6}$/;

function normalizeRoomCode(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\s-]+/g, '').toUpperCase();
  return ROOM_CODE_PATTERN.test(normalized) ? normalized : '';
}

function findRoomByCode(code) {
  const normalizedCode = normalizeRoomCode(code);
  if (!normalizedCode) return null;
  return [...rooms.values()].find((room) => room.code === normalizedCode);
}

function persistedRoomRecord(room) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    hostUserId: room.hostUserId || null,
    cohostUserId: room.cohostUserId || null,
    sourceStatus: room.sourceStatus,
    sourceType: room.activeSourceType,
    sourceEpoch: room.sourceEpoch,
    createdAt: new Date(room.createdAt).toISOString(),
    updatedAt: new Date(room.updatedAt || room.createdAt).toISOString(),
    endedAt: room.endedAt ? new Date(room.endedAt).toISOString() : null,
  };
}

async function persistRoom(room) {
  if (typeof repository.updateRoom !== 'function') return;
  room.updatedAt = Date.now();
  await repository.updateRoom(persistedRoomRecord(room));
}

async function createPersistedRoom(room) {
  if (typeof repository.createRoom !== 'function') return;
  room.updatedAt = Date.now();
  await repository.createRoom(persistedRoomRecord(room));
}

async function restorePersistedRooms() {
  if (typeof repository.listActiveRooms !== 'function') return;
  const records = await repository.listActiveRooms();
  for (const record of records) {
    const createdAt = Date.parse(record.createdAt);
    const room = {
      id: record.id,
      code: record.code,
      name: record.name,
      status: 'ACTIVE',
      hostId: null,
      hostUserId: record.hostUserId || null,
      cohostId: null,
      cohostUserId: record.cohostUserId || null,
      activeSourceId: null,
      activeSourceType: null,
      sourceStatus: 'NONE',
      sourceEpoch: Math.max(0, Number(record.sourceEpoch) || 0) + 1,
      resumeSourceId: null,
      resumeSourceType: null,
      members: new Map(),
      requests: new Map(),
      messages: [],
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      updatedAt: Date.now(),
      endedAt: null,
      cleanupTimer: null,
      hostFailoverTimer: null,
    };
    rooms.set(room.id, room);
  }
  if (records.length) logger.info('Restored durable room directory', { rooms: records.length });
}

function makeMember({ guestId, reconnectSecret = null, name, ws, role = 'PARTICIPANT' }) {
  return {
    id: randomId(),
    guestId: safeText(guestId, 80) || randomId(),
    reconnectSecret: safeText(reconnectSecret, 80) || null,
    accountId: ws?.authenticatedUser?.id || null,
    name: safeText(name, 40) || 'Guest',
    role,
    ws,
    joinedAt: Date.now(),
  };
}

async function moderationBlocksEntry(ws, room = null) {
  const userId = ws.authenticatedUser?.id;
  if (!userId) return false;
  const bans = await repository.listBans?.({ subjectId: userId, activeOnly: true }) || [];
  if (bans.some((ban) => isBanActive(ban, { roomId: room?.id || null }))) {
    sendError(ws, 'This account is not allowed to enter this room.');
    return true;
  }
  if (!room) return false;
  const blocks = await repository.listBlocks?.({ blockedId: userId, activeOnly: true }) || [];
  const blockedByHost = blocks.some((block) => (
    isBlockActive(block, { roomId: room.id })
      && (!room.hostUserId || block.blockerId === room.hostUserId)
  ));
  if (blockedByHost) {
    sendError(ws, 'The room host has blocked this account.');
    return true;
  }
  return false;
}

function attachRoom(ws, room, member) {
  if (room.hostFailoverTimer && member.id === room.hostId) {
    clearTimeout(room.hostFailoverTimer);
    room.hostFailoverTimer = null;
  }
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
  ws.roomId = room.id;
  ws.memberId = member.id;
  room.members.set(member.id, member);
  send(ws, { type: 'joined', state: clientState(room, member) });
  // Avoid sending a duplicate full state payload to the member who just received 'joined'.
  broadcastState(room, member.id);
}

async function createRoom(ws, message) {
  if (await moderationBlocksEntry(ws)) return;
  const roomName = safeText(message.name, 60);
  const displayName = safeText(message.displayName, 40);
  if (!roomName) return sendError(ws, 'Enter a room name before creating a room.');
  if (!displayName) return sendError(ws, 'Enter your name before creating or joining a room.');
  let code = randomCode();
  while (findRoomByCode(code)) code = randomCode();

  const room = {
    id: randomId(),
    code,
    name: roomName,
    status: 'ACTIVE',
    hostId: null,
    hostUserId: ws.authenticatedUser?.id || null,
    cohostId: null,
    cohostUserId: null,
    activeSourceId: null,
    activeSourceType: null,
    sourceStatus: 'NONE',
    sourceEpoch: 0,
    resumeSourceId: null,
    resumeSourceType: null,
    members: new Map(),
    requests: new Map(),
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
    cleanupTimer: null,
    hostFailoverTimer: null,
  };

  const member = makeMember({
    guestId: message.guestId,
    reconnectSecret: message.reconnectSecret,
    name: displayName,
    ws,
    role: 'HOST',
  });
  room.hostId = member.id;
  try {
    await createPersistedRoom(room);
    rooms.set(room.id, room);
  } catch (error) {
    logger.error('Room persistence failed during creation', { error });
    return sendError(ws, 'The room could not be saved. Try again.');
  }
  attachRoom(ws, room, member);
}

async function joinRoom(ws, message) {
  const displayName = safeText(message.displayName, 40);
  if (!displayName) return sendError(ws, 'Enter your name before creating or joining a room.');
  const room = findRoomByCode(message.code);
  if (!room || room.status !== 'ACTIVE') return sendError(ws, 'That room is unavailable or has ended.');
  if (await moderationBlocksEntry(ws, room)) return;

  const guestIdClean = safeText(message.guestId, 80);
  const reconnectSecretClean = safeText(message.reconnectSecret, 80) || null;
  const existing = [...room.members.values()].find((member) => (
    (ws.authenticatedUser && member.accountId === ws.authenticatedUser.id)
      || (!ws.authenticatedUser && member.guestId === guestIdClean)
  ));
  if (existing?.ws) return sendError(ws, 'This account is already connected to the room.');
  if (existing && !existing.ws) {
    // Prevent another room participant from spoofing a disconnected member's guestId
    // when a client-side reconnectSecret was bound to the member slot.
    if (existing.reconnectSecret && reconnectSecretClean !== existing.reconnectSecret) {
      return sendError(ws, 'This account is already connected to the room.');
    }
    existing.ws = ws;
    existing.name = displayName;
    attachRoom(ws, room, existing);
    return;
  }

  const onlineCount = [...room.members.values()].filter((member) => member.ws).length;
  const totalCount = room.members.size;
  if (onlineCount >= 10 || totalCount >= 14) {
    return sendError(ws, 'This room is full. The limit is 10 people.');
  }

  const accountId = ws.authenticatedUser?.id || null;
  const role = accountId && room.hostUserId === accountId
    ? 'HOST'
    : accountId && room.cohostUserId === accountId
      ? 'CO_HOST'
      : 'PARTICIPANT';
  const member = makeMember({
    guestId: message.guestId,
    reconnectSecret: message.reconnectSecret,
    name: displayName,
    ws,
    role,
  });
  if (role === 'HOST') room.hostId = member.id;
  if (role === 'CO_HOST') room.cohostId = member.id;
  attachRoom(ws, room, member);
}

function trimMessages(room) {
  if (room.messages.length > MAX_MESSAGES) {
    room.messages.splice(0, room.messages.length - MAX_MESSAGE_KEEP);
  }
}

function addSystemMessage(room, text) {
  const message = { id: randomId(), kind: 'system', text: safeText(text, 280), createdAt: Date.now() };
  room.messages.push(message);
  trimMessages(room);
  broadcast(room, { type: 'chat', message });
}

function setSource(room, member, sourceType, status = 'STARTING') {
  room.activeSourceId = member.id;
  room.activeSourceType = isSupportedSourceType(sourceType) ? sourceType : 'DEVICE_AUDIO';
  room.sourceStatus = status;
  room.sourceEpoch += 1;
  void persistRoom(room).catch((error) => logger.error('Room persistence failed during source update', { error }));
}

function stopSource(room, reason, resume = true, notify = true) {
  const previousId = room.activeSourceId;
  const previousMember = previousId ? findMember(room, previousId) : null;
  const shouldResume = resume && previousMember?.role === 'PARTICIPANT' && room.resumeSourceId;

  if (shouldResume) {
    const resumeMember = findMember(room, room.resumeSourceId);
    room.activeSourceId = resumeMember?.ws ? room.resumeSourceId : null;
    room.activeSourceType = room.activeSourceId ? room.resumeSourceType : null;
    room.sourceStatus = room.activeSourceId ? 'LIVE' : 'NONE';
    room.sourceEpoch += 1;
    room.resumeSourceId = null;
    room.resumeSourceType = null;
  } else {
    room.activeSourceId = null;
    room.activeSourceType = null;
    room.sourceStatus = 'NONE';
    room.sourceEpoch += 1;
    room.resumeSourceId = null;
    room.resumeSourceType = null;
  }

  addSystemMessage(room, reason || 'The active audio source stopped.');
  void persistRoom(room).catch((error) => logger.error('Room persistence failed during source stop', { error }));
  if (notify) broadcastState(room);
}

function scheduleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const online = [...room.members.values()].some((member) => member.ws);
    if (!online && room.status === 'ACTIVE') {
      room.status = 'ENDED';
      room.endedAt = Date.now();
      if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
      rooms.delete(room.id);
      void persistRoom(room).catch((error) => logger.error('Room persistence failed during cleanup', { error }));
    }
  }, 5 * 60 * 1000);
}

function promoteCohost(room) {
  const cohost = room.cohostId ? findMember(room, room.cohostId) : null;
  if (!cohost || !cohost.ws) return false;
  const previousHost = findMember(room, room.hostId);
  if (previousHost) previousHost.role = 'PARTICIPANT';
  room.hostId = cohost.id;
  room.hostUserId = cohost.accountId || null;
  room.cohostId = null;
  room.cohostUserId = null;
  cohost.role = 'HOST';
  addSystemMessage(room, `${cohost.name} is now the host.`);
  broadcast(room, { type: 'host-promoted', memberId: cohost.id });
  broadcastState(room);
  void persistRoom(room).catch((error) => logger.error('Room persistence failed during host promotion', { error }));
  return true;
}

function handleDisconnect(ws) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  if (!room) {
    clearSocketRoom(ws);
    return;
  }
  const member = findMember(room, ws.memberId);
  if (!member || member.ws !== ws) {
    clearSocketRoom(ws);
    return;
  }
  member.ws = null;

  if (room.activeSourceId === member.id) {
    stopSource(room, 'The active audio source has disconnected.', true);
    broadcast(room, { type: 'source-disconnected', memberId: member.id });
  }

  if (member.id === room.hostId) {
    broadcast(room, { type: 'host-disconnected', memberId: member.id });
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    room.hostFailoverTimer = setTimeout(() => {
      if (room.hostId === member.id && !findMember(room, member.id)?.ws) {
        if (!promoteCohost(room)) {
          addSystemMessage(room, 'The host is unavailable. This room will close when everyone leaves.');
          broadcastState(room);
        }
      }
    }, 30_000);
  }

  if (![...room.members.values()].some((item) => item.ws)) scheduleCleanup(room);
  broadcastState(room);
  clearSocketRoom(ws);
}

function currentMember(ws) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  const member = room ? findMember(room, ws.memberId) : null;
  return { room, member };
}

function isValidType(value) {
  return typeof value === 'string' && /^[a-z-]+$/.test(value);
}

function handleBinaryFrame(ws, raw) {
  if (!mediaRelay.enabled) return sendError(ws, 'Binary media relay is disabled.');
  const { room, member } = currentMember(ws);
  if (!room || !member || member.ws !== ws) return sendError(ws, 'Join or create a room first.');
  if (room.activeSourceId !== member.id) return sendError(ws, 'You are not authorized to publish audio right now.');

  let header;
  try {
    // Zero-copy O(1) header check: avoids allocating Int16Array(960) and looping
    // over 48,000 samples/sec on the Node.js event loop.
    header = validatePcm16FrameHeader(raw, { maxPayloadBytes: MEDIA_RELAY_MAX_PAYLOAD_BYTES });
  } catch (error) {
    return sendError(ws, `Invalid media relay frame: ${error.message}`);
  }
  if (header.sourceEpoch !== room.sourceEpoch) return sendError(ws, 'Stale source epoch.');

  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  for (const target of room.members.values()) {
    if (target.id === member.id || !target.ws || target.ws.readyState !== WebSocket.OPEN) continue;
    if (Number(target.ws.bufferedAmount) > MAX_RELAY_BUFFERED_BYTES) continue;
    target.ws.send(bytes);
  }
}

async function handleMessage(ws, message) {
  const type = message?.type;
  if (typeof type !== 'string' || !isValidType(type)) return sendError(ws, 'Invalid message type.');
  if (type === 'create-room') return createRoom(ws, message);
  if (type === 'join-room') return joinRoom(ws, message);

  const { room, member } = currentMember(ws);
  if (!room || !member) return sendError(ws, 'Join or create a room first.');

  if (type === 'chat') {
    const text = safeText(message.text, 280);
    if (!text) return;
    const chat = { id: randomId(), kind: 'chat', senderId: member.id, senderName: member.name, text, createdAt: Date.now() };
    room.messages.push(chat);
    trimMessages(room);
    broadcast(room, { type: 'chat', message: chat });
    return;
  }

  if (type === 'rtc') {
    if (!message.to || typeof message.to !== 'string') return sendError(ws, 'Invalid RTC target.');
    if (!message.signal || typeof message.signal !== 'object') return sendError(ws, 'Invalid RTC signal.');
    if (!room.activeSourceId) return sendError(ws, 'No active source.');
    if (Number.isInteger(message.sourceEpoch) && message.sourceEpoch !== room.sourceEpoch) {
      return sendError(ws, 'Stale source epoch.');
    }
    const target = findMember(room, message.to);
    if (!target?.ws) return;
    const signal = message.signal;
    const sigType = signal.type || signal.description?.type || (signal.candidate ? 'candidate' : '');
    const isCandidate = !!signal.candidate || sigType === 'candidate';
    const isOffer = sigType === 'offer';
    const isAnswer = sigType === 'answer';
    const fromIsSource = member.id === room.activeSourceId;
    const toIsSource = target.id === room.activeSourceId;
    if (isOffer) {
      if (!fromIsSource) return sendError(ws, 'Not authorized to offer.');
      if (toIsSource) return sendError(ws, 'Invalid offer target.');
    } else if (isAnswer) {
      if (fromIsSource) return sendError(ws, 'Source cannot answer itself.');
      if (!toIsSource) return sendError(ws, 'Answer must target the active source.');
    } else if (isCandidate) {
      if (fromIsSource === toIsSource) return sendError(ws, 'Candidates must be between source and listener.');
    } else {
      if (fromIsSource === toIsSource) return sendError(ws, 'RTC must be between source and listener.');
    }
    const forwarded = { type: 'rtc', from: member.id, signal: message.signal, sourceEpoch: room.sourceEpoch };
    send(target.ws, forwarded);
    return;
  }

  if (type === 'request-control') {
    if (room.activeSourceId === member.id) return sendError(ws, 'You are already the active source.');
    const sourceType = requestedSourceType(message.sourceType);
    if (!isSupportedSourceType(sourceType)) return sendError(ws, 'Only device playback audio is supported.');
    const hasPending = [...room.requests.values()].some((request) => request.requesterId === member.id && request.status === 'PENDING');
    if (hasPending) return sendError(ws, 'You already have a pending request.');
    const ttl = requestTtlMs + Math.floor(Math.random() * requestJitterMs);
    const request = {
      id: randomId(),
      requesterId: member.id,
      requesterName: member.name,
      sourceType,
      note: safeText(message.note, 160),
      status: 'PENDING',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    room.requests.set(request.id, request);
    broadcast(room, { type: 'control-requested', request });
    broadcastState(room);
    setTimeout(() => {
      if (request.status !== 'PENDING' || room.status !== 'ACTIVE') return;
      request.status = 'EXPIRED';
      const requester = findMember(room, request.requesterId);
      if (requester?.ws) send(requester.ws, { type: 'request-result', status: 'EXPIRED', request });
      broadcast(room, { type: 'control-request-expired', requestId: request.id });
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 10_000);
    }, ttl);
    return;
  }

  if (type === 'cancel-request') {
    const request = room.requests.get(message.requestId);
    if (request?.requesterId === member.id && request.status === 'PENDING') {
      request.status = 'CANCELED';
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 5_000);
    }
    return;
  }

  if (type === 'approve-request' || type === 'reject-request') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can manage requests.');
    const request = room.requests.get(message.requestId);
    if (!request || request.status !== 'PENDING') return sendError(ws, 'That request is no longer available.');
    const requester = findMember(room, request.requesterId);
    if (type === 'reject-request') {
      request.status = 'REJECTED';
      if (requester?.ws) send(requester.ws, { type: 'request-result', status: 'REJECTED', request });
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 10_000);
      return;
    }
    if (!requester || !requester.ws) {
      request.status = 'CANCELED';
      broadcastState(room);
      setTimeout(() => room.requests.delete(request.id), 5_000);
      return sendError(ws, 'That participant is no longer connected.');
    }
    request.status = 'APPROVED';
    room.resumeSourceId = room.activeSourceId;
    room.resumeSourceType = room.activeSourceType;
    setSource(room, requester, request.sourceType, 'STARTING');
    if (requester.ws) send(requester.ws, { type: 'request-result', status: 'APPROVED', request });
    addSystemMessage(room, `${requester.name} was approved to share audio.`);
    broadcastState(room);
    setTimeout(() => room.requests.delete(request.id), 30_000);
    return;
  }

  if (type === 'grant-source') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can grant audio control.');
    const target = findMember(room, message.memberId);
    if (!target || !target.ws) return sendError(ws, 'That participant is no longer connected.');
    const sourceType = requestedSourceType(message.sourceType);
    for (const [id, req] of room.requests) {
      if (req.requesterId === target.id && req.status === 'PENDING') {
        req.status = 'APPROVED';
        setTimeout(() => room.requests.delete(id), 10_000);
      }
    }
    room.resumeSourceId = room.activeSourceId;
    room.resumeSourceType = room.activeSourceType;
    setSource(room, target, sourceType, 'STARTING');
    send(target.ws, {
      type: 'request-result',
      status: 'APPROVED',
      request: {
        id: randomId(),
        requesterId: target.id,
        requesterName: target.name,
        sourceType,
        note: 'Granted by host',
        status: 'APPROVED',
        createdAt: Date.now(),
      },
    });
    addSystemMessage(room, `${member.name} gave audio control to ${target.name}.`);
    broadcastState(room);
    return;
  }

  if (type === 'start-source') {
    const authorized = member.id === room.activeSourceId || (isModerator(room, member) && (!room.activeSourceId || room.activeSourceId === member.id));
    if (!authorized) return sendError(ws, 'You are not authorized to publish audio right now.');
    const sourceType = requestedSourceType(message.sourceType);
    if (!isSupportedSourceType(sourceType)) return sendError(ws, 'Only device playback audio is supported.');
    setSource(room, member, sourceType, 'LIVE');
    addSystemMessage(room, `${member.name} is sharing ${safeText(message.sourceLabel, 80) || 'audio'}.`);
    broadcastState(room);
    return;
  }

  if (type === 'stop-source') {
    if (member.id !== room.activeSourceId && !isModerator(room, member)) return sendError(ws, 'You cannot stop the active source.');
    stopSource(room, `${member.name} stopped sharing audio.`, true);
    return;
  }

  if (type === 'takeover') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can take control.');
    const sourceType = requestedSourceType(message.sourceType);
    if (!isSupportedSourceType(sourceType)) return sendError(ws, 'Only device playback audio is supported.');
    room.resumeSourceId = null;
    room.resumeSourceType = null;
    setSource(room, member, sourceType, 'STARTING');
    addSystemMessage(room, `${member.name} took control of the room.`);
    broadcast(room, { type: 'takeover', memberId: member.id });
    broadcastState(room);
    return;
  }

  if (type === 'assign-cohost') {
    if (member.id !== room.hostId) return sendError(ws, 'Only the host can assign a co-host.');
    if (!message.memberId) {
      const previous = room.cohostId ? findMember(room, room.cohostId) : null;
      if (previous) previous.role = 'PARTICIPANT';
      room.cohostId = null;
      room.cohostUserId = null;
      addSystemMessage(room, 'The co-host role was removed.');
      broadcastState(room);
      void persistRoom(room).catch((error) => logger.error('Room persistence failed during co-host removal', { error }));
      return;
    }
    const target = findMember(room, message.memberId);
    if (!target || target.id === room.hostId) return sendError(ws, 'That participant cannot be made co-host.');
    if (!target.ws) return sendError(ws, 'That participant is not currently connected.');
    if (room.cohostId && room.cohostId !== target.id) {
      const previous = findMember(room, room.cohostId);
      if (previous) previous.role = 'PARTICIPANT';
    }
    room.cohostId = target.id;
    room.cohostUserId = target.accountId || null;
    target.role = 'CO_HOST';
    addSystemMessage(room, `${target.name} is now co-host.`);
    broadcastState(room);
    void persistRoom(room).catch((error) => logger.error('Room persistence failed during co-host assignment', { error }));
    return;
  }

  if (type === 'remove-member') {
    if (!isModerator(room, member)) return sendError(ws, 'Only the host or co-host can remove participants.');
    const target = findMember(room, message.memberId);
    if (!target || target.id === room.hostId) return sendError(ws, 'That participant cannot be removed.');
    if (room.activeSourceId === target.id) stopSource(room, 'The active source was removed.', true, false);
    if (target.ws) {
      send(target.ws, { type: 'removed', message: 'You were removed from the room.' });
      target.ws.close(4003, 'Removed from room');
    }
    room.members.delete(target.id);
    if (room.cohostId === target.id) {
      room.cohostId = null;
      room.cohostUserId = null;
    }
    for (const [id, req] of room.requests) if (req.requesterId === target.id) room.requests.delete(id);
    broadcastState(room);
    void persistRoom(room).catch((error) => logger.error('Room persistence failed during member removal', { error }));
    return;
  }

  if (type === 'end-room') {
    if (member.id !== room.hostId) return sendError(ws, 'Only the host can end the room.');
    room.status = 'ENDED';
    room.endedAt = Date.now();
    broadcast(room, { type: 'room-ended', message: 'The host ended the room.' });
    for (const participant of room.members.values()) {
      const participantSocket = participant.ws;
      participant.ws = null;
      if (participantSocket) {
        clearSocketRoom(participantSocket);
        participantSocket.close(1000, 'Room ended');
      }
    }
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    rooms.delete(room.id);
    void persistRoom(room).catch((error) => logger.error('Room persistence failed during room end', { error }));
    return;
  }

  if (type === 'leave-room') {
    const leavingHost = member.id === room.hostId;
    if (leavingHost) {
      if (room.activeSourceId === member.id) stopSource(room, 'The host stopped sharing audio.', false);
      if (!promoteCohost(room)) {
        addSystemMessage(room, 'The host left the room. A co-host was not available to take over.');
        broadcastState(room);
      }
    }
    handleDisconnect(ws);
    if (!leavingHost) {
      room.members.delete(member.id);
      if (room.cohostId === member.id) {
        room.cohostId = null;
        room.cohostUserId = null;
      }
      for (const [id, req] of room.requests) if (req.requesterId === member.id) room.requests.delete(id);
      broadcastState(room);
    }
    ws.close(1000, 'Left room');
  }
}

function buildTurnConfig() {
  if (!TURN_URLS.length) return null;
  return {
    urls: TURN_URLS,
    username: TURN_USERNAME || undefined,
    credential: TURN_CREDENTIAL || undefined,
  };
}

function canonicalPublicRedirect(req, url) {
  const requestHost = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
  if (!canonicalPublicHost || !legacyPublicHosts.has(requestHost) || requestHost === canonicalPublicHost) return null;
  const target = new URL(url.href);
  target.protocol = 'https:';
  target.host = canonicalPublicHost;
  return target.href;
}

function streamStaticFile(req, res, filePath, size, headers) {
  const rangeHeader = req.headers.range;
  headers['Accept-Ranges'] = 'bytes';
  if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
    const match = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(match[0], 10);
    const end = match[1] ? parseInt(match[1], 10) : size - 1;
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end < size && start <= end) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(filePath, { start, end });
      stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      stream.pipe(res);
      return;
    }
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  headers['Content-Length'] = String(size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(filePath);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = url.pathname;

  const redirectLocation = canonicalPublicRedirect(req, url);
  const operationalPath = ['/health', '/ready', '/metrics'].includes(requestPath);
  if (redirectLocation && !operationalPath) {
    res.writeHead(308, {
      Location: redirectLocation,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  // Liveness and readiness probes run before IP rate limiting so orchestrators
  // and load balancers behind shared proxy IPs are never throttled.
  if (requestPath === '/health') {
    activeRooms.set(rooms.size);
    httpRequests.inc(1, { route: 'health', status: 200 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...health.getHealth(), websocket: true, port, rooms: rooms.size }));
    return;
  }
  if (requestPath === '/ready') {
    const response = await health.readinessResponse();
    httpRequests.inc(1, { route: 'ready', status: response.statusCode });
    res.writeHead(response.statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: response.statusCode === 200, ...response.body }));
    return;
  }

  const reqExt = extname(requestPath);
  const isStaticAssetRequest = (req.method === 'GET' || req.method === 'HEAD')
    && ['.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.webmanifest'].includes(reqExt);
  const ip = getClientIp(req);
  if (!checkRateLimit(ip, { isStaticAsset: isStaticAssetRequest })) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' });
    res.end('Too Many Requests');
    return;
  }

  if (await handleAuthRequest(req, res, requestPath)) return;
  if (await handleProductApiRequest(req, res, requestPath)) return;

  if (requestPath === '/metrics') {
    const metricsToken = String(process.env.METRICS_BEARER_TOKEN || '').trim();
    if (metricsToken) {
      const authHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!constantTimeEqual(authHeader, metricsToken)) {
        httpRequests.inc(1, { route: 'metrics', status: 401 });
        sendJson(res, 401, { error: 'Unauthorized metrics request.' });
        return;
      }
    }
    httpRequests.inc(1, { route: 'metrics', status: 200 });
    res.writeHead(200, { 'Content-Type': metrics.contentType, 'Cache-Control': 'no-store' });
    res.end(metrics.renderPrometheus());
    return;
  }
  if (requestPath === '/api/billing/status') {
    const user = await auth.currentUser(sessionTokenFromRequest(req));
    if (!user) {
      httpRequests.inc(1, { route: 'billing_status', status: 401 });
      sendJson(res, 401, { error: 'Authentication required.', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    const entitlement = await repository.getEntitlement?.(user.id) || null;
    httpRequests.inc(1, { route: 'billing_status', status: 200 });
    sendJson(res, 200, {
      userId: user.id,
      billing: billing.status(),
      entitlement,
      canUsePro: Boolean(entitlement && entitlementAllows(entitlement, 'pro')),
    }, { Vary: 'Cookie, Authorization' });
    return;
  }
  if (requestPath === '/config') {
    const turn = buildTurnConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...(turn ? [turn] : [])],
      mediaRelay,
      maxMembers: 10,
      requestTtlMs,
      authRequired: roomAuthRequired,
      rewardedAccess,
      adsense,
    }));
    return;
  }
  if (requestPath === '/ads.txt') {
    const publisher = adsenseClient.replace(/^ca-/, '');
    if (!/^pub-\d+$/.test(publisher)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(`google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n`);
    return;
  }
  const fileName = requestPath === '/' ? 'index.html' : requestPath.replace(/^\//, '');
  let decodedPath = requestPath;
  try { decodedPath = decodeURIComponent(requestPath); } catch {}
  if (decodedPath.includes('\0') || decodedPath.split('/').includes('..') || fileName.includes('\0')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (
    fileName.startsWith('.') ||
    fileName.includes('/.') ||
    /(^|\/)(server\.mjs|package\.json|package-lock\.json|\.env[^\/]*|Dockerfile|\.git[^\/]*|node_modules)(\/|$)/i.test(fileName)
  ) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const filePath = resolve(rootPath, fileName);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${sep}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  const allowedExts = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.wasm', '.ico', '.txt', '.xml', '.apk']);
  if (!allowedExts.has(extname(filePath))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  try {
    const ext = extname(filePath);
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': mime };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' https://pagead2.googlesyndication.com https://www.googletagservices.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net; media-src 'self' blob: data:; connect-src 'self' ws: wss:; frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com; frame-ancestors 'none'";
      headers['Cache-Control'] = 'no-cache';
    } else if (fileName === 'downloads/SangeetPitara-debug.apk') {
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    // Stream large binaries (such as the 29 MB Android APK) instead of buffering
    // the entire file in RAM with readFile(), preventing container OOM crashes.
    if (ext === '.apk' || fileStats.size >= STREAMING_STATIC_THRESHOLD_BYTES) {
      streamStaticFile(req, res, filePath, fileStats.size, headers);
      return;
    }

    const content = await readFile(filePath);
    headers['Content-Length'] = String(content.byteLength);
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  maxPayload: 512 * 1024,
  verifyClient: (info, cb) => {
    const allowed = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (allowed && allowed.length) {
      const origin = info.origin || info.req.headers.origin || '';
      if (origin && !isAllowedOrigin(origin, allowed)) {
        cb(false, 403, 'Origin not allowed');
        return;
      }
    }
    const ip = getClientIp(info.req);
    if (!checkRateLimit(ip)) {
      cb(false, 429, 'Too Many Requests');
      return;
    }
    cb(true);
  },
});

function dispatchMessage(ws, data) {
  void handleMessage(ws, data).catch((error) => {
    logger.error('WebSocket message handling failed', { error });
    sendError(ws, 'The server could not process that action.');
  });
}

function dispatchBinaryFrame(ws, data) {
  try {
    handleBinaryFrame(ws, data);
  } catch (error) {
    logger.error('WebSocket binary frame handling failed', { error });
    sendError(ws, 'The server could not process that media frame.');
  }
}

function dispatchPending(ws, pending) {
  if (pending?.binary) dispatchBinaryFrame(ws, pending.data);
  else dispatchMessage(ws, pending?.data ?? pending);
}

function checkJsonMessageRate(ws) {
  const now = Date.now();
  if (!ws._msgReset || now > ws._msgReset) {
    ws._msgReset = now + 5000;
    ws._msgCount = 0;
  }
  ws._msgCount = (ws._msgCount || 0) + 1;
  return ws._msgCount <= 30;
}

function checkBinaryFrameRate(ws) {
  const now = Date.now();
  if (!ws._binaryFrameReset || now > ws._binaryFrameReset) {
    ws._binaryFrameReset = now + BINARY_FRAME_WINDOW_MS;
    ws._binaryFrameCount = 0;
  }
  ws._binaryFrameCount = (ws._binaryFrameCount || 0) + 1;
  return ws._binaryFrameCount <= BINARY_FRAME_RATE_MAX;
}

wss.on('connection', (ws, req) => {
  try { req.socket?.setNoDelay?.(true); } catch {}
  ws._ip = getClientIp(req);
  ws.authenticatedUser = null;
  ws.authReady = false;
  ws.pendingMessages = [];
  websocketConnections.set(wss.clients.size);
  void auth.currentUser(sessionTokenFromRequest(req)).then((user) => {
    ws.authenticatedUser = user;
    ws.authReady = true;
    const pending = ws.pendingMessages.splice(0);
    for (const data of pending) dispatchPending(ws, data);
  }).catch((error) => {
    logger.warn('WebSocket authentication lookup failed', { error });
    ws.authReady = true;
    const pending = ws.pendingMessages.splice(0);
    for (const data of pending) dispatchPending(ws, data);
  });
  ws.on('message', (raw, isBinary) => {
    const byteLength = Buffer.byteLength(raw);
    const maxBytes = isBinary ? MEDIA_RELAY_MAX_FRAME_BYTES : MAX_PAYLOAD_BYTES;
    if (byteLength > maxBytes) return sendError(ws, isBinary ? 'Media relay frame too large.' : 'Message too large.');
    if (isBinary) {
      if (!checkBinaryFrameRate(ws)) return sendError(ws, 'You are sending binary audio frames too quickly.');
      const data = Buffer.from(raw);
      if (!ws.authReady) {
        if (ws.pendingMessages.length >= 8) return sendError(ws, 'Authentication is still loading; try again.');
        ws.pendingMessages.push({ binary: true, data });
        return;
      }
      return dispatchBinaryFrame(ws, data);
    }
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      return sendError(ws, `Invalid message: ${error.message}`);
    }
    if (!checkJsonMessageRate(ws)) return sendError(ws, 'You are sending messages too quickly.');
    if (!ws.authReady) {
      if (ws.pendingMessages.length >= 8) return sendError(ws, 'Authentication is still loading; try again.');
      ws.pendingMessages.push({ binary: false, data });
      return;
    }
    dispatchMessage(ws, data);
  });
  ws.on('close', () => { websocketConnections.set(Math.max(0, wss.clients.size)); handleDisconnect(ws); });
  ws.on('error', () => { websocketConnections.set(Math.max(0, wss.clients.size)); handleDisconnect(ws); });
});

function shutdown(signal) {
  health.setReady(false);
  audit.record({ type: 'server.shutdown', severity: 'info', metadata: { signal, rooms: rooms.size } });
  logger.info('Shutting down RoomSound', { signal, rooms: rooms.size });
  for (const room of rooms.values()) {
    if (room.hostFailoverTimer) clearTimeout(room.hostFailoverTimer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  }
  wss.close(() => server.close(async () => {
    await repository.close().catch((error) => console.error('Repository shutdown failed:', error.message));
    process.exit(0);
  }));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await restorePersistedRooms();
  server.listen(port, host, () => {
    health.setReady(true);
    audit.record({ type: 'server.ready', severity: 'info', metadata: { repository: repository.kind, roomAuthRequired } });
    logger.info('RoomSound is ready', {
      host,
      port,
      repository: repository.kind,
      roomAuthRequired,
      turnConfigured: TURN_URLS.length > 0,
    });
    for (const address of lanAddresses()) logger.info('RoomSound LAN address', { address, port });
  });
} catch (error) {
  logger.error('Room directory restore failed', { error });
  await repository.close().catch(() => {});
  process.exitCode = 1;
}
