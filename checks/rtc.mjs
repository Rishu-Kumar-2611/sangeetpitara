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
  const output = [];
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
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { server, url: `ws://127.0.0.1:${port}` };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error(output.join(''));
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
    async open() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5_000);
        socket.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    wait(predicate, timeoutMs = 3_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`WebSocket message timeout: ${JSON.stringify(messages.slice(-2))}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL ${message}`);
  console.log(`PASS ${message}`);
}

console.log('=== RTC authorization test ===');
const { server, url } = await startServer();
const host = client(url);
const guest = client(url);
try {
  await host.open();
  host.socket.send(JSON.stringify({ type: 'create-room', name: 'R', displayName: 'Host', guestId: 'h1' }));
  const created = await host.wait((message) => message.type === 'joined');

  await guest.open();
  guest.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Guest',
    guestId: 'g1',
  }));
  const joined = await guest.wait((message) => message.type === 'joined');
  await host.wait((message) => message.type === 'state' && message.state.members.length === 2);

  let hostReceivedOffer = false;
  host.socket.on('message', (raw) => {
    try {
      if (JSON.parse(raw.toString()).type === 'rtc') hostReceivedOffer = true;
    } catch {}
  });
  const unauthorizedError = guest.wait(
    (message) => message.type === 'error' && /No active source/.test(message.message),
    3_000,
  ).catch(() => null);
  guest.socket.send(JSON.stringify({
    type: 'rtc',
    to: created.state.self.id,
    signal: { type: 'offer', description: { type: 'offer', sdp: 'evil' } },
  }));
  assert(Boolean(await unauthorizedError), 'unauthorized offer rejected');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert(!hostReceivedOffer, 'unauthorized offer not forwarded');

  guest.socket.send(JSON.stringify({ type: 'request-control', sourceType: 'TEST_TONE' }));
  const requestState = await host.wait((message) => message.type === 'state' && message.state.requests.length === 1);
  const requestId = requestState.state.requests[0].id;
  const approved = guest.wait((message) => message.type === 'request-result' && message.status === 'APPROVED');
  const starting = host.wait((message) => message.type === 'state' && message.state.room.activeSourceId === joined.state.self.id);
  host.socket.send(JSON.stringify({ type: 'approve-request', requestId }));
  await approved;
  await starting;

  guest.socket.send(JSON.stringify({ type: 'start-source', sourceType: 'TEST_TONE', sourceLabel: 'test' }));
  const live = await host.wait((message) => message.type === 'state' && message.state.room.sourceStatus === 'LIVE');
  const epoch = live.state.room.sourceEpoch;
  assert(typeof epoch === 'number', 'source epoch exists');

  const forwardedOffer = host.wait((message) => message.type === 'rtc' && message.from === joined.state.self.id);
  guest.socket.send(JSON.stringify({
    type: 'rtc',
    to: created.state.self.id,
    sourceEpoch: epoch,
    signal: { type: 'offer', description: { type: 'offer', sdp: 'good' } },
  }));
  const forwarded = await forwardedOffer;
  assert(forwarded.signal.description.sdp === 'good' && forwarded.sourceEpoch === epoch, 'authorized offer forwarded with epoch');

  const staleError = guest.wait(
    (message) => message.type === 'error' && /Stale source epoch/.test(message.message),
    3_000,
  ).catch(() => null);
  guest.socket.send(JSON.stringify({
    type: 'rtc',
    to: created.state.self.id,
    sourceEpoch: epoch + 999,
    signal: { type: 'offer', description: { type: 'offer', sdp: 'stale' } },
  }));
  assert(Boolean(await staleError), 'stale source epoch rejected');

  const answer = guest.wait((message) => message.type === 'rtc' && message.signal?.type === 'answer');
  host.socket.send(JSON.stringify({
    type: 'rtc',
    to: joined.state.self.id,
    signal: { type: 'answer', description: { type: 'answer', sdp: 'ans' } },
  }));
  const forwardedAnswer = await answer;
  assert(forwardedAnswer.signal.description.sdp === 'ans', 'listener answer forwarded');
} finally {
  host.socket.close();
  guest.socket.close();
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
}
console.log('RTC PASS');
