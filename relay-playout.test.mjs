import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const FRAME_SAMPLES = 960;
const QUANTUM = 128;

async function playout(targetDelayMs = 40) {
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
    run(ms, { connected = true, bunch = 1, produced = true } = {}) {
      const end = rendered + Math.round(ms * 48);
      while (rendered < end) {
        const groupEnd = () => (Math.floor(delivered / bunch) + 1) * bunch;
        // A paused source produces nothing, so no backlog builds up.
        if (!produced) { while ((delivered + 1) * FRAME_SAMPLES <= rendered) delivered += 1; render(); continue; }
        while (connected && groupEnd() * FRAME_SAMPLES <= rendered) {
          for (let i = delivered, last = groupEnd(); i < last; i += 1) feed();
        }
        render();
      }
    },
    flush(count) { for (let i = 0; i < count; i += 1) feed(); },
  };
}


test('playout preserves a recoverable 1.5 second TCP backlog', async () => {
  const p = await playout();
  p.run(2_000);
  p.run(1_500, { connected: false });
  p.flush(75);
  assert.equal(p.skips, 0);
  assert.ok(p.node.targetFill / 48 >= 1_500);
  p.run(3_000);
  assert.equal(p.skips, 0);
});

test('playout raises the underrun cushion once per rebuffer', async () => {
  const p = await playout();
  p.run(2_000);
  assert.equal(p.node.adaptiveExtraFill, 0);
  p.run(400, { connected: false });
  assert.equal(p.node.underruns, 1);
  assert.equal(p.node.adaptiveExtraFill, 4_800);
});

for (const bunchMs of [100, 500, 1_000]) {
  test(`automatic buffering stabilizes repeated ${bunchMs} ms network bursts`, async () => {
    const p = await playout();
    p.run(2_000);
    p.run(8_000, { bunch: bunchMs / 20 });
    const underrunsAfterLearning = p.node.underruns;
    const skipsAfterLearning = p.skips;
    p.run(15_000, { bunch: bunchMs / 20 });
    assert.equal(p.node.underruns, underrunsAfterLearning, 'must stop repeatedly rebuffering after learning the network');
    assert.equal(p.skips, skipsAfterLearning, 'must preserve delayed music after adaptation');
    assert.ok(p.node.targetFill <= 96_000);
  });
}

test('very long outages retain bounded memory and recover with fresh audio', async () => {
  const p = await playout();
  p.run(2_000);
  p.run(14_000, { connected: false });
  p.flush(700);
  assert.ok(p.skips > 0);
  assert.ok(p.node.available < 576_000);
  assert.ok(p.node.targetFill <= 96_000);
  p.run(5_000);
  assert.equal(p.node.playing, true);
});

test('a five-second delayed burst is caught up so the listener returns near live', async () => {
 const p=await playout();p.run(2000);p.run(5000,{connected:false});p.flush(250);
 // The burst is accepted (no loss at the network edge)...
 assert.equal(p.skips,0);
 // ...but a pause-length gap does not inflate the cushion past its 2 s ceiling.
 assert.ok(p.node.targetFill<=96_000);
 p.run(4000);
 assert.ok(p.node.skippedSamples>0,'stale backlog is skipped');
 assert.ok(p.node.available<=144_000,'latency returns to within 1 s of the target');
 assert.equal(p.node.playing,true);
});

test('a lasting cushion decays without deleting the delayed music', async () => {
 const p=await playout();p.run(2000);
 p.run(1500,{connected:false});p.flush(75);
 assert.ok(p.node.adaptiveExtraFill>0);
 p.run(20_000);
 assert.equal(p.node.adaptiveExtraFill,0,'cushion decays back to the base delay');
 assert.equal(p.node.skippedSamples,0,'decaying the target must not delete recovered music');
 assert.ok(p.node.available<=144_000);
});

test('small late packets do not pin a large cushion after a stall', async () => {
 // Recorded on a real phone-to-laptop session: after one 1.5 s stall the delay
 // stayed at 2 s because every later ~120 ms hiccup restarted the release wait.
 const p=await playout();p.run(2000);
 p.run(1500,{connected:false});p.flush(75);
 const afterStall=p.node.adaptiveExtraFill;
 assert.ok(afterStall>=48_000);
 for(let i=0;i<10;i+=1){p.run(120,{connected:false});p.run(1880);}
 assert.ok(p.node.adaptiveExtraFill<=Math.ceil(0.25*48_000),`cushion follows the small hiccups (${p.node.adaptiveExtraFill} samples)`);
 assert.ok(p.node.adaptiveExtraFill>=Math.floor(0.1*48_000),'but still covers them');
 assert.ok(p.node.available<=144_000);
});

test('a repeated large stall keeps its cushion while it keeps happening', async () => {
 const p=await playout();p.run(2000);
 for(let i=0;i<4;i+=1){p.run(1000,{connected:false});p.run(5000);}
 assert.ok(p.node.adaptiveExtraFill>=Math.floor(1.0*48_000),'stalls every 6 s keep a cushion that covers them');
});

test('a source pause longer than two seconds does not raise the delay', async () => {
 const p=await playout();p.run(2000);
 p.run(6000,{produced:false});
 const extra=p.node.adaptiveExtraFill;
 p.run(3000);
 assert.ok(p.node.adaptiveExtraFill<=Math.max(extra,4_800),'only the underrun cushion applies, not the pause length');
 assert.ok(p.node.targetFill<48_000);
});

test('an immediate burst above the current target is retained even before jitter adaptation', async () => {
 const p=await playout();p.flush(150);
 assert.equal(p.skips,0);assert.equal(p.node.available,150*960);assert.equal(p.node.skippedSamples,0);
});

for (const bunchMs of [40, 60, 80]) {
  test(`short ${bunchMs} ms bursts stabilize without repeated concealment`, async () => {
    const p = await playout();
    p.run(2000);
    p.run(6000, { bunch: bunchMs / 20 });
    const count = p.node.underruns;
    p.run(12000, { bunch: bunchMs / 20 });
    assert.equal(p.node.underruns, count);
    assert.equal(p.node.refilling, false);
  });
}
test('partial recovery waits for earned cushion and counts short starvation', async () => {
  const p = await playout();
  p.run(2000);
  p.run(90, { connected: false });
  assert.equal(p.node.underruns, 1);
  assert.equal(p.node.refilling, true);
  p.flush(1);
  assert.equal(p.node.refilling, true);
  p.flush(20);
  assert.equal(p.node.refilling, false);
});

test('playout bridges a repeated 1.5 s stall after learning its 25 s cadence', async () => {
  const p = await playout();
  p.run(2_000);
  for (let i = 0; i < 2; i++) {
    p.run(1_500, { connected: false });
    p.run(23_500);
  }
  const underruns = p.node.underruns;
  const skipped = p.node.skippedSamples;
  p.run(1_500, { connected: false });
  p.run(2_000);
  assert.equal(p.node.underruns, underruns, 'the learned buffer must span the third stall');
  assert.equal(p.node.skippedSamples, skipped, 'no music is dropped after the cadence is learned');
  assert.equal(p.node.playing, true);
});

test('recorded one-second catch-up cutoff is preserved during a target reduction', async () => {
  const p = await playout();
  p.run(2_000);
  p.flush(60); // A delayed 1.2 s delivery, still safely inside the recovery bound.
  const skipped = p.node.skippedSamples;
  p.node.port.onmessage({ data: { type: 'config', targetDelayMs: 40 } });
  p.run(20_000);
  assert.equal(p.node.skippedSamples, skipped, 'a falling target must never cause the recorded ~1.1 s skip');
  assert.equal(p.node.playing, true);
});
