// Uses a disposable Docker database unless TEST_DATABASE_URL explicitly selects
// a disposable CI database. Never point this check at production data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

async function start(databaseUrl) {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const output = [];
  server = spawn(process.execPath, ['server.mjs'], { cwd, env: {
    ...process.env, NODE_ENV: 'production', ROOMSOUND_TEST_MODE: '',
    HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: databaseUrl,
    DATABASE_SSL: '0', ALLOWED_ORIGINS: 'https://app.example.test',
    TRUST_PROXY: '1', SESSION_COOKIE_SECURE: '1',
    CANONICAL_PUBLIC_HOST: '', ADMIN_EMAILS: 'operator@example.test',
    METRICS_BEARER_TOKEN: randomBytes(32).toString('hex'),
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

async function post(base, path, body, cookie) {
  return fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}),
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
  let base = await start(databaseUrl);
  const login = await post(base, '/api/auth/login', { email: operator.user.email, password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post(base, '/api/moderation/bans', {}, cookie)).status, 403,
    'An existing unverified allowlisted email must not gain privileges');
  await repository.pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [operator.user.id]);
  assert.equal((await post(base, `/api/admin/accounts/${victim.user.id}/revoke`, {}, cookie)).status, 200);
  assert.equal((await post(base, '/api/auth/login', { email: victim.user.email, password })).status, 401);
  const guest = await room(base, { type: 'create-room', name: 'Ephemeral guest room', displayName: 'Guest', guestId: 'integration-guest' });
  assert.equal(guest.type, 'joined');
  await stop();
  base = await start(databaseUrl);
  const stored = await repository.pool.query('SELECT status FROM rooms WHERE id = $1', [guest.state.room.id]);
  assert.equal(stored.rows[0].status, 'ENDED');
  assert.equal((await room(base, { type: 'join-room', code: guest.state.room.code, displayName: 'Returning guest', guestId: 'integration-guest', reconnectSecret: guest.reconnectSecret })).type, 'error');
  assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).status, 200,
    'Database session survives the server restart');
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
