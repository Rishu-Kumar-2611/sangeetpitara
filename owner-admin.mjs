import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJsonBody } from './security.mjs';
import { validatePassword } from './auth.mjs';

const COOKIE = 'sangeetpitara_admin';
const sha = value => createHash('sha256').update(value).digest('hex');

function decodeBase32(value) {
  if (!/^[A-Z2-7]{32,128}$/.test(value)) throw new Error('Invalid authenticator secret.');
  let bits = 0, accumulator = 0;
  const bytes = [];
  for (const char of value) {
    accumulator = (accumulator << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}

export function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function matchTotp(secret, code, time) {
  code = String(code);
  if (!/^\d{6}$/.test(String(code))) return null;
  const current = Math.floor(time / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** Separate, short-lived owner sessions; never ships secrets in the browser bundle. */
export function createOwnerAdmin({ auth, repository, analytics, live, sendJson, audit, logger, ip, env = process.env, now = Date.now }) {
  const ownerId = String(env.ADMIN_OWNER_ID || '').trim();
  const secret = String(env.ADMIN_TOTP_SECRET || '').trim().toUpperCase();
  let enabled = Boolean(ownerId);
  try { decodeBase32(secret); } catch { enabled = false; }
  const secure = env.NODE_ENV === 'production' || env.SESSION_COOKIE_SECURE === '1';
  const sessions = new Map();
  const attempts = new Map();
  const cookie = (value, age, path = '/api') => `${COOKIE}=${value}; Path=${path}; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const clearedCookies = () => [cookie('', 0), cookie('', 0, '/api/admin')];
  function token(req) {
    const values = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${COOKIE}=`)).map(value => value.slice(COOKIE.length + 1));
    return values.find(value => sessions.has(sha(value))) || '';
  }
  function allowedOrigin(req) {
    const origin = req.headers.origin;
    const origins = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (env.NODE_ENV !== 'production' && !origins.length) origins.push(`http://${req.headers.host}`);
    return typeof origin === 'string' && origins.includes(origin);
  }
  function limited(key) {
    const time = now();
    for (const [address, entry] of attempts) if (entry.expires <= time) attempts.delete(address);
    const entry = attempts.get(key) || { count: 0, expires: time + 15 * 60_000 };
    if (attempts.size >= 5000 && !attempts.has(key)) return true;
    attempts.set(key, entry);
    return ++entry.count > 5;
  }
  async function sessionUser(req) {
    const key = sha(token(req));
    const session = sessions.get(key);
    if (!session) return null;
    if (now() > session.expires || now() - session.seen > 15 * 60_000) {
      sessions.delete(key); await auth.logout(session.authToken); return null;
    }
    const user = await auth.currentUser(session.authToken);
    if (!user?.isAdmin || user.id !== ownerId) { sessions.delete(key); return null; }
    session.seen = now();
    return user;
  }
  async function authorize(req) {
    if (!enabled || req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.method !== 'GET' && req.method !== 'HEAD' && !allowedOrigin(req))) return null;
    return sessionUser(req);
  }
  async function consumeFactor(code) {
    const step = matchTotp(secret, String(code || ''), now());
    if (step !== null) return repository.consumeAdminTotp(ownerId, step);
    const recovery = String(code || '').replace(/[\s-]/g, '').toLowerCase();
    return /^[a-f0-9]{32}$/.test(recovery) && await repository.consumeAdminRecoveryCode(ownerId, sha(recovery));
  }
  async function clearSessions() {
    const old = [...sessions.values()]; sessions.clear();
    await repository.deleteSessionsForUser(ownerId);
    await Promise.allSettled(old.map(session => auth.logout(session.authToken)));
  }
  const securityRoutes = ['/api/admin/password', '/api/admin/recovery-codes', '/api/admin/sessions/revoke'];
  const handle = async function handle(req, res, path, search) {
    const review = path.match(/^\/api\/admin\/reports\/([a-zA-Z0-9-]{1,80})\/review$/);
    if (!['/api/admin/login', '/api/admin/logout', '/api/admin/session', '/api/admin/analytics',
      '/api/admin/sessions', '/api/admin/reports', ...securityRoutes].includes(path) && !review) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    if (!enabled) { sendJson(res, 503, { error: 'Owner dashboard has not been configured.' }); return true; }
    const method = ['/api/admin/login', '/api/admin/logout', ...securityRoutes].includes(path) || review ? 'POST' : 'GET';
    if (req.method !== method) { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: method }); return true; }
    if ((method === 'POST' && !allowedOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { error: 'Same-origin access required.' }); return true; }
    try {
      if (path === '/api/admin/login') {
        if (limited(ip(req))) { sendJson(res, 429, { error: 'Too many attempts. Retry in 15 minutes.' }, { 'Retry-After': '900' }); return true; }
        const body = await readJsonBody(req, { maxBytes: 4096, requireJsonContentType: true });
        let result;
        try { result = await auth.login({ email: body.email, password: body.password }); }
        catch { audit.record({ type: 'auth.login.failed', severity: 'warn', metadata: { surface: 'owner' } }); sendJson(res, 401, { error: 'Invalid owner credentials or authenticator code.' }); return true; }
        let factorAccepted = false;
        try { factorAccepted = result.user.isAdmin && result.user.id === ownerId && await consumeFactor(body.code); }
        catch (error) { await auth.logout(result.token); throw error; }
        if (!factorAccepted) {
          await auth.logout(result.token);
          audit.record({ type: 'auth.login.failed', severity: 'warn', metadata: { surface: 'owner' } });
          sendJson(res, 401, { error: 'Invalid owner credentials or authenticator code.' }); return true;
        }
        for (const [key, session] of sessions) if (session.expires < now()) { sessions.delete(key); await auth.logout(session.authToken); }
        if (sessions.size >= 4) { const [key, session] = sessions.entries().next().value; sessions.delete(key); await auth.logout(session.authToken); }
        const value = randomBytes(32).toString('base64url');
        sessions.set(sha(value), { id: randomBytes(12).toString('hex'), authToken: result.token, created: now(), expires: now() + 60 * 60_000, seen: now() });
        audit.record({ type: 'auth.login.succeeded', actorId: ownerId, severity: 'info', metadata: { surface: 'owner', mfa: true } });
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(value, 3600) }); return true;
      }
      const user = await authorize(req);
      if (!user) { sendJson(res, 401, { error: 'Owner sign-in required.' }, { 'Set-Cookie': clearedCookies() }); return true; }
      if (path === '/api/admin/logout') {
        const key = sha(token(req));
        await auth.logout(sessions.get(key).authToken); sessions.delete(key);
        audit.record({ type: 'auth.logout', actorId: user.id, severity: 'info', metadata: { surface: 'owner' } });
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookies() }); return true;
      }
      if (path === '/api/admin/session') {
        sendJson(res, 200, { ok: true, recoveryCodesRemaining: await repository.countAdminRecoveryCodes(ownerId) }); return true;
      }
      if (path === '/api/admin/sessions') {
        const current = sha(token(req));
        sendJson(res, 200, { sessions: [...sessions.entries()].map(([key, value]) => ({
          id: value.id, current: key === current, createdAt: new Date(value.created).toISOString(),
          lastSeenAt: new Date(value.seen).toISOString(), expiresAt: new Date(value.expires).toISOString(),
        })) }); return true;
      }
      if (securityRoutes.includes(path)) {
        if (limited(`security:${ip(req)}`)) { sendJson(res, 429, { error: 'Too many attempts. Retry in 15 minutes.' }); return true; }
        const body = await readJsonBody(req, { maxBytes: 4096, requireJsonContentType: true });
        if (path === '/api/admin/password') validatePassword(body.newPassword);
        if (!await auth.verifyCurrentPassword(ownerId, body.currentPassword) || !await consumeFactor(body.code)) {
          sendJson(res, 401, { error: 'Enter your current password and a fresh authenticator or unused recovery code.' }); return true;
        }
        if (path === '/api/admin/password') {
          await auth.changePassword(ownerId, body); await clearSessions();
          audit.record({ type: 'custom.admin.password_changed', actorId: ownerId, severity: 'warn' });
          sendJson(res, 200, { ok: true, signedOut: true }, { 'Set-Cookie': clearedCookies() }); return true;
        }
        if (path === '/api/admin/sessions/revoke') {
          await clearSessions();
          audit.record({ type: 'custom.admin.sessions_revoked', actorId: ownerId, severity: 'warn' });
          sendJson(res, 200, { ok: true, signedOut: true }, { 'Set-Cookie': clearedCookies() }); return true;
        }
        const codes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex'));
        await repository.replaceAdminRecoveryCodes(ownerId, codes.map(sha));
        audit.record({ type: 'custom.admin.recovery_codes_rotated', actorId: ownerId, severity: 'warn' });
        sendJson(res, 200, { codes: codes.map(value => value.match(/.{8}/g).join('-')) }); return true;
      }
      if (path === '/api/admin/reports') {
        sendJson(res, 200, { reports: await repository.listReports({ limit: 100 }) }); return true;
      }
      if (review) {
        const body = await readJsonBody(req, { maxBytes: 4096, requireJsonContentType: true });
        if (!['IN_REVIEW', 'RESOLVED', 'DISMISSED'].includes(body.status)) {
          sendJson(res, 400, { error: 'Choose a valid review status.' }); return true;
        }
        const updated = await repository.resolveReport(review[1], body.status);
        if (!updated) { sendJson(res, 409, { error: 'Report is missing or already closed.' }); return true; }
        audit.record({ type: 'custom.admin.report_reviewed', actorId: ownerId, targetId: review[1], severity: 'info' });
        sendJson(res, 200, { ok: true }); return true;
      }
      const days = Number(search.get('days') || 30);
      if (![7, 30, 90].includes(days)) { sendJson(res, 400, { error: 'Choose 7, 30 or 90 days.' }); return true; }
      await analytics.flush();
      const since = new Date(now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const summary = await repository.usageSummary(since);
      audit.record({ type: 'custom.admin.analytics_read', actorId: user.id, severity: 'info' });
      sendJson(res, 200, { ...summary, live: live(), days, since, retentionDays: 365, analytics: analytics.status,
        updatedAt: new Date(now()).toISOString(), durable: repository.kind === 'postgres' });
      return true;
    } catch (error) {
      logger.error('Owner dashboard request failed', { route: path });
      sendJson(res, error.status || 503, { error: error.status === 413 ? 'Request too large.' :
        error.status === 400 ? error.message : 'Owner service unavailable. Retry shortly.' }); return true;
    }
  };
  handle.authorize = authorize;
  return handle;
}
