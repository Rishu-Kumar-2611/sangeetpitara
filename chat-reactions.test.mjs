import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';

async function startServer() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { server, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error('RoomSound server did not start');
}

function client(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    send: (payload) => socket.send(JSON.stringify(payload)),
    open: () => new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    // Only messages after `since` count, so repeated events are not matched twice.
    next: (predicate, since = messages.length) => {
      const existing = messages.slice(since).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('message timeout')), 5_000) };
        waiters.push(waiter);
      });
    },
    get count() { return messages.length; },
  };
}

async function roomWithTwoMembers(t) {
  const { server, port } = await startServer();
  const host = client(port);
  const guest = client(port);
  t.after(() => { host.socket.close(); guest.socket.close(); server.kill(); });
  await host.open();
  host.send({ type: 'create-room', name: 'Reactions', displayName: 'Host', guestId: 'react-host' });
  const joined = await host.next((m) => m.type === 'joined', 0);
  await guest.open();
  guest.send({ type: 'join-room', code: joined.state?.room?.code ?? joined.room?.code, displayName: 'Guest', guestId: 'react-guest' });
  const guestJoined = await guest.next((m) => m.type === 'joined', 0);
  return { host, guest, guestId: guestJoined.state?.self?.id ?? guestJoined.self?.id };
}

test('config publishes the fixed chat reaction set', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.kill());
  const config = await (await fetch(`http://127.0.0.1:${port}/config`)).json();
  assert.deepEqual(config.chatReactions, ['❤️', '🔥', '😂', '👏', '🙏', '🎵']);
});

test('reactions toggle per member and broadcast to the room', async (t) => {
  const { host, guest, guestId } = await roomWithTwoMembers(t);
  assert.ok(guestId, 'joined payload exposes the member id');
  let mark = host.count;
  host.send({ type: 'chat', text: 'Kya gaana hai 🎶' });
  const chat = await host.next((m) => m.type === 'chat' && m.message.kind === 'chat', mark);
  assert.equal(chat.message.text, 'Kya gaana hai 🎶');

  mark = host.count;
  guest.send({ type: 'react', messageId: chat.message.id, emoji: '🔥' });
  const added = await host.next((m) => m.type === 'reaction', mark);
  assert.equal(added.messageId, chat.message.id);
  assert.deepEqual(added.reactions, { '🔥': [guestId] });

  mark = host.count;
  guest.send({ type: 'react', messageId: chat.message.id, emoji: '🔥' });
  const removed = await host.next((m) => m.type === 'reaction', mark);
  assert.deepEqual(removed.reactions, {});
});

test('reactions outside the fixed set or on unknown messages are rejected', async (t) => {
  const { host } = await roomWithTwoMembers(t);
  let mark = host.count;
  host.send({ type: 'chat', text: 'hello' });
  const chat = await host.next((m) => m.type === 'chat' && m.message.kind === 'chat', mark);
  for (const payload of [
    { type: 'react', messageId: chat.message.id, emoji: 'free text' },
    { type: 'react', messageId: 'missing', emoji: '❤️' },
  ]) {
    mark = host.count;
    host.send(payload);
    const error = await host.next((m) => m.type === 'error', mark);
    assert.match(error.message, /reaction is not available/i);
  }
});

test('chat length limit never splits an emoji', async (t) => {
  const { host } = await roomWithTwoMembers(t);
  const mark = host.count;
  // 279 ASCII characters plus a two-unit emoji crosses the 280 limit mid-emoji.
  host.send({ type: 'chat', text: `${'a'.repeat(279)}🔥` });
  const chat = await host.next((m) => m.type === 'chat' && m.message.kind === 'chat', mark);
  assert.equal(chat.message.text, 'a'.repeat(279));
  assert.ok(!/[\uD800-\uDFFF]/.test(chat.message.text), 'no lone surrogate');
});
