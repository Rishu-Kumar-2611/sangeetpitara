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
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(t, extraEnv = {}) {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) return `ws://127.0.0.1:${port}`;
    } catch {
      // The listener may need another event-loop turn.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output.join('')}`);
}

// A small client that queues messages so tests can wait for a specific one.
async function connect(t, url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queue.push(message);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  return {
    ws,
    send: (payload) => ws.send(JSON.stringify(payload)),
    next(match, timeoutMs = 3_000) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const position = waiters.indexOf(waiter);
          if (position >= 0) { waiters.splice(position, 1); reject(new Error('Timed out waiting for a message')); }
        }, timeoutMs).unref();
      });
    },
  };
}

const joinedOrError = (message) => message.type === 'joined' || message.type === 'error';
const secret = (label) => `${label}-secret-${'x'.repeat(32)}`;

async function createRoom(t, url) {
  const host = await connect(t, url);
  host.send({ type: 'create-room', name: 'Access test', displayName: 'Host', guestId: 'host-guest', reconnectSecret: secret('host') });
  const joined = await host.next((message) => message.type === 'joined');
  return { host, code: joined.state.room.code };
}

async function join(t, url, code, label) {
  const client = await connect(t, url);
  client.send({ type: 'join-room', code, displayName: label, guestId: `${label}-guest`, reconnectSecret: secret(label) });
  return { client, reply: await client.next(joinedOrError) };
}

test('new rooms get 8-character codes from the unambiguous alphabet', async (t) => {
  const url = await startServer(t);
  const { code } = await createRoom(t, url);
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`;
  const { reply } = await join(t, url, typed, 'listener');
  assert.equal(reply.type, 'joined');
  assert.equal(reply.state.room.locked, false);
});

test('wrong room codes from one address pause further joins', async (t) => {
  const url = await startServer(t, { JOIN_FAILURE_LIMIT: '3' });
  const { code } = await createRoom(t, url);
  const guesser = await connect(t, url);
  for (const guess of ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']) {
    guesser.send({ type: 'join-room', code: guess, displayName: 'Guesser', guestId: 'guesser', reconnectSecret: secret('guesser') });
    assert.match((await guesser.next(joinedOrError)).message, /unavailable/);
  }
  guesser.send({ type: 'join-room', code, displayName: 'Guesser', guestId: 'guesser', reconnectSecret: secret('guesser') });
  const blocked = await guesser.next(joinedOrError);
  assert.equal(blocked.type, 'error');
  assert.match(blocked.message, /Too many incorrect room codes/);
});

test('a locked room admits only reconnecting members', async (t) => {
  const url = await startServer(t);
  const { host, code } = await createRoom(t, url);
  const first = await join(t, url, code, 'member');
  assert.equal(first.reply.type, 'joined');

  first.client.send({ type: 'set-room-lock', locked: true });
  assert.match((await first.client.next((message) => message.type === 'error')).message, /Only the host or co-host/);

  host.send({ type: 'set-room-lock', locked: true });
  await host.next((message) => message.type === 'state' && message.state.room.locked === true);

  const stranger = await join(t, url, code, 'stranger');
  assert.equal(stranger.reply.type, 'error');
  assert.match(stranger.reply.message, /locked by the host/);

  first.client.ws.terminate();
  const returning = await join(t, url, code, 'member');
  assert.equal(returning.reply.type, 'joined');
  assert.equal(returning.reply.state.room.locked, true);

  host.send({ type: 'set-room-lock', locked: false });
  await host.next((message) => message.type === 'state' && message.state.room.locked === false);
  assert.equal((await join(t, url, code, 'late')).reply.type, 'joined');
});

test('a new room code shuts out old invites but keeps existing members', async (t) => {
  const url = await startServer(t);
  const { host, code: oldCode } = await createRoom(t, url);
  const member = await join(t, url, oldCode, 'member');
  assert.equal(member.reply.type, 'joined');

  member.client.send({ type: 'rotate-room-code' });
  assert.match((await member.client.next((message) => message.type === 'error')).message, /Only the host or co-host/);

  host.send({ type: 'rotate-room-code' });
  const rotated = await host.next((message) => message.type === 'state' && message.state.room.code !== oldCode);
  const newCode = rotated.state.room.code;
  assert.match(newCode, /^[A-HJ-NP-Z2-9]{8}$/);

  host.send({ type: 'rotate-room-code' });
  assert.match((await host.next((message) => message.type === 'error')).message, /wait a few seconds/);

  const stranger = await join(t, url, oldCode, 'stranger');
  assert.equal(stranger.reply.type, 'error');
  assert.match(stranger.reply.message, /unavailable/);

  member.client.ws.terminate();
  const returning = await join(t, url, oldCode, 'member');
  assert.equal(returning.reply.type, 'joined');
  assert.equal(returning.reply.state.room.code, newCode);

  assert.equal((await join(t, url, newCode, 'invited')).reply.type, 'joined');
});

test('sockets that never join a room are closed', async (t) => {
  const url = await startServer(t, { UNJOINED_SOCKET_TIMEOUT_MS: '300' });
  const idle = await connect(t, url);
  const code = await new Promise((resolve) => idle.ws.once('close', resolve));
  assert.equal(code, 4008);

  const { host } = await createRoom(t, url);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(host.ws.readyState, WebSocket.OPEN);
});

test('one address cannot hold more than its connection share', async (t) => {
  const url = await startServer(t, { MAX_CONNECTIONS_PER_IP: '2' });
  await connect(t, url);
  await connect(t, url);
  const rejected = new WebSocket(url);
  t.after(() => rejected.terminate());
  const status = await new Promise((resolve) => {
    rejected.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    rejected.once('open', () => resolve('open'));
    rejected.once('error', () => {});
  });
  assert.equal(status, 503);
});
