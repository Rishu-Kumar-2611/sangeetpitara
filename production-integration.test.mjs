import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), REQUIRE_AUTH: '1', SESSION_COOKIE_SECURE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const http = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${http}/ready`);
      if (response.ok) return { server, http, ws: `ws://127.0.0.1:${port}` };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error(`RoomSound server did not start: ${output.join('')}`);
}

function socket(url, headers = {}) {
  const instance = new WebSocket(url, { headers });
  const messages = [];
  return {
    instance,
    open: () => new Promise((resolve, reject) => {
      instance.once('open', resolve);
      instance.once('error', reject);
    }),
    wait(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 5_000);
        const listener = (raw) => {
          const message = JSON.parse(raw.toString());
          messages.push(message);
          if (!predicate(message)) return;
          clearTimeout(timer);
          instance.off('message', listener);
          resolve(message);
        };
        instance.on('message', listener);
      });
    },
  };
}

test('production auth is required for WebSocket room entry and readiness is observable', async (t) => {
  const running = await startServer();
  t.after(() => running.server.kill());

  const config = await fetch(`${running.http}/config`).then((response) => response.json());
  assert.equal(config.authRequired, true);

  const readiness = await fetch(`${running.http}/ready`);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).status, 'ready');

  const metrics = await fetch(`${running.http}/metrics`).then((response) => response.text());
  assert.match(metrics, /roomsound_http_requests_total/);

  const anonymous = socket(running.ws);
  t.after(() => anonymous.instance.close());
  await anonymous.open();
  anonymous.instance.send(JSON.stringify({ type: 'create-room', name: 'Blocked', displayName: 'Guest', guestId: 'guest' }));
  const denied = await anonymous.wait((message) => message.type === 'error');
  assert.match(denied.message, /sign in/i);

  const registration = await fetch(`${running.http}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get('set-cookie');
  assert.match(cookie, /roomsound_session=/);

  const authenticated = socket(running.ws, { Cookie: cookie.split(';', 1)[0] });
  t.after(() => authenticated.instance.close());
  await authenticated.open();
  authenticated.instance.send(JSON.stringify({ type: 'create-room', name: 'Private', displayName: 'Owner', guestId: 'ignored' }));
  const joined = await authenticated.wait((message) => message.type === 'joined');
  assert.equal(joined.state.room.name, 'Private');
  assert.equal(joined.state.self.name, 'Owner');
});
