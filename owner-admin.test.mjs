import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createOwnerAdmin, totp, matchTotp } from './owner-admin.mjs';
import { InMemoryRepository } from './persistence.mjs';
import { createUsageAnalytics } from './usage-analytics.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('TOTP matches RFC 6238 vectors, rejects malformed codes and limits clock skew', () => {
  for (const [time, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(totp(secret, Math.floor(time / 30)), code);
    assert.equal(matchTotp(secret, code, time * 1000), Math.floor(time / 30));
  }
  assert.equal(matchTotp(secret, '123', 59000), null);
  assert.equal(matchTotp(secret, '287082', 180000), null);
});

function fixture(env = {}) {
  let time = 1_800_000;
  let current = { id: 'owner', isAdmin: true };
  let loggedOut = 0;
  const repository = new InMemoryRepository();
  const analytics = createUsageAnalytics({ repository, now: () => time });
  const handle = createOwnerAdmin({
    auth: { login: async body => { if (body.password !== 'valid-password') throw new Error('bad'); return { token: 'server-side-token', user: current }; }, currentUser: async () => current, logout: async () => { loggedOut++; } },
    repository, analytics, now: () => time,
    live: () => ({ users: 0, rooms: 0 }),
    env: { ADMIN_OWNER_ID: 'owner', ADMIN_TOTP_SECRET: secret, ALLOWED_ORIGINS: 'https://example.com', SESSION_COOKIE_SECURE: '1', ...env },
    sendJson: (res, status, body, headers = {}) => { res.status = status; res.body = body; Object.assign(res.headers, headers); },
    audit: { record() {} }, logger: { error() {} }, ip: req => req.address || 'ip1',
  });
  async function request(path, { method = 'GET', body, origin = 'https://example.com', cookie, address = 'ip1' } = {}) {
    const raw = body ? JSON.stringify(body) : '';
    const req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = method; req.address = address;
    req.headers = { host: 'example.com', origin, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    const [route, query = ''] = path.split('?');
    await handle(req, res, route, new URLSearchParams(query));
    return res;
  }
  return { request, setUser: value => { current = value; }, advance: value => { time += value; }, code: () => totp(secret, Math.floor(time / 30000)), get loggedOut() { return loggedOut; } };
}

test('owner analytics fail closed when configuration or authentication is missing', async () => {
  assert.equal((await fixture({ ADMIN_TOTP_SECRET: '' }).request('/api/admin/analytics')).status, 503);
  assert.equal((await fixture().request('/api/admin/analytics')).status, 401);
});

test('owner sign-in requires exact owner role, valid password, fresh TOTP and same origin', async () => {
  const f = fixture();
  const login = extra => f.request('/api/admin/login', { method: 'POST', body: { email: 'owner@example.com', password: 'valid-password', code: f.code() }, ...extra });
  assert.equal((await login({ origin: 'https://evil.com' })).status, 403);
  assert.equal((await login({ origin: '' })).status, 403);
  assert.equal((await login()).status, 200);
  f.advance(30000);
  f.setUser({ id: 'attacker', isAdmin: true }); assert.equal((await login()).status, 401);
  f.setUser({ id: 'owner', isAdmin: false }); assert.equal((await login()).status, 401);
  f.setUser({ id: 'owner', isAdmin: true });
  assert.equal((await login({ body: { email: 'owner@example.com', password: 'wrong', code: f.code() } })).status, 401);
  assert.equal((await login({ body: { email: 'owner@example.com', password: 'valid-password', code: 'bad' } })).status, 401);
  assert.equal((await login()).status, 429);
});

test('MFA cookie is HttpOnly, strict, scoped; replay, revocation, expiry and logout are enforced', async () => {
  const f = fixture();
  const body = { email: 'owner@example.com', password: 'valid-password', code: f.code() };
  const signed = await f.request('/api/admin/login', { method: 'POST', body });
  assert.equal(signed.status, 200);
  const cookie = signed.headers['Set-Cookie'].split(';')[0];
  assert.match(signed.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Secure/);
  assert.match(signed.headers['Set-Cookie'], /Path=\/api\/admin/);
  assert.doesNotMatch(JSON.stringify(signed.body), /token|secret|password/);
  assert.equal((await f.request('/api/admin/login', { method: 'POST', body })).status, 401);
  const summary = await f.request('/api/admin/analytics?days=7', { cookie });
  assert.equal(summary.status, 200); assert.equal(summary.body.days, 7);
  assert.equal(summary.headers['Cache-Control'], 'no-store');
  assert.equal((await f.request('/api/admin/analytics?days=9000', { cookie })).status, 400);
  f.setUser({ id: 'owner', isAdmin: false });
  assert.equal((await f.request('/api/admin/analytics', { cookie })).status, 401);
  f.setUser({ id: 'owner', isAdmin: true }); f.advance(30000);
  const next = await f.request('/api/admin/login', { method: 'POST', body: { ...body, code: f.code() } });
  const nextCookie = next.headers['Set-Cookie'].split(';')[0];
  f.advance(15 * 60000 + 1);
  assert.equal((await f.request('/api/admin/session', { cookie: nextCookie })).status, 401);
  const third = await f.request('/api/admin/login', { method: 'POST', body: { ...body, code: f.code() } });
  const thirdCookie = third.headers['Set-Cookie'].split(';')[0];
  assert.equal((await f.request('/api/admin/logout', { method: 'POST', cookie: thirdCookie, body: {} })).status, 200);
  assert.equal((await f.request('/api/admin/session', { cookie: thirdCookie })).status, 401);
});
