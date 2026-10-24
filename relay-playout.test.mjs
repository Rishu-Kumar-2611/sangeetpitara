import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const FRAME_SAMPLES = 960;
const QUANTUM = 128;

async function playout(targetDelayMs = 150) {
  const source = await readFile(new URL('./relay-playout-worklet.js', import.meta.url), 'utf8');
  let Processor;
  const scope = vm.createContext({
    Int16Array, Float32Array, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: () => {} }; } },
    registerProcessor: (name, definition) => { assert.equal(name, 'roomsound-relay-playout'); Processor = definition; },
  });
  vm.runInContext(source, scope);
  const node = new Processor();
  node.port.onmessage({ data: { type: 'config', targetDelayMs } });
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  let rendered = 0;
  let delivered = 0;
  let skips = 0;
  const feed = () => {
    const before = node.available;
    node.port.onmessage({ data: { type: 'pcm', samples: new Int16Array(FRAME_SAMPLES).fill(1000), channels: 1 } });
    if (node.available < before + FRAME_SAMPLES - 1) skips += 1;
    delivered += 1;
  };
  const render = () => {
    node.process([], [out]);
    rendered += QUANTUM;
    scope.currentTime = rendered / 48_000;
  };
  return {
    node,
    get skips() { return skips; },
    /**
     * Renders `ms` of audio while the sender produces in real time. Frames arrive
     * in groups of `bunch` once the whole group exists; `connected` gates arrival.
     */
    run(ms, { connected = true, bunch = 1 } = {}) {
      const end = rendered + Math.round(ms * 48);
      while (rendered < end) {
        const groupEnd = () => (Math.floor(delivered / bunch) + 1) * bunch;
        while (connected && groupEnd() * FRAME_SAMPLES <= rendered + 9_600) {
          for (let i = delivered, last = groupEnd(); i < last; i += 1) feed();
        }
        render();
      }
    },
    flush(count) { for (let i = 0; i < count; i += 1) feed(); },
  };
}

test('playout skips a post-stall backlog instead of playing it late', async () => {
  const p = await playout();
  p.run(2_000);
  assert.equal(p.skips, 0);
  // The listener's network stalls for 1.5 s; TCP then delivers the backlog at once.
  p.run(1_500, { connected: false });
  p.flush(75);
  assert.ok(p.skips > 0);
  p.run(1_000);
  const bufferedMs = p.node.available / 48;
  const targetMs = p.node.targetFill / 48;
  assert.ok(bufferedMs <= targetMs + 400, `buffered ${bufferedMs} ms vs target ${targetMs} ms`);
  assert.ok(bufferedMs < 1_000, `stall left ${bufferedMs} ms of lasting delay`);
});

test('playout raises the underrun cushion once per rebuffer', async () => {
  const p = await playout();
  p.run(2_000);
  assert.equal(p.node.adaptiveExtraFill, 0);
  p.run(400, { connected: false });
  assert.equal(p.node.underruns, 1);
  assert.equal(p.node.adaptiveExtraFill, 3_840);
});

for (const bunchMs of [100, 500]) {
  test(`playout never skips audio for ${bunchMs} ms bursts that carry no late backlog`, async () => {
    const p = await playout();
    p.run(1_000);
    // Frames arrive in bursts: bunched, but each burst only carries audio
    // produced since the last one, so nothing is stale enough to skip.
    p.run(20_000, { bunch: bunchMs / 20 });
    assert.equal(p.skips, 0);
    assert.ok(p.node.targetFill <= 48_000);
  });
}
