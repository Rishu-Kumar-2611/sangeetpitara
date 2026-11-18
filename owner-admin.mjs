import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readJsonBody } from './security.mjs';

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
  const cookie = (value, age) => `${COOKIE}=${value}; Path=/api/admin; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  function token(req) { return String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || ''; }
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
    if (!session || now() > session.expires || now() - session.seen > 15 * 60_000) { sessions.delete(key); return null; }
    const user = await auth.currentUser(session.authToken);
    if (!user?.isAdmin || user.id !== ownerId) { sessions.delete(key); return null; }
    session.seen = now();
    return user;
  }
  return async function handle(req, res, path, search) {
    if (!['/api/admin/login', '/api/admin/logout', '/api/admin/session', '/api/admin/analytics'].includes(path)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    if (!enabled) { sendJson(res, 503, { error: 'Owner dashboard has not been configured.' }); return true; }
    const method = ['/api/admin/login', '/api/admin/logout'].includes(path) ? 'POST' : 'GET';
    if (req.method !== method) { sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: method }); return true; }
    if ((method === 'POST' && !allowedOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { error: 'Same-origin access required.' }); return true; }
    try {
      if (path === '/api/admin/login') {
        if (limited(ip(req))) { sendJson(res, 429, { error: 'Too many attempts. Retry in 15 minutes.' }, { 'Retry-After': '900' }); return true; }
        const body = await readJsonBody(req, { maxBytes: 4096, requireJsonContentType: true });
        let result;
        try { result = await auth.login({ email: body.email, password: body.password }); }
        catch { audit.record({ type: 'auth.login.failed', severity: 'warn', metadata: { surface: 'owner' } }); sendJson(res, 401, { error: 'Invalid owner credentials or authenticator code.' }); return true; }
        const step = matchTotp(secret, String(body.code || ''), now());
        if (!result.user.isAdmin || result.user.id !== ownerId || step === null || !await repository.consumeAdminTotp(ownerId, step)) {
          await auth.logout(result.token);
          audit.record({ type: 'auth.login.failed', severity: 'warn', metadata: { surface: 'owner' } });
          sendJson(res, 401, { error: 'Invalid owner credentials or authenticator code.' }); return true;
        }
        for (const [key, session] of sessions) if (session.expires < now()) { sessions.delete(key); await auth.logout(session.authToken); }
        if (sessions.size >= 4) { const [key, session] = sessions.entries().next().value; sessions.delete(key); await auth.logout(session.authToken); }
        const value = randomBytes(32).toString('base64url');
        sessions.set(sha(value), { authToken: result.token, expires: now() + 60 * 60_000, seen: now() });
        audit.record({ type: 'auth.login.succeeded', actorId: ownerId, severity: 'info', metadata: { surface: 'owner', mfa: true } });
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(value, 3600) }); return true;
      }
      const user = await sessionUser(req);
      if (!user) { sendJson(res, 401, { error: 'Owner sign-in required.' }, { 'Set-Cookie': cookie('', 0) }); return true; }
      if (path === '/api/admin/logout') {
        const key = sha(token(req));
        await auth.logout(sessions.get(key).authToken); sessions.delete(key);
        audit.record({ type: 'auth.logout', actorId: user.id, severity: 'info', metadata: { surface: 'owner' } });
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return true;
      }
      if (path === '/api/admin/session') { sendJson(res, 200, { ok: true }); return true; }
      const days = Number(search.get('days') || 30);
      if (![7, 30, 90].includes(days)) { sendJson(res, 400, { error: 'Choose 7, 30 or 90 days.' }); return true; }
      await analytics.flush();
      const since = new Date(now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const summary = await repository.usageSummary(since);
      audit.record({ type: 'custom.admin.analytics_read', actorId: user.id, severity: 'info' });
      sendJson(res, 200, { ...summary, live: live(), days, since, updatedAt: new Date(now()).toISOString(), durable: repository.kind === 'postgres' });
      return true;
    } catch (error) {
      logger.error('Owner dashboard request failed', { route: path });
      sendJson(res, error.status || 503, { error: error.status === 413 ? 'Request too large.' : 'Owner service unavailable. Retry shortly.' }); return true;
    }
  };
}
