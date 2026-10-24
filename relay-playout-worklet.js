// Dedicated AudioWorklet playout ring buffer with Proportional-Integral (PI)
// hardware clock-drift compensation, 4-point Hermite cubic interpolation,
// raised-cosine startup fade-in, and smooth underrun concealment.
const CAPACITY_SAMPLES = 48_000; // 1000 ms ring buffer capacity at 48 kHz
const DEFAULT_TARGET_FILL = 5_760; // 120 ms target jitter cushion
const MIN_PREFILL_SAMPLES = 3_840; // 80 ms initial prefill before starting playout
const FADE_SAMPLES = 240; // 5 ms cosine fade-in / fade-out

class RelayPlayoutProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY_SAMPLES);
    this.right = new Float32Array(CAPACITY_SAMPLES);
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.playing = false;
    this.fadeProgress = 0;
    this.targetFill = DEFAULT_TARGET_FILL;
    this.avgFill = DEFAULT_TARGET_FILL;
    this.lastL = 0;
    this.lastR = 0;
    this.underruns = 0;
    this.framesPlayed = 0;
    this.reportCountdown = 0;

    this.port.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'reset') {
        this.resetBuffer();
        return;
      }
      if (data.type === 'config') {
        if (Number.isFinite(data.targetDelayMs)) {
          const clampedMs = Math.max(40, Math.min(600, Number(data.targetDelayMs)));
          this.targetFill = Math.round((clampedMs / 1000) * 48_000);
        }
        return;
      }
      if (data.type === 'pcm' && data.samples instanceof Int16Array) {
        this.enqueuePcm16(data.samples, data.channels || 1);
      }
    };
  }

  resetBuffer() {
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.playing = false;
    this.fadeProgress = 0;
    this.avgFill = this.targetFill;
  }

  enqueuePcm16(int16Samples, channels) {
    const ch = channels === 2 ? 2 : 1;
    const frameCount = Math.floor(int16Samples.length / ch);
    if (frameCount <= 0) return;

    if (this.available + frameCount > CAPACITY_SAMPLES - 8) {
      // Smoothly advance read pointer to keep newest audio if buffer ever overflows.
      const overflow = (this.available + frameCount) - (CAPACITY_SAMPLES - 8);
      this.readPos = (this.readPos + overflow) % CAPACITY_SAMPLES;
      this.available = Math.max(0, this.available - overflow);
    }

    for (let i = 0; i < frameCount; i += 1) {
      const w = (this.writePos + i) % CAPACITY_SAMPLES;
      if (ch === 2) {
        this.left[w] = int16Samples[i * 2] / 0x8000;
        this.right[w] = int16Samples[i * 2 + 1] / 0x8000;
      } else {
        const s = int16Samples[i] / 0x8000;
        this.left[w] = s;
        this.right[w] = s;
      }
    }
    this.writePos = (this.writePos + frameCount) % CAPACITY_SAMPLES;
    this.available += frameCount;

    const requiredPrefill = Math.max(MIN_PREFILL_SAMPLES, Math.min(this.targetFill, 9_600));
    if (!this.playing && this.available >= requiredPrefill) {
      this.playing = true;
      this.fadeProgress = 0;
      this.avgFill = this.available;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const outL = output[0];
    const outR = output[1] || outL;
    const blockLength = outL.length;

    if (!this.playing || this.available < 4) {
      if (this.playing) {
        this.playing = false;
        this.underruns += 1;
      }
      // Smooth exponential decay to zero instead of a hard step discontinuity.
      for (let i = 0; i < blockLength; i += 1) {
        this.lastL *= 0.965;
        this.lastR *= 0.965;
        if (Math.abs(this.lastL) < 1e-6) this.lastL = 0;
        if (Math.abs(this.lastR) < 1e-6) this.lastR = 0;
        outL[i] = this.lastL;
        if (outR !== outL) outR[i] = this.lastR;
      }
      this.reportTelemetry(blockLength);
      return true;
    }

    // Continuous PI-style clock-drift and jitter-cushion controller.
    // Adjusts playback rate within [0.997, 1.003] (+/- 0.3%, imperceptible in pitch)
    // so hardware clock drift and TCP bursts never require flushing the queue.
    this.avgFill = 0.992 * this.avgFill + 0.008 * this.available;
    const fillErrorSeconds = (this.avgFill - this.targetFill) / 48_000;
    const rate = Math.max(0.997, Math.min(1.003, 1.0 + fillErrorSeconds * 0.012));

    for (let i = 0; i < blockLength; i += 1) {
      if (this.available < 4) {
        this.playing = false;
        this.underruns += 1;
        this.lastL *= 0.965;
        this.lastR *= 0.965;
        outL[i] = this.lastL;
        if (outR !== outL) outR[i] = this.lastR;
        continue;
      }

      const base = Math.floor(this.readPos);
      const frac = this.readPos - base;
      const i0 = (base - 1 + CAPACITY_SAMPLES) % CAPACITY_SAMPLES;
      const i1 = base % CAPACITY_SAMPLES;
      const i2 = (base + 1) % CAPACITY_SAMPLES;
      const i3 = (base + 2) % CAPACITY_SAMPLES;

      // 4-point Catmull-Rom / Hermite cubic interpolation for flat treble response.
      const l0 = this.left[i0], l1 = this.left[i1], l2 = this.left[i2], l3 = this.left[i3];
      const lc1 = 0.5 * (l2 - l0);
      const lc2 = l0 - 2.5 * l1 + 2.0 * l2 - 0.5 * l3;
      const lc3 = 0.5 * (l3 - l0) + 1.5 * (l1 - l2);
      let sampleL = ((lc3 * frac + lc2) * frac + lc1) * frac + l1;

      let sampleR = sampleL;
      if (outR !== outL) {
        const r0 = this.right[i0], r1 = this.right[i1], r2 = this.right[i2], r3 = this.right[i3];
        const rc1 = 0.5 * (r2 - r0);
        const rc2 = r0 - 2.5 * r1 + 2.0 * r2 - 0.5 * r3;
        const rc3 = 0.5 * (r3 - r0) + 1.5 * (r1 - r2);
        sampleR = ((rc3 * frac + rc2) * frac + rc1) * frac + r1;
      }

      if (this.fadeProgress < FADE_SAMPLES) {
        const gain = 0.5 * (1 - Math.cos(Math.PI * (this.fadeProgress / FADE_SAMPLES)));
        sampleL = this.lastL * (1 - gain) + sampleL * gain;
        sampleR = this.lastR * (1 - gain) + sampleR * gain;
        this.fadeProgress += 1;
      }

      this.lastL = Math.max(-1, Math.min(1, sampleL));
      this.lastR = Math.max(-1, Math.min(1, sampleR));
      outL[i] = this.lastL;
      if (outR !== outL) outR[i] = this.lastR;

      this.readPos = (this.readPos + rate) % CAPACITY_SAMPLES;
      this.available = Math.max(0, this.available - rate);
    }

    this.framesPlayed += 1;
    this.reportTelemetry(blockLength);
    return true;
  }

  reportTelemetry(blockLength) {
    this.reportCountdown += blockLength;
    if (this.reportCountdown >= 12_000) { // Report every ~250 ms
      this.reportCountdown = 0;
      this.port.postMessage({
        type: 'stats',
        bufferedMs: Math.round((this.available / 48_000) * 1000),
        targetMs: Math.round((this.targetFill / 48_000) * 1000),
        underruns: this.underruns,
        playing: this.playing,
      });
    }
  }
}

registerProcessor('roomsound-relay-playout', RelayPlayoutProcessor);
