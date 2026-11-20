// Uses a disposable Docker database unless TEST_DATABASE_URL explicitly selects
// a disposable CI database. Never point this check at production data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { totp } from '../owner-admin.mjs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRepositoryFromEnv } from '../persistence.mjs';
import { createAuthService } from '../auth.mjs';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const container = `sangeetpitara-integration-${randomBytes(6).toString('hex')}`;
let dockerStarted = false;
let repository;
let server;
const sockets = [];

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(databaseUrl, extraEnv = {}) {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  server = spawn(process.execPath, ['server.mjs'], { cwd, env: {
    ...process.env, NODE_ENV: 'production', ROOMSOUND_TEST_MODE: '',
    HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: databaseUrl,
    DATABASE_SSL: '0', ALLOWED_ORIGINS: 'https://app.example.test',
    TRUST_PROXY: '1', SESSION_COOKIE_SECURE: '1',
    CANONICAL_PUBLIC_HOST: '', ADMIN_EMAILS: 'operator@example.test',
    METRICS_BEARER_TOKEN: randomBytes(32).toString('hex'), ...extraEnv,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.ok) { assert.equal((await r.json()).checks.repository.kind, 'postgres'); return base; }
    } catch {}
    if (server.exitCode !== null) throw new Error(output.join(''));
    await delay(100);
  }
  throw new Error('PostgreSQL-backed server did not become ready.');
}

async function stop() {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await stopped;
}

async function room(base, message, cookie) {
  const socket = new WebSocket(base, { headers: cookie ? { Cookie: cookie } : {} });
  sockets.push(socket);
  const answer = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Room command timed out')), 5000);
    socket.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'joined' || event.type === 'error') { clearTimeout(timeout); resolve(event); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify(message));
  return answer;
}

async function post(base, path, body, cookie, extraHeaders = {}) {
  return fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders,
  }, body: JSON.stringify(body || {}) });
}

try {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    const password = randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '-d', '--rm', '--name', container,
      '-e', `POSTGRES_PASSWORD=${password}`, '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: ['ignore', 'pipe', 'inherit'] });
    dockerStarted = true;
    const mapping = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim();
    databaseUrl = `postgres://postgres:${password}@127.0.0.1:${mapping.split(':').at(-1)}/postgres`;
  }
  for (let i = 0; i < 60; i++) {
    try { repository = await createRepositoryFromEnv({ DATABASE_URL: databaseUrl, DATABASE_SSL: '0' }); break; }
    catch (error) { if (i === 59) throw error; await delay(1000); }
  }
  assert.equal(repository.kind, 'postgres');
  const auth = createAuthService({ repository });
  const password = 'Synthetic integration password 2026';
  const operator = await auth.register({ email: 'operator@example.test', password });
  const victim = await auth.register({ email: 'victim@example.test', password });
  const ownerSecret = Array.from(randomBytes(32), byte => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[byte % 32]).join('');
  const batch = { id: randomUUID(), rows: [{ day: '2000-01-01', visitor: 'a'.repeat(64), platform: 'android', onlineMs: 1000, listeningMs: 500, sessions: 1, roomsCreated: 1, reconnects: 0, forwarded: 25, dropped: 1 }] };
  await repository.writeUsageBatch(batch);
  await repository.writeUsageBatch(batch);
  let summary = await repository.usageSummary('2000-01-01');
  assert.equal(summary.totals.onlineMs, 1000, 'Committed batch retries must not double count');
  assert.equal(summary.totals.listeningMs, 500);
  assert.equal(summary.totals.users, 1);
  assert.equal(summary.daily[0].day, '2000-01-01');
  assert.equal(summary.platforms[0].platform, 'android');
  await repository.writeUsageBatch({ id: randomUUID(), rows: [{ ...batch.rows[0], onlineMs: 500, listeningMs: 250, sessions: 0, roomsCreated: 0 }] });
  summary = await repository.usageSummary('2000-01-01');
  assert.equal(summary.lifetime.onlineMs, 1500);
  assert.equal(summary.lifetime.listeningMs, 750);
  assert.equal(summary.lifetime.users, 1);
  let base = await start(databaseUrl, { ADMIN_OWNER_ID: operator.user.id, ADMIN_TOTP_SECRET: ownerSecret });
  const login = await post(base, '/api/auth/login', { email: operator.user.email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(base, '/api/moderation/bans', {}, cookie)).status, 403,
    'An existing unverified allowlisted email must not gain privileges');
  await repository.pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [operator.user.id]);
  assert.deepEqual((await Promise.all([repository.consumeAdminTotp(operator.user.id, 42), repository.consumeAdminTotp(operator.user.id, 42)])).sort(), [false, true]);
  assert.equal(await repository.consumeAdminTotp(operator.user.id, 43), true);
  assert.equal(await repository.consumeAdminTotp(operator.user.id, 41), false);
  assert.equal(await repository.consumeAdminTotp(victim.user.id, 44), false);
  assert.equal((await fetch(base + '/api/admin/analytics')).status, 401);
  assert.equal((await fetch(base + '/api/admin/analytics', { headers: { Cookie: cookie } })).status, 401, 'An ordinary admin account cookie must not bypass MFA');
  const credentials = { email: operator.user.email, password, code: totp(ownerSecret, Math.floor(Date.now() / 30000)) };
  const ownerLogin = await post(base, '/api/admin/login', credentials, null, { Origin: 'https://app.example.test' });
  assert.equal(ownerLogin.status, 200, 'Provisioned owner must be able to complete password + MFA sign-in');
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
  const analyticsResponse = await fetch(base + '/api/admin/analytics?days=7', { headers: { Cookie: ownerCookie } });
  assert.equal(analyticsResponse.status, 200);
  assert.equal(analyticsResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await analyticsResponse.json()).lifetime.listeningMs, 750);
  assert.equal((await post(base, '/api/admin/login', credentials, null, { Origin: 'https://app.example.test' })).status, 401, 'Consumed authenticator codes cannot be replayed');
  assert.equal((await post(base, `/api/admin/accounts/${victim.user.id}/revoke`, {}, cookie)).status, 403,
    'A password-only admin cookie must not authorize privileged actions');
  assert.equal((await post(base, `/api/admin/accounts/${victim.user.id}/revoke`, {}, ownerCookie, { Origin: 'https://app.example.test' })).status, 200);
  assert.equal((await post(base, '/api/admin/logout', {}, ownerCookie, { Origin: 'https://app.example.test' })).status, 200);
  assert.equal((await fetch(base + '/api/admin/session', { headers: { Cookie: ownerCookie } })).status, 401);
  console.log('OWNER ANALYTICS PASS: database aggregation, idempotent batches, atomic TOTP replay protection, MFA login and logout.');
  assert.equal((await post(base, '/api/auth/login', { email: victim.user.email, password })).status, 401);
  const guest = await room(base, { type: 'create-room', name: 'Recoverable guest room', displayName: 'Guest', guestId: 'integration-guest' });
  assert.equal(guest.type, 'joined');
  assert.match(guest.state.room.code, /^[A-HJ-NP-Z2-9]{8}$/, 'New rooms persist 8-character codes');
  const hostSocket = sockets.at(-1);
  const rotated = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Room code rotation timed out')), 5000);
    hostSocket.on('message', (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === 'state' && event.state.room.code !== guest.state.room.code) { clearTimeout(timeout); resolve(event.state.room.code); }
    });
  });
  hostSocket.send(JSON.stringify({ type: 'rotate-room-code' }));
  const rotatedCode = await rotated;
  const persistedCode = await repository.pool.query('SELECT code FROM rooms WHERE id = $1', [guest.state.room.id]);
  assert.equal(persistedCode.rows[0].code, rotatedCode, 'A replaced room code is persisted');
  await stop();
  base = await start(databaseUrl);
  const stored = await repository.pool.query('SELECT status FROM rooms WHERE id = $1', [guest.state.room.id]);
  assert.equal(stored.rows[0].status, 'ACTIVE');
  const forged = await room(base, { type: 'join-room', code: rotatedCode, displayName: 'Impostor', guestId: 'integration-guest', reconnectSecret: 'x'.repeat(43) });
  assert.equal(forged.type, 'error');
  const restoredGuest = await room(base, { type: 'join-room', code: guest.state.room.code, displayName: 'Returning guest', guestId: 'integration-guest', reconnectSecret: guest.reconnectSecret });
  assert.equal(restoredGuest.type, 'joined'); assert.equal(restoredGuest.state.self.role, 'HOST');
  assert.equal(restoredGuest.state.self.id, guest.state.self.id); assert.equal(restoredGuest.state.room.code, rotatedCode);
  assert.equal(restoredGuest.state.room.recovered, true);
  const recoveryRecord = await repository.pool.query('SELECT recovery_state FROM rooms WHERE id=$1', [guest.state.room.id]);
  assert.ok(!JSON.stringify(recoveryRecord.rows).includes(guest.reconnectSecret), 'Only capability digests may be persisted');
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200,
    'Database session survives the server restart');
  const billingRecord = { subjectId: operator.user.id, provider: 'stripe', customerId: 'cus_test', subscriptionId: 'sub_test',
    priceId: 'price_test', plan: 'pro', status: 'active', currentPeriodEnd: null, cancelAtPeriodEnd: false, updatedAt: '2026-11-20T00:00:00Z' };
  assert.equal(await repository.applyBillingEvent('stripe', 'evt_atomic_test', billingRecord), true);
  assert.equal(await repository.applyBillingEvent('stripe', 'evt_atomic_test', billingRecord), false);
  await repository.applyBillingEvent('stripe', 'evt_cancel_test', { ...billingRecord, status: 'canceled', updatedAt: '2026-11-20T00:01:00Z' });
  await repository.applyBillingEvent('stripe', 'evt_stale_test', billingRecord);
  assert.equal((await repository.getEntitlement(operator.user.id)).status, 'canceled', 'Late events must not resurrect a canceled entitlement');
  await assert.rejects(repository.applyBillingEvent('stripe', 'evt_rollback_test', { ...billingRecord, plan: null }));
  assert.equal(await repository.applyBillingEvent('stripe', 'evt_rollback_test', billingRecord), true,
    'An entitlement failure must roll back the receipt so the event can be retried');
  const recoveryHash = 'b'.repeat(64);
  await repository.replaceAdminRecoveryCodes(operator.user.id, [recoveryHash]);
  assert.deepEqual((await Promise.all([repository.consumeAdminRecoveryCode(operator.user.id, recoveryHash), repository.consumeAdminRecoveryCode(operator.user.id, recoveryHash)])).sort(), [false, true]);
  await auth.changePassword(operator.user.id, { currentPassword: password, newPassword: 'Updated synthetic owner password 2026' });
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 401, 'A password reset must revoke old durable sessions');
  console.log('RECOVERY AND BILLING PASS: restart capabilities, rejected impersonation, atomic billing retries, event order, one-time codes and password revocation.');
  if (dockerStarted) {
    execFileSync('docker', ['stop', container], {stdio:'ignore'});
    await delay(500);
    assert.equal((await fetch(`${base}/health`)).status,200,'Database outage must not crash the server');
    assert.equal((await fetch(`${base}/ready`)).status,503,'Database outage must fail readiness');
    const interrupted = new WebSocket(base.replace('http','ws'),{headers:{Cookie:cookie}});sockets.push(interrupted);
    const closed = new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Database outage authentication did not close')),12000);interrupted.on('error',()=>{});interrupted.once('close',code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(await closed,1013,'Authentication lookup failure must not fall back to guest privileges');
    assert.equal((await fetch(`${base}/health`)).status,200);
    console.log('POSTGRES OUTAGE PASS: server stays alive, readiness fails, and authentication closes safely.');
  }
  console.log('POSTGRES PASS: real migrations, explicit admin roles, revocation, durable sessions, and safe guest-room restart.');
} finally {
  await stop();
  await repository?.close();
  if (dockerStarted) { try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch {} }
}
