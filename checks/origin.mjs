import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(extraEnvironment = {}) {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return {
          server,
          wsUrl: `ws://127.0.0.1:${port}`,
          httpUrl: `http://127.0.0.1:${port}`,
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error('server did not become healthy');
}

function client(url, options = {}) {
  const socket = new WebSocket(url, options);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    } catch {}
  });
  return {
    socket,
    wait(predicate, timeoutMs = 3_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('WebSocket message timeout'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function open(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

console.log('=== Origin / headers test ===');
const restricted = await startServer({ ALLOWED_ORIGINS: 'https://example.com, https://allowed.test' });
try {
  const native = client(restricted.wsUrl);
  await open(native.socket);
  native.socket.send(JSON.stringify({ type: 'create-room', name: 'N', displayName: 'N', guestId: 'n1' }));
  await native.wait((message) => message.type === 'joined');
  assert(true, 'native no-Origin allowed');
  native.socket.close();

  let badRejected = false;
  const bad = new WebSocket(restricted.wsUrl, { headers: { Origin: 'https://evil.com' } });
  await new Promise((resolve) => {
    bad.on('unexpected-response', (_request, response) => {
      badRejected = response.statusCode === 403;
      response.resume();
      response.on('end', resolve);
    });
    bad.on('error', resolve);
    setTimeout(resolve, 1_800);
  });
  bad.close();
  assert(badRejected, 'bad Origin rejected with 403');

  const good = client(restricted.wsUrl, { headers: { Origin: 'https://example.com' } });
  await open(good.socket);
  good.socket.send(JSON.stringify({ type: 'create-room', name: 'G', displayName: 'G', guestId: 'g2' }));
  await good.wait((message) => message.type === 'joined');
  assert(true, 'good Origin allowed');
  good.socket.close();
} finally {
  restricted.server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const openServer = await startServer();
try {
  const response = await fetch(`${openServer.httpUrl}/`);
  assert(response.headers.get('x-content-type-options') === 'nosniff', 'header nosniff');
  assert(response.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options DENY');
  assert(response.headers.get('cross-origin-resource-policy') === 'same-site', 'CORP');
  assert(response.headers.get('cross-origin-embedder-policy') === 'require-corp', 'COEP');
  assert((response.headers.get('strict-transport-security') || '').includes('preload'), 'HSTS preload');
} finally {
  openServer.server.kill();
}
console.log('ORIGIN PASS');
