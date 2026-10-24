import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';
import { encodePcm16Frame } from './media-relay.mjs';

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

async function startServer(extraEnv = {}) {
  const port = await unusedPort();
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), MEDIA_RELAY_ENABLED: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { server, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  server.kill();
  throw new Error(`RoomSound server did not start: ${output.join('')}`);
}

function client(url) {
  const socket = new WebSocket(url);
  const jsonMessages = [];
  const binaryMessages = [];
  const jsonWaiters = [];
  const binaryWaiters = [];
  socket.on('message', (raw, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(raw);
      binaryMessages.push(frame);
      for (const waiter of [...binaryWaiters]) {
        if (!waiter.predicate(frame)) continue;
        binaryWaiters.splice(binaryWaiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      return;
    }
    const message = JSON.parse(raw.toString());
    jsonMessages.push(message);
    for (const waiter of [...jsonWaiters]) {
      if (!waiter.predicate(message)) continue;
      jsonWaiters.splice(jsonWaiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    binaryMessages,
    open: () => new Promise((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 5_000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    }),
    waitJson: (predicate) => {
      const existing = jsonMessages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          jsonWaiters.splice(jsonWaiters.indexOf(waiter), 1);
          reject(new Error('JSON WebSocket message timeout'));
        }, 5_000);
        jsonWaiters.push(waiter);
      });
    },
    waitBinary: (predicate = () => true) => {
      const existing = binaryMessages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          binaryWaiters.splice(binaryWaiters.indexOf(waiter), 1);
          reject(new Error('Binary WebSocket message timeout'));
        }, 5_000);
        binaryWaiters.push(waiter);
      });
    },
  };
}

function pcmFrame(sourceEpoch, sequence = 1) {
  const samples = new Int16Array(960);
  samples[0] = -32768;
  samples[1] = 32767;
  samples[2] = 1234;
  return encodePcm16Frame({ sourceEpoch, sequence, samples });
}

test('PCM16 frame header uses the documented RSR1 little-endian layout', () => {
  const frame = encodePcm16Frame({
    sourceEpoch: 0x01020304,
    sequence: 0xA0B0C0D0,
    samples: new Int16Array([-32768, 32767]),
  });
  assert.deepEqual([...frame.slice(0, 20)], [
    0x52, 0x53, 0x52, 0x31,
    0x01,
    0x01,
    0x80, 0xBB, 0x00, 0x00,
    0x04, 0x03, 0x02, 0x01,
    0xD0, 0xC0, 0xB0, 0xA0,
    0x02, 0x00,
  ]);
  assert.deepEqual([...frame.slice(20)], [0x00, 0x80, 0xFF, 0x7F]);
});

async function createRoom(source, listener) {
  await source.open();
  source.socket.send(JSON.stringify({
    type: 'create-room',
    name: 'PCM relay room',
    displayName: 'Laptop',
    guestId: 'relay-laptop',
  }));
  const created = await source.waitJson((message) => message.type === 'joined');

  await listener.open();
  listener.socket.send(JSON.stringify({
    type: 'join-room',
    code: created.state.room.code,
    displayName: 'Phone',
    guestId: 'relay-phone',
  }));
  const joined = await listener.waitJson((message) => message.type === 'joined');
  await source.waitJson((message) => message.type === 'state' && message.state.members.length === 2);

  source.socket.send(JSON.stringify({ type: 'start-source', sourceType: 'TEST_TONE', sourceLabel: 'relay test' }));
  const live = await listener.waitJson((message) => (
    message.type === 'state'
      && message.state.room.activeSourceId === created.state.self.id
      && message.state.room.sourceStatus === 'LIVE'
  ));
  return { created, joined, epoch: live.state.room.sourceEpoch };
}

test('config enables the PCM16 relay by default and permits an explicit direct-WebRTC opt-out', async (t) => {
  const running = await startServer();
  t.after(() => running.server.kill());
  const config = await fetch(`${running.http}/config`).then((response) => response.json());
  assert.deepEqual(config.mediaRelay, {
    enabled: true,
    mode: 'pcm16',
    sampleRate: 48000,
    channels: 1,
  });

  const direct = await startServer({ MEDIA_RELAY_ENABLED: '0' });
  t.after(() => direct.server.kill());
  const directConfig = await fetch(`${direct.http}/config`).then((response) => response.json());
  assert.deepEqual(directConfig.mediaRelay, {
    enabled: false,
    mode: 'pcm16',
    sampleRate: 48000,
    channels: 1,
  });
});

test('PCM16 relay forwards the exact frame only from the active source', async (t) => {
  const running = await startServer();
  const source = client(running.url);
  const listener = client(running.url);
  t.after(() => {
    source.socket.close();
    listener.socket.close();
    running.server.kill();
  });

  const { epoch } = await createRoom(source, listener);
  const frame = pcmFrame(epoch, 7);
  const forwarded = listener.waitBinary();
  source.socket.send(frame);
  assert.deepEqual(await forwarded, Buffer.from(frame));
  assert.equal(source.binaryMessages.length, 0, 'the source must not receive its own relay frame');
});

test('PCM16 relay rejects unauthorized, stale, malformed, and oversized frames', async (t) => {
  const running = await startServer();
  const source = client(running.url);
  const listener = client(running.url);
  t.after(() => {
    source.socket.close();
    listener.socket.close();
    running.server.kill();
  });

  const { epoch } = await createRoom(source, listener);

  const unauthorized = listener.waitJson((message) => message.type === 'error' && /not authorized/i.test(message.message));
  listener.socket.send(pcmFrame(epoch, 1));
  assert.match((await unauthorized).message, /not authorized/i);

  const stale = source.waitJson((message) => message.type === 'error' && /stale source epoch/i.test(message.message));
  source.socket.send(pcmFrame(epoch - 1, 2));
  assert.match((await stale).message, /stale source epoch/i);

  const malformed = pcmFrame(epoch, 3);
  malformed[6] = 0x44;
  malformed[7] = 0xAC;
  malformed[8] = 0x00;
  malformed[9] = 0x00;
  const invalid = source.waitJson((message) => message.type === 'error' && /invalid media relay frame/i.test(message.message));
  source.socket.send(malformed);
  assert.match((await invalid).message, /48000/i);

  const oversized = new Uint8Array(20 + 64 * 1024 + 2);
  const tooLarge = source.waitJson((message) => message.type === 'error' && /too large/i.test(message.message));
  source.socket.send(oversized);
  assert.match((await tooLarge).message, /too large/i);
});

test('PCM16 relay bounds binary bytes per window, not only frame count', async (t) => {
  const running = await startServer();
  const source = client(running.url);
  t.after(() => {
    source.socket.close();
    running.server.kill();
  });

  await source.open();
  // Twenty maximum-size frames are far below the frame-count cap but carry
  // ~13 s of PCM16 audio, more than twice real time for the 5 s window.
  const maxSizeFrame = new Uint8Array(20 + 64 * 1024);
  const tooFast = source.waitJson((message) => message.type === 'error' && /too quickly/i.test(message.message));
  for (let i = 0; i < 20; i += 1) source.socket.send(maxSizeFrame);
  assert.match((await tooFast).message, /too quickly/i);
});
