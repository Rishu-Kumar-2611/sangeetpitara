import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { RelayPcmPacketizer } from './relay-pcm.js';
import { decodePcm16Frame, encodePcm16Frame } from './media-relay.mjs';

function packetize(input, rate, blockSize) {
  const packetizer = new RelayPcmPacketizer();
  const frames = [];
  for (let i = 0; i < input.length; i += blockSize) {
    packetizer.push(input.subarray(i, i + blockSize), rate, (frame) => frames.push(frame));
  }
  return { frames, packetizer, samples: frames.flatMap((frame) => [...frame]) };
}

test('48 kHz capture preserves PCM samples exactly across render quantum and packet boundaries', () => {
  const input = Float32Array.from({ length: 48_000 }, (_, i) => 0.8 * Math.sin(2 * Math.PI * 997 * i / 48_000));
  const captured = packetize(input, 48_000, 128);
  // PCM16 has no signed zero; quantize the reference into the wire sample type.
  const expected = [...Int16Array.from(input, (x) => x < 0 ? Math.round(x * 32768) : Math.round(x * 32767))];
  assert.equal(captured.frames.length, 50);
  assert.deepEqual(captured.samples, expected);
  for (const [sequence, samples] of captured.frames.entries()) {
    const decoded = decodePcm16Frame(encodePcm16Frame({ sourceEpoch: 7, sequence, samples }));
    assert.deepEqual(decoded.samples, samples);
    assert.equal(decoded.sampleCount, 960);
  }
});

test('44.1 kHz resampling has no callback boundary jumps or cumulative sample loss', () => {
  const rate = 44_100;
  const input = Float32Array.from({ length: rate * 5 + 1 }, (_, i) => 0.7 * Math.sin(2 * Math.PI * 440 * i / rate));
  const reference = packetize(input, rate, input.length);
  assert.equal(reference.frames.length, 250);
  for (const chunk of [128, 512, 2048]) {
    const result = packetize(input, rate, chunk);
    assert.deepEqual(result.samples, reference.samples, `sample continuity at ${chunk} samples/callback`);
  }
  // Contrast with the old independently rounded 512-sample callbacks: they
  // lose >100 output samples over 5 s even though no network packet was lost.
  let oldCount = 0;
  for (let i = 0; i < input.length; i += 512) oldCount += Math.floor(Math.min(512, input.length - i) * 48_000 / rate);
  assert.ok(oldCount < 240_000 - 100);
});

test('capture quantization clips finite audio and replaces invalid samples without wrapping', () => {
  const input = new Float32Array(960);
  input.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -0, -1e-8, 1e-8]);
  assert.deepEqual(packetize(input, 48_000, 128).samples.slice(0, 12), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0, 0, 0, 0]);
});

test('reset and sample-rate changes discard only partial old capture, never mix leases', () => {
  const packetizer = new RelayPcmPacketizer();
  const frames = [];
  const emit = (frame) => frames.push(frame);
  packetizer.push(new Float32Array(512).fill(1), 48_000, emit);
  packetizer.reset();
  packetizer.push(new Float32Array(960).fill(-1), 48_000, emit);
  assert.deepEqual([...frames[0]], Array(960).fill(-32768));
  packetizer.push(new Float32Array(100).fill(1), 48_000, emit);
  packetizer.push(new Float32Array(883), 44_100, emit);
  assert.deepEqual([...frames[1]], Array(960).fill(0));
});

async function worklet(rate = 48_000) {
  const source = await readFile(new URL('./relay-capture-worklet.js', import.meta.url), 'utf8');
  const sent = [];
  let Processor;
  const scope = vm.createContext({
    RelayPcmPacketizer, Int16Array, sampleRate: rate, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data) => sent.push(data) }; } },
    registerProcessor: (name, definition) => { assert.equal(name, 'roomsound-relay-capture'); Processor = definition; },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/m, ''), scope);
  const node = new Processor();
  return {
    node, sent,
    message: (data) => node.port.onmessage({ data }),
    process: (input) => {
      const out = new Float32Array(input.length).fill(1);
      const alive = node.process([[input]], [[out]]);
      assert.ok(out.every((x) => x === 0), 'captured program audio must never echo locally');
      scope.currentTime += input.length / rate;
      return alive;
    },
  };
}

test('actual worklet produces continuous packets on the rendering thread and requires a source lease', async () => {
  const w = await worklet();
  w.process(new Float32Array(960).fill(1));
  assert.equal(w.sent.length, 0);
  w.message({ type: 'lease', epoch: 7 });
  const input = Float32Array.from({ length: 4800 }, (_, i) => i / 4800);
  for (let i = 0; i < input.length; i += 128) w.process(input.subarray(i, i + 128));
  assert.deepEqual(w.sent.map((frame) => frame.sequence), [0, 1, 2, 3, 4]);
  assert.ok(w.sent.every((frame) => frame.sourceEpoch === 7));
  assert.deepEqual(w.sent.flatMap((f) => [...f.samples]), packetize(input, 48_000, 128).samples);
});

test('worklet backpressure bounds main-thread stalls without hiding sequence loss', async () => {
  const w = await worklet();
  w.message({ type: 'lease', epoch: 1 });
  for (let i = 0; i < 30; i++) w.process(new Float32Array(960));
  assert.equal(w.sent.length, 8);
  w.message({ type: 'ack' });
  w.process(new Float32Array(960));
  assert.equal(w.sent.length, 9);
  assert.equal(w.sent[8].sequence, 30);
});

test('worklet revocation, epoch handoff and stop do not leak prior source samples', async () => {
  const w = await worklet();
  w.message({ type: 'lease', epoch: 1 });
  w.process(new Float32Array(512).fill(1));
  w.message({ type: 'lease', epoch: null });
  w.process(new Float32Array(960).fill(1));
  assert.equal(w.sent.length, 0);
  w.message({ type: 'lease', epoch: 2 });
  w.process(new Float32Array(960).fill(-1));
  assert.equal(w.sent[0].sequence, 0);
  assert.equal(w.sent[0].sourceEpoch, 2);
  assert.ok(w.sent[0].samples.every((sample) => sample === -32768));
  w.message({ type: 'stop' });
  assert.equal(w.process(new Float32Array(960)), false);
  assert.equal(w.sent.length, 1);
});
