// Dedicated AudioWorklet playout ring buffer with Adaptive WAN Jitter Cushion,
// Proportional-Integral (PI) hardware clock-drift compensation, 4-point Hermite
// cubic interpolation, raised-cosine crossfading, and short loop-based Packet
// Loss Concealment (PLC) for long-distance (500–10,000+ km) streaming.
const DEFAULT_TARGET_FILL = 7_200; // 150 ms base cushion; the jitter estimate and underrun cushion add to it
const MAX_TARGET_FILL = 48_000; // 1,000 ms ceiling on the automatic target
const MIN_PREFILL_SAMPLES = 9_600; // 200 ms initial prefill before starting playout
const EXCESS_HEADROOM_SAMPLES = 19_200; // Skip ahead once a backlog sits 400 ms above target...
const CATCH_UP_LANDING_SAMPLES = 2_400; // ...landing 50 ms above target, so a stall never leaves lasting delay
// 2.0 s ring: holds the 1.4 s ceiling plus one maximum-size (64 KiB, ~680 ms) frame.
const CAPACITY_SAMPLES = 96_000;
const FADE_SAMPLES = 960; // 20 ms cosine fade-in / crossfade for inaudible transitions
const PLC_HOLD_SAMPLES = 4_800; // Up to 100 ms of looped waveform continuation before silence decay
const PLC_PERIOD_SAMPLES = 480; // Fixed 10 ms loop of the most recent audio

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
    this.baseTargetFill = DEFAULT_TARGET_FILL;
    this.adaptiveExtraFill = 0;
    this.targetFill = DEFAULT_TARGET_FILL;
    this.avgFill = DEFAULT_TARGET_FILL;
    this.lastL = 0;
    this.lastR = 0;
    this.underruns = 0;
    this.concealedSamples = 0;
    this.framesPlayed = 0;
    this.reportCountdown = 0;
    this.lastEnqueueTime = null;
    this.jitterSeconds = 0.015; // EWMA inter-arrival jitter estimate
    this._smoothedRate = 1.0;

    this.port.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'reset') {
        this.resetBuffer();
        return;
      }
      if (data.type === 'config') {
        if (Number.isFinite(data.targetDelayMs)) {
          const clampedMs = Math.max(60, Math.min(MAX_TARGET_FILL / 48, Number(data.targetDelayMs)));
          this.baseTargetFill = Math.round((clampedMs / 1000) * 48_000);
          this.updateTargetFill();
        }
        return;
      }
      if (data.type === 'pcm' && data.samples instanceof Int16Array) {
        this.enqueuePcm16(data.samples, data.channels || 1);
      }
    };
  }

  updateTargetFill() {
    // Combine user slider base delay + RFC 3550 jitter margin (3.5x jitter) + underrun auto-cushion
    const jitterSamples = Math.round(Math.min(0.60, this.jitterSeconds * 3.5) * 48_000);
    const desired = this.baseTargetFill + jitterSamples + this.adaptiveExtraFill;
    this.targetFill = Math.max(2_880, Math.min(MAX_TARGET_FILL, desired)); // Clamp between 60 ms and 1,000 ms
  }

  resetBuffer() {
    this.writePos = 0;
    this.readPos = 0;
    this.available = 0;
    this.playing = false;
    this.fadeProgress = 0;
    this.concealedSamples = 0;
    this.adaptiveExtraFill = 0;
    this.lastEnqueueTime = null;
    this.jitterSeconds = 0.015;
    this.updateTargetFill();
    this.avgFill = this.targetFill;
  }

  enqueuePcm16(int16Samples, channels) {
    const ch = channels === 2 ? 2 : 1;
    const frameCount = Math.floor(int16Samples.length / ch);
    if (frameCount <= 0) return;

    // Measure RFC 3550 inter-arrival jitter using the audio thread's high-precision clock
    const now = currentTime;
    const expectedInterval = frameCount / 48_000;
    if (this.lastEnqueueTime !== null) {
      const actualInterval = Math.max(0, now - this.lastEnqueueTime);
      const deviation = Math.abs(actualInterval - expectedInterval);
      // Ignore multi-second pauses (e.g., track change), track WAN burst jitter up to 1.5s
      if (deviation < 1.5) {
        this.jitterSeconds += (deviation - this.jitterSeconds) * 0.0625;
      }
    }
    this.lastEnqueueTime = now;
    this.updateTargetFill();

    // Excess-latency ceiling. Normal jitter stays inside targetFill, so a backlog
    // more than 400 ms above it is audio that a stall already made late. The PI
    // controller below can only remove ~5 ms/s, so skip it with a crossfade instead
    // of playing seconds-old audio for minutes.
    const maxAllowedSamples = Math.min(CAPACITY_SAMPLES - 16, this.targetFill + EXCESS_HEADROOM_SAMPLES);
    if (this.available + frameCount > maxAllowedSamples) {
      // Never skip past buffered audio: an oversized frame would otherwise move
      // readPos beyond writePos and play stale ring contents.
      const dropSamples = Math.min(this.available, (this.available + frameCount) - (this.targetFill + CATCH_UP_LANDING_SAMPLES));
      if (dropSamples > 0) {
        this.readPos = (this.readPos + dropSamples) % CAPACITY_SAMPLES;
        this.available -= dropSamples;
        this.fadeProgress = 0;
      }
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

    const requiredPrefill = Math.max(MIN_PREFILL_SAMPLES, Math.min(this.targetFill, 38_400));
    if (!this.playing && this.available >= requiredPrefill) {
      this.playing = true;
      this.fadeProgress = 0;
      this.concealedSamples = 0;
      this.avgFill = this.available;
    } else if (this.playing && this.concealedSamples > 0) {
      // Smoothly crossfade back from PLC concealment into newly arrived live samples
      this.concealedSamples = 0;
      this.fadeProgress = 0;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const outL = output[0];
    const outR = output[1] || outL;
    const blockLength = outL.length;

    if (!this.playing) {
      for (let i = 0; i < blockLength; i += 1) {
        this.lastL *= 0.985;
        this.lastR *= 0.985;
        if (Math.abs(this.lastL) < 1e-6) this.lastL = 0;
        if (Math.abs(this.lastR) < 1e-6) this.lastR = 0;
        outL[i] = this.lastL;
        if (outR !== outL) outR[i] = this.lastR;
      }
      this.reportTelemetry(blockLength);
      return true;
    }

    // Slowly decay adaptive extra cushion during stable playback (~2.5 ms/sec)
    if (this.adaptiveExtraFill > 0 && this.available > this.targetFill * 0.75) {
      this.adaptiveExtraFill = Math.max(0, this.adaptiveExtraFill - 0.32);
      this.updateTargetFill();
    }

    // Gentle PI clock-drift & WAN buffer controller with deadband around targetFill.
    // Keeps pitch rock-steady while smoothly absorbing 500+ km network bursts.
    this.avgFill = 0.992 * this.avgFill + 0.008 * this.available;
    const fillErrorMs = (this.avgFill - this.targetFill) / 48;
    let rateTarget = 1.0;
    if (Math.abs(fillErrorMs) > 35) {
      const effectiveErrorSeconds = (fillErrorMs - Math.sign(fillErrorMs) * 35) / 1000;
      rateTarget = Math.max(0.996, Math.min(1.005, 1.0 + effectiveErrorSeconds * 0.0045));
    }
    this._smoothedRate = 0.96 * this._smoothedRate + 0.04 * rateTarget;
    const rate = this._smoothedRate;

    for (let i = 0; i < blockLength; i += 1) {
      if (this.available < 4) {
        if (!this.playing) {
          // Rebuffering began earlier in this block: decay the tail without
          // re-entering PLC, which would bump the cushion a second time.
          this.lastL *= 0.985;
          this.lastR *= 0.985;
          outL[i] = this.lastL;
          if (outR !== outL) outR[i] = this.lastR;
          continue;
        }
        // Packet Loss Concealment (PLC): instead of immediately dropping out during a
        // brief WAN stall, smoothly replay the last 10 ms of audio with a gentle
        // cosine attenuation envelope for up to 100 ms before entering rebuffering.
        if (this.concealedSamples === 0) {
          // Step up adaptive cushion by +80 ms (3,840 samples) so the next cycle won't underrun
          this.adaptiveExtraFill = Math.min(38_400, this.adaptiveExtraFill + 3_840);
          this.updateTargetFill();
        }
        if (this.concealedSamples < PLC_HOLD_SAMPLES) {
          const plcIndex = (Math.floor(this.readPos) - PLC_PERIOD_SAMPLES + (this.concealedSamples % PLC_PERIOD_SAMPLES) + CAPACITY_SAMPLES) % CAPACITY_SAMPLES;
          const attenuation = Math.cos((this.concealedSamples / PLC_HOLD_SAMPLES) * (Math.PI * 0.5)) * 0.92;
          this.lastL = this.lastL * 0.25 + (this.left[plcIndex] * attenuation) * 0.75;
          this.lastR = this.lastR * 0.25 + (this.right[plcIndex] * attenuation) * 0.75;
          this.concealedSamples += 1;
          outL[i] = this.lastL;
          if (outR !== outL) outR[i] = this.lastR;
          continue;
        }
        // Stall exceeded 100 ms: pause playout and wait for clean prefill cushion
        this.playing = false;
        this.underruns += 1;
        this.concealedSamples = 0;
        this.lastL *= 0.985;
        this.lastR *= 0.985;
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
        jitterMs: Math.round(this.jitterSeconds * 1000),
        underruns: this.underruns,
        playing: this.playing,
      });
    }
  }
}

registerProcessor('roomsound-relay-playout', RelayPlayoutProcessor);
