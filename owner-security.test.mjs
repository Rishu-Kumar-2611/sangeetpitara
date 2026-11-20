import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAuthService, verifyPassword } from './auth.mjs';
import { InMemoryRepository } from './persistence.mjs';
import { createOwnerAdmin, totp } from './owner-admin.mjs';
import { createUsageAnalytics } from './usage-analytics.mjs';

const origin = 'https://app.example.test';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC test vector, never a deployment key.
async function fixture() {
  let time = Date.UTC(2026, 10, 20);
  const repository = new InMemoryRepository({ clock: () => new Date(time) });
  const auth = createAuthService({ repository, now: () => new Date(time) });
  const owner = await auth.register({ email: 'owner@example.test', password: 'Existing owner password 2026' });
  repository.usersById.get(owner.user.id).isAdmin = true;
  const events = [];
  const handle = createOwnerAdmin({ auth, repository, analytics: createUsageAnalytics({ repository, now: () => time }),
    now: () => time, live: () => ({}), env: { ADMIN_OWNER_ID: owner.user.id, ADMIN_TOTP_SECRET: secret, ALLOWED_ORIGINS: origin },
    sendJson: (res, status, body, headers = {}) => Object.assign(res, { status, body, headers: { ...res.headers, ...headers } }),
    audit: { record: event => events.push(event) }, logger: { error() {} }, ip: () => 'test-ip' });
  const request = async (path, { body, cookie, requestOrigin = origin } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(raw ? [Buffer.from(raw)] : []);
    req.method = body === undefined ? 'GET' : 'POST';
    req.headers = { origin: requestOrigin, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) };
    const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; } };
    await handle(req, res, path, new URLSearchParams()); return res;
  };
  const code = () => totp(secret, Math.floor(time / 30000));
  const login = async factor => request('/api/admin/login', { body: { email: owner.user.email,
    password: 'Existing owner password 2026', code: factor || code() } });
  return { repository, auth, owner, request, login, handle, code, events, advance: () => { time += 30000; } };
}

test('password change requires fresh MFA and invalidates owner cookies, account sessions, and recovery codes', async () => {
  const f = await fixture();
  const login = await f.login(); const cookie = login.headers['Set-Cookie'].split(';')[0];
  const body = { currentPassword: 'Existing owner password 2026', newPassword: 'New unique owner password 2026', code: f.code() };
  assert.equal((await f.request('/api/admin/password', { body, cookie })).status, 401, 'Login MFA code cannot be reused');
  f.advance(); body.code = f.code();
  assert.equal((await f.request('/api/admin/password', { body, cookie, requestOrigin: 'https://evil.test' })).status, 403);
  const changed = await f.request('/api/admin/password', { body, cookie });
  assert.equal(changed.status, 200); assert.equal(changed.body.signedOut, true);
  assert.equal((await f.request('/api/admin/session', { cookie })).status, 401);
  assert.equal(await f.auth.currentUser(f.owner.token), null);
  const stored = await f.repository.findUserById(f.owner.user.id);
  assert.ok(await verifyPassword(body.newPassword, stored.passwordHash));
  assert.equal(await verifyPassword(body.currentPassword, stored.passwordHash), false);
  assert.doesNotMatch(JSON.stringify(f.events), /Existing owner|New unique|code_hash|passwordHash/);
});

test('recovery codes are returned once, stored hashed, and consumed atomically on login', async () => {
  const f = await fixture(); const login = await f.login(); const cookie = login.headers['Set-Cookie'].split(';')[0];
  f.advance();
  const result = await f.request('/api/admin/recovery-codes', { cookie, body: { currentPassword: 'Existing owner password 2026', code: f.code() } });
  assert.equal(result.status, 200); assert.equal(new Set(result.body.codes).size, 8);
  const recovery = result.body.codes[0];
  assert.doesNotMatch(JSON.stringify([...f.repository.adminRecoveryCodes.values()].map(set => [...set])), new RegExp(recovery.replaceAll('-', '')));
  assert.equal((await f.login(recovery)).status, 200);
  assert.equal((await f.login(recovery)).status, 401);
  assert.equal(await f.repository.countAdminRecoveryCodes(f.owner.user.id), 7);
  const session = await f.request('/api/admin/session', { cookie });
  assert.equal(session.body.recoveryCodesRemaining, 7);
  assert.equal(JSON.stringify(session.body).includes(recovery), false);
});

test('ordinary admin cookies cannot satisfy MFA authorization and sign-out-everywhere revokes all sessions', async () => {
  const f = await fixture();
  assert.equal(await f.handle.authorize({ method: 'POST', headers: { origin, cookie: `roomsound_session=${f.owner.token}` } }), null);
  const login = await f.login(); const cookie = login.headers['Set-Cookie'].split(';')[0];
  assert.ok(await f.handle.authorize({ method: 'POST', headers: { origin, cookie } }));
  assert.equal(await f.handle.authorize({ method: 'POST', headers: { origin: 'https://evil.test', cookie } }), null);
  f.advance();
  assert.equal((await f.request('/api/admin/sessions/revoke', { cookie, body: { currentPassword: 'Existing owner password 2026', code: f.code() } })).status, 200);
  assert.equal((await f.request('/api/admin/session', { cookie })).status, 401);
  assert.equal(await f.auth.currentUser(f.owner.token), null);
});

test('a password verification started before a reset cannot issue a session for the old credential', async () => {
  const f = await fixture();
  const old = await f.repository.findUserById(f.owner.user.id);
  await f.auth.changePassword(f.owner.user.id, { currentPassword: 'Existing owner password 2026', newPassword: 'A replacement password 2026' });
  assert.equal(await f.repository.createSession({ tokenHash: 'a'.repeat(64), userId: old.id,
    expectedPasswordHash: old.passwordHash, expiresAt: '2030-01-01T00:00:00Z' }), null);
});
