// Deterministic execution of the actual browser AudioWorklet. Network delay is
// simulated; these numbers exclude device/DAC/Bluetooth/capture hardware delay.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

function measure(source, delayMs, burstMs = 20) {
  let Processor;
  const scope = vm.createContext({ Int16Array, Float32Array, currentTime: 0,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } },
    registerProcessor: (_, value) => { Processor = value; },
  });
  vm.runInContext(source, scope);
  const player = new Processor();
  player.port.onmessage({ data: { type: 'config', targetDelayMs: delayMs } });
  const output = [new Float32Array(128), new Float32Array(128)];
  const ages = [];
  let delivered = 0, firstAudioMs = null, trims = 0;
  for (let rendered = 0; rendered < 48_000 * 6; rendered += 128) {
    const nowMs = rendered / 48;
    scope.currentTime = nowMs / 1000;
    // 40 ms total one-way relay/network delay; TCP bursts release only frames
    // already produced. Unlike a prefilled test, future audio never arrives early.
    const availableThrough = Math.floor((nowMs - 40) / burstMs) * burstMs;
    while ((delivered + 1) * 20 <= availableThrough) {
      const before = player.available;
      player.port.onmessage({ data: { type: 'pcm', samples: new Int16Array(960).fill(1000 + delivered * 64), channels: 1 } });
      if (player.available < before + 959) trims++;
      delivered++;
    }
    player.process([], [output]);
    for (let i = 0; i < 128; i++) {
      const sample = output[0][i] * 32768;
      const sampleTime = (rendered + i) / 48;
      if (sample > 500 && firstAudioMs === null) firstAudioMs = sampleTime;
      if (nowMs > 1000 && player.playing && sample > 1000) {
        const packet = Math.round((sample - 1000) / 64);
        ages.push(sampleTime - packet * 20);
      }
    }
  }
  ages.sort((a, b) => a - b);
  return { firstAudioMs: Math.round(firstAudioMs), medianAudioAgeMs: Math.round(ages[Math.floor(ages.length * .5)]),
    p95AudioAgeMs: Math.round(ages[Math.floor(ages.length * .95)]), underruns: player.underruns, trims };
}

const oldSource = process.argv.includes('--current-only') ? null
  : execFileSync('git', ['show', '4442c03:relay-playout-worklet.js'], { encoding: 'utf8' });
const source = await readFile(new URL('../relay-playout-worklet.js', import.meta.url), 'utf8');
const results = { note: 'Simulated 40 ms network path; worklet-only measurements, not acoustic/device latency.',
  previous: oldSource ? measure(oldSource, 150) : null, current: measure(source, 40), burst100ms: measure(source, 40, 100) };
if (process.argv.includes('--check')) {
  if (results.previous) assert.ok(results.current.medianAudioAgeMs < results.previous.medianAudioAgeMs - 80);
  assert.ok(results.current.p95AudioAgeMs < 140);
  assert.equal(results.current.underruns, 0);
}
await writeFile(new URL('../latency-benchmark-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
