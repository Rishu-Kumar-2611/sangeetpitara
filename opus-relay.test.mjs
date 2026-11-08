import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import WebSocket from 'ws';
import {
  decodeOpusFrame,
  encodeOpusFrame,
  encodePcm16Frame,
  opusPacketSampleCount,
  relayFrameVersion,
  validateRelayFrameHeader,
} from './media-relay.mjs';

// TOC 0xFC: CELT fullband 20 ms, one frame.
const OPUS_PACKET = Uint8Array.from([0xFC, 0xFF, 0xFE, 0x01, 0x02, 0x03]);

test('Opus relay frames round-trip and reject malformed headers', () => {
  const frame = encodeOpusFrame({ sourceEpoch: 4, sequence: 9, payload: OPUS_PACKET });
  assert.equal(relayFrameVersion(frame), 2);
  const header = validateRelayFrameHeader(frame);
  assert.deepEqual(
    { codec: header.codec, sourceEpoch: header.sourceEpoch, sequence: header.sequence, sampleCount: header.sampleCount, payloadBytes: header.payloadBytes },
    { codec: 'opus', sourceEpoch: 4, sequence: 9, sampleCount: 960, payloadBytes: OPUS_PACKET.length },
  );
  assert.deepEqual([...decodeOpusFrame(frame).payload], [...OPUS_PACKET]);

  const pcm = encodePcm16Frame({ sourceEpoch: 1, sequence: 1, samples: new Int16Array(960) });
  assert.equal(validateRelayFrameHeader(pcm).codec, 'pcm16');

  const stereo = frame.slice(); stereo[5] = 2;
  assert.throws(() => validateRelayFrameHeader(stereo), /one channel/);
  const oddCount = frame.slice(); new DataView(oddCount.buffer).setUint16(18, 961, true);
  assert.throws(() => validateRelayFrameHeader(oddCount), /sampleCount/);
  const empty = frame.slice(0, 20);
  assert.throws(() => validateRelayFrameHeader(empty), /payload size/);
  assert.throws(() => encodeOpusFrame({ sourceEpoch: 1, sequence: 1, payload: new Uint8Array(5000) }), /outside the relay bound/);
});

test('Opus TOC parsing covers SILK, hybrid, CELT and multi-frame packets', () => {
  assert.equal(opusPacketSampleCount(Uint8Array.of(0x08)), 960); // SILK 20 ms
  assert.equal(opusPacketSampleCount(Uint8Array.of(0x78)), 960); // hybrid FB 20 ms
  assert.equal(opusPacketSampleCount(Uint8Array.of(0xE0)), 120); // CELT fullband 2.5 ms (config 28)
  assert.equal(opusPacketSampleCount(Uint8Array.of(0xFD)), 1920); // two 20 ms frames
  assert.equal(opusPacketSampleCount(Uint8Array.of(0xFF, 0x03)), 2880); // three 20 ms frames
  assert.equal(opusPacketSampleCount(Uint8Array.of(0xFF, 0x07)), 0); // 140 ms is over the limit
});

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/ready`)).ok) return { url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not start');
}

async function connect(t, url) {
  const ws = new WebSocket(url);
  const queue = [];
  const binary = [];
  const waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { binary.push(new Uint8Array(raw)); return; }
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.match(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message); else queue.push(message);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  return {
    ws,
    binary,
    send: (payload) => ws.send(JSON.stringify(payload)),
    next(match, timeoutMs = 3_000) {
      const index = queue.findIndex(match);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) { waiters.splice(at, 1); reject(new Error('timeout')); } }, timeoutMs).unref();
      });
    },
  };
}

const secret = (label) => `${label}-secret-${'x'.repeat(32)}`;
const codecIs = (codec) => (message) => message.type === 'state' && message.state.room.relayCodec === codec;

test('rooms use Opus only while every member can decode it, and frames reach only capable listeners', async (t) => {
  const { url, http } = await startServer(t);
  const config = await (await fetch(`${http}/config`)).json();
  assert.deepEqual(config.mediaRelay.codecs, ['pcm16', 'opus']);
  assert.equal(config.mediaRelay.opusBitrate, 96_000);

  const host = await connect(t, url);
  host.send({ type: 'create-room', name: 'Opus', displayName: 'Host', guestId: 'host', reconnectSecret: secret('host'), codecs: ['pcm16', 'opus'] });
  const created = await host.next((message) => message.type === 'joined');
  assert.equal(created.state.room.relayCodec, 'opus');
  const code = created.state.room.code;

  const modern = await connect(t, url);
  modern.send({ type: 'join-room', code, displayName: 'Modern', guestId: 'modern', reconnectSecret: secret('modern'), codecs: ['pcm16', 'opus'] });
  assert.equal((await modern.next((message) => message.type === 'joined')).state.room.relayCodec, 'opus');

  host.send({ type: 'start-source', sourceType: 'DEVICE_AUDIO' });
  const live = await host.next((message) => message.type === 'state' && message.state.room.sourceStatus === 'LIVE');
  const epoch = live.state.room.sourceEpoch;

  // An older client without a codec list turns the room back to PCM16.
  const legacy = await connect(t, url);
  legacy.send({ type: 'join-room', code, displayName: 'Legacy', guestId: 'legacy', reconnectSecret: secret('legacy') });
  assert.equal((await legacy.next((message) => message.type === 'joined')).state.room.relayCodec, 'pcm16');
  await host.next(codecIs('pcm16'));

  // A frame sent during the switch reaches the Opus-capable listener only.
  host.ws.send(encodeOpusFrame({ sourceEpoch: epoch, sequence: 0, payload: OPUS_PACKET }));
  host.ws.send(encodePcm16Frame({ sourceEpoch: epoch, sequence: 0, samples: new Int16Array(960) }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(modern.binary.map(relayFrameVersion), [2, 1]);
  assert.deepEqual(legacy.binary.map(relayFrameVersion), [1]);

  // When the legacy listener upgrades (or leaves), the room returns to Opus.
  legacy.send({ type: 'set-codecs', codecs: ['pcm16', 'opus'] });
  await host.next(codecIs('opus'));
  modern.send({ type: 'set-codecs', codecs: ['pcm16'] });
  await host.next(codecIs('pcm16'));
});

test('MEDIA_RELAY_OPUS=0 keeps every room on PCM16 and refuses Opus frames', async (t) => {
  const { url, http } = await startServer(t, { MEDIA_RELAY_OPUS: '0' });
  assert.deepEqual((await (await fetch(`${http}/config`)).json()).mediaRelay.codecs, ['pcm16']);
  const host = await connect(t, url);
  host.send({ type: 'create-room', name: 'Off', displayName: 'Host', guestId: 'host', reconnectSecret: secret('host'), codecs: ['pcm16', 'opus'] });
  const created = await host.next((message) => message.type === 'joined');
  assert.equal(created.state.room.relayCodec, 'pcm16');
  host.send({ type: 'start-source', sourceType: 'DEVICE_AUDIO' });
  const live = await host.next((message) => message.type === 'state' && message.state.room.sourceStatus === 'LIVE');
  host.ws.send(encodeOpusFrame({ sourceEpoch: live.state.room.sourceEpoch, sequence: 0, payload: OPUS_PACKET }));
  assert.match((await host.next((message) => message.type === 'error')).message, /Opus relay is disabled/);
});

test('listeners resync when a sender restarts its numbering instead of going silent', async () => {
  const { RelaySequenceTracker, RELAY_RESYNC_AFTER } = await import('./media-relay.mjs');
  const order = new RelaySequenceTracker();
  for (let sequence = 30_000; sequence < 30_100; sequence += 1) assert.equal(order.observe(sequence, 'opus').accept, true);
  // The sender reconnects and restarts at 0: briefly treated as late packets...
  for (let sequence = 0; sequence < RELAY_RESYNC_AFTER - 1; sequence += 1) assert.equal(order.observe(sequence, 'opus').accept, false);
  // ...then the new numbering is adopted and audio flows again.
  const resync = order.observe(RELAY_RESYNC_AFTER - 1, 'opus');
  assert.deepEqual(resync, { accept: true, missing: 0, resynced: true });
  assert.equal(order.observe(RELAY_RESYNC_AFTER, 'opus').accept, true);
});

test('listener order tracking drops duplicates, counts gaps and resets on a codec switch', async () => {
  const { RelaySequenceTracker } = await import('./media-relay.mjs');
  const order = new RelaySequenceTracker();
  assert.equal(order.observe(10).accept, true);
  assert.equal(order.observe(10).accept, false, 'duplicate');
  assert.deepEqual(order.observe(14), { accept: true, missing: 3, resynced: false });
  assert.equal(order.observe(12).accept, false, 'late packet');
  assert.equal(order.observe(0xFFFFFFFF - 1, 'pcm16').accept, false);
  assert.equal(order.observe(0, 'opus').accept, true, 'a codec switch restarts numbering');
  assert.deepEqual(order.observe(1, 'opus'), { accept: true, missing: 0, resynced: false });
});
