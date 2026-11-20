// Run after docker build -f Dockerfile.runtime -t sangeetpitara:production-check .
// All containers/networks are disposable and ports are bound to loopback only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const id = `sp-check-${randomBytes(6).toString('hex')}`;
const database = `${id}-db`;
const app = `${id}-app`;
const password = randomBytes(24).toString('hex');
const image = process.env.TEST_APP_IMAGE || 'sangeetpitara:production-check';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let networkCreated = false;
let databaseStarted = false;
let appStarted = false;
const keepAlive = setInterval(() => {}, 1000);
try {
  assert.throws(() => docker(['run', '--rm', image]), /Command failed/,
    'Production image must refuse startup with missing required configuration');
  docker(['network', 'create', id]); networkCreated = true;
  docker(['run', '-d', '--rm', '--name', database, '--network', id,
    '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine']); databaseStarted = true;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', database, 'pg_isready', '-U', 'postgres']); break; }
    catch (error) { if (i === 59) throw error; await delay(500); }
  }
  docker(['run', '-d', '--rm', '--name', app, '--network', id, '-p', '127.0.0.1::4173',
    '-e', `DATABASE_URL=postgres://postgres:${password}@${database}:5432/postgres`,
    '-e', 'DATABASE_SSL=0', '-e', 'ALLOWED_ORIGINS=https://app.example.test',
    '-e', 'SESSION_COOKIE_SECURE=1', '-e', 'TRUST_PROXY=1',
    '-e', `METRICS_BEARER_TOKEN=${randomBytes(32).toString('hex')}`, image]); appStarted = true;
  const port = docker(['port', app, '4173/tcp']).split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const readinessDeadline = Date.now() + 30_000;
  for (let i = 0; i < 100 && Date.now() < readinessDeadline; i++) {
    try {
      const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { assert.equal((await response.json()).checks.repository.kind, 'postgres'); ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.equal(ready, true, 'Packaged production runtime must reach PostgreSQL-backed readiness');
  assert.equal((await fetch(`${base}/auth.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/audio-diagnostics.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/client-address.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/ops/database-backup.mjs`)).status, 404);
  const registration = await fetch(`${base}/api/auth/register`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'container@example.test', password: 'Container-only-test-password-2026' }) });
  assert.equal(registration.status, 403, 'Public account registration must be disabled by default');
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  console.log('CONTAINER PASS: fail-closed startup, PostgreSQL readiness, protected metrics/source, assets and restricted account registration.');
} finally {
  clearInterval(keepAlive);
  if (appStarted) docker(['rm', '-f', app]);
  if (databaseStarted) docker(['rm', '-f', database]);
  if (networkCreated) docker(['network', 'rm', id]);
}
