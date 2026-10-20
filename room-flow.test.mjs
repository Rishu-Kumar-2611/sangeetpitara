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
  const address = probe.address();
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(extraEnv = {}) {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return {
        server,
        url: `ws://127.0.0.1:${port}`,
        http: `http://127.0.0.1:${port}`,
      };
    } catch {
      // The listener may need another event-loop turn.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error(`RoomSound server did not start: ${output.join('')}`);
}

test('config publishes configured TURN servers only when the relay is explicitly enabled', async (t) => {
  const { server, http } = await startServer({
    TURN_ENABLED: '1',
    TURN_URLS: 'turn:relay.example.test:3478,turns:relay.example.test:5349?transport=tcp',
    TURN_USERNAME: 'test-user',
    TURN_CREDENTIAL: 'test-credential',
  });
  t.after(() => server.kill());

  const response = await fetch(`${http}/config`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.deepEqual(config.iceServers, [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:relay.example.test:3478',
        'turns:relay.example.test:5349?transport=tcp',
      ],
      username: 'test-user',
      credential: 'test-credential',
    },
  ]);
});

test('config stays STUN-only when relay credentials exist but TURN is disabled', async (t) => {
  const { server, http } = await startServer({
    TURN_ENABLED: '0',
    TURN_URLS: 'turn:relay.example.test:3478',
    TURN_USERNAME: 'test-user',
    TURN_CREDENTIAL: 'test-credential',
  });
  t.after(() => server.kill());

  const response = await fetch(`${http}/config`);
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.deepEqual(config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
});

function client(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
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
    open: () => new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    }),
    wait: (predicate) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('WebSocket message timeout'));
        }, 5_000);
        waiters.push(waiter);
      });
    },
  };
}

test('phone request keeps source authorization through RTC signaling', async (t) => {
  const { server, url } = await startServer();
  const host = client(url);
  const phone = client(url);
  t.after(() => {
    host.socket.close();
    phone.socket.close();
    server.kill();
  });

  await host.open();
  host.socket.send(JSON.stringify({
    type: 'create-room',
    name: 'Reverse direction regression',
    displayName: 'Laptop',
    guestId: 'test-laptop',
  }));
  const created = await host.wait((message) => message.type === 'joined');

  await phone.open();
  phone.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Phone',
    guestId: 'test-phone',
  }));
  const joined = await phone.wait((message) => message.type === 'joined');
  await host.wait((message) => message.type === 'state' && message.state.members.length === 2);

  phone.socket.send(JSON.stringify({
    type: 'request-control',
    sourceType: 'ANDROID_DEVICE_AUDIO',
    note: 'Phone playback',
  }));
  const requested = await host.wait((message) => (
    message.type === 'state' && message.state.requests.length === 1
  ));
  const request = requested.state.requests[0];
  assert.equal(request.sourceType, 'ANDROID_DEVICE_AUDIO');

  const approval = phone.wait((message) => message.type === 'request-result' && message.status === 'APPROVED');
  const starting = host.wait((message) => (
    message.type === 'state' &&
    message.state.room.activeSourceId === joined.state.self.id &&
    message.state.room.sourceStatus === 'STARTING'
  ));
  host.socket.send(JSON.stringify({ type: 'approve-request', requestId: request.id }));
  await approval;
  await starting;

  phone.socket.send(JSON.stringify({
    type: 'start-source',
    sourceType: 'ANDROID_DEVICE_AUDIO',
    sourceLabel: 'Android device audio',
  }));
  const live = await host.wait((message) => (
    message.type === 'state' &&
    message.state.room.activeSourceId === joined.state.self.id &&
    message.state.room.sourceStatus === 'LIVE'
  ));
  const epoch = live.state.room.sourceEpoch;

  const forwardedRtc = host.wait((message) => (
    message.type === 'rtc' && message.from === joined.state.self.id
  ));
  phone.socket.send(JSON.stringify({
    type: 'rtc',
    to: created.state.self.id,
    sourceEpoch: epoch,
    signal: { type: 'offer', description: { type: 'offer', sdp: 'phone-offer' } },
  }));
  const rtc = await forwardedRtc;
  assert.equal(rtc.sourceEpoch, epoch);
  assert.equal(rtc.signal.description.sdp, 'phone-offer');
});

test('joins when a pasted room code contains case changes, whitespace, and hyphens', async (t) => {
  const { server, url } = await startServer();
  const host = client(url);
  const phone = client(url);
  t.after(() => {
    host.socket.close();
    phone.socket.close();
    server.kill();
  });

  await host.open();
  host.socket.send(JSON.stringify({
    type: 'create-room',
    name: 'Pasted code regression',
    displayName: 'Laptop',
    guestId: 'pasted-code-laptop',
  }));
  const created = await host.wait((message) => message.type === 'joined');
  const code = created.state.room.code;
  const pastedCode = `  ${code.slice(0, 2).toLowerCase()} ${code.slice(2, 4)}-${code.slice(4)}  `;

  await phone.open();
  phone.socket.send(JSON.stringify({
    type: 'join-room',
    code: pastedCode,
    displayName: 'Android',
    guestId: 'pasted-code-android',
  }));
  const joined = await phone.wait((message) => message.type === 'joined');

  assert.equal(joined.state.room.code, code);
  assert.equal(joined.state.self.name, 'Android');
});

test('rejects microphone source requests', async (t) => {
  const { server, url } = await startServer();
  const host = client(url);
  const phone = client(url);
  t.after(() => {
    host.socket.close();
    phone.socket.close();
    server.kill();
  });

  await host.open();
  host.socket.send(JSON.stringify({
    type: 'create-room',
    name: 'Playback-only room',
    displayName: 'Laptop',
    guestId: 'playback-host',
  }));
  const created = await host.wait((message) => message.type === 'joined');

  await phone.open();
  phone.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Phone',
    guestId: 'playback-phone',
  }));
  await phone.wait((message) => message.type === 'joined');

  const rejected = phone.wait((message) => message.type === 'error');
  phone.socket.send(JSON.stringify({
    type: 'request-control',
    sourceType: 'MICROPHONE',
    note: 'This must not be accepted.',
  }));
  const error = await rejected;
  assert.match(error.message, /device playback audio/i);
});

test('leave releases the host before reconnect so the host can end the same room', async (t) => {
  const { server, url } = await startServer();
  const host = client(url);
  const reconnect = client(url);
  const lateJoiner = client(url);
  t.after(() => {
    host.socket.close();
    reconnect.socket.close();
    lateJoiner.socket.close();
    server.kill();
  });

  await host.open();
  host.socket.send(JSON.stringify({
    type: 'create-room',
    name: 'Lifecycle room',
    displayName: 'Host',
    guestId: 'lifecycle-host',
  }));
  const created = await host.wait((message) => message.type === 'joined');

  await reconnect.open();
  host.socket.send(JSON.stringify({ type: 'leave-room' }));
  reconnect.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Host again',
    guestId: 'lifecycle-host',
  }));
  const rejoined = await reconnect.wait((message) => message.type === 'joined');
  assert.equal(rejoined.state.self.role, 'HOST');
  assert.equal(rejoined.state.room.code, created.state.room.code);

  const ended = reconnect.wait((message) => message.type === 'room-ended');
  reconnect.socket.send(JSON.stringify({ type: 'end-room' }));
  assert.equal((await ended).message, 'The host ended the room.');

  await lateJoiner.open();
  const unavailable = lateJoiner.wait((message) => message.type === 'error');
  lateJoiner.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Too late',
    guestId: 'lifecycle-late',
  }));
  assert.match((await unavailable).message, /unavailable|ended/i);
});
