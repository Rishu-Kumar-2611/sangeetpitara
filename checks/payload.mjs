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

async function startServer() {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      TURN_URLS: '',
      TURN_USERNAME: '',
      TURN_CREDENTIAL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { server, url: `ws://127.0.0.1:${port}` };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error('server did not become healthy');
}

function client(url) {
  const socket = new WebSocket(url);
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
          reject(new Error(`WebSocket message timeout: ${JSON.stringify(messages.slice(-1))}`));
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

console.log('=== Payload test ===');
const { server, url } = await startServer();
const room = client(url);
try {
  await open(room.socket);
  room.socket.send(JSON.stringify({ type: 'create-room', name: 'P', displayName: 'H', guestId: 'p1' }));
  await room.wait((message) => message.type === 'joined');

  const oversizedError = room.wait(
    (message) => message.type === 'error' && /Message too large/.test(message.message),
    3_000,
  ).catch(() => null);
  room.socket.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(70_000) }));
  assert(Boolean(await oversizedError), '70k returns Message too large');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert(room.socket.readyState === WebSocket.OPEN, 'socket stays open after 70k');

  room.socket.send(JSON.stringify({ type: 'chat', text: 'hello after big' }));
  const chat = await room.wait(
    (message) => message.type === 'chat' && message.message?.text === 'hello after big',
    3_000,
  ).catch(() => null);
  assert(Boolean(chat), 'chat still works after oversized message');

  let closeCode = null;
  room.socket.once('close', (code) => { closeCode = code; });
  try {
    room.socket.send(JSON.stringify({ type: 'chat', text: 'y'.repeat(600_000) }));
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert(
    closeCode === 1009 || room.socket.readyState === WebSocket.CLOSED || room.socket.readyState === WebSocket.CLOSING,
    `600k transport close/1009 got ${closeCode} state ${room.socket.readyState}`,
  );
} finally {
  room.socket.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}
console.log('PAYLOAD PASS');
