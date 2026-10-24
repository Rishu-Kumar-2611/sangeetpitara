// Shared by the capture AudioWorklet and the compatibility fallback. Resampling
// phase, cubic history, and the last input sample survive callback boundaries.
export const RELAY_FRAME_SAMPLES = 960;
export const RELAY_SAMPLE_RATE = 48_000;

// A slow, monopolar-gated DC/infrasonic cleanup. It tracks zero-crossings so
// oscillatory program audio (including heavy sub-bass in music) never opens the
// gate; it only engages after sustained unidirectional DC offset is detected.
export class RelayPcmClarityFilter {
  static ALPHA = 0.0001;
  static ENABLE_THRESHOLD = 0.04;
  static DISABLE_THRESHOLD = 0.015;
  static MIN_SAMPLES = 4_800;

  constructor() { this.reset(); }

  reset() {
    this.bias = 0;
    this.processedSamples = 0;
    this.monopolarSamples = 0;
    this.lastSign = 0;
    this.enabled = false;
    this.correctionGain = 0;
  }

  process(raw) {
    const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    const sign = sample > 1e-5 ? 1 : sample < -1e-5 ? -1 : 0;
    if (sign !== 0 && this.lastSign !== 0 && sign !== this.lastSign) {
      // Zero-crossing detected: this is AC program audio/music, not DC bias.
      this.monopolarSamples = 0;
    } else {
      this.monopolarSamples += 1;
    }
    if (sign !== 0) this.lastSign = sign;

    this.bias += RelayPcmClarityFilter.ALPHA * (sample - this.bias);
    this.processedSamples += 1;
    if (
      !this.enabled
      && this.processedSamples >= RelayPcmClarityFilter.MIN_SAMPLES
      && this.monopolarSamples >= RelayPcmClarityFilter.MIN_SAMPLES
      && Math.abs(this.bias) >= RelayPcmClarityFilter.ENABLE_THRESHOLD
    ) {
      this.enabled = true;
    } else if (
      this.enabled
      && (Math.abs(this.bias) <= RelayPcmClarityFilter.DISABLE_THRESHOLD || this.monopolarSamples === 0)
    ) {
      this.enabled = false;
    }
    this.correctionGain = this.enabled
      ? Math.min(1, this.correctionGain + 0.0005)
      : Math.max(0, this.correctionGain - 0.0005);
    return Math.max(-1, Math.min(1, sample - this.bias * this.correctionGain));
  }
}

// Phase-safe stereo-to-mono downmixer that preserves out-of-phase stereo width
// components instead of letting (L + R) * 0.5 cancel wide-panned instruments.
export function mixStereoToMonoPhaseSafe(left, right) {
  const l = Number.isFinite(left) ? Math.max(-1, Math.min(1, left)) : 0;
  const r = Number.isFinite(right) ? Math.max(-1, Math.min(1, right)) : 0;
  const mid = 0.5 * (l + r);
  const side = 0.5 * (l - r);
  // Blend Mid with attenuated Side so anti-phase stereo instruments remain audible.
  return Math.max(-1, Math.min(1, mid + 0.25 * side));
}

export class RelayPcmPacketizer {
  constructor() { this.reset(); }

  reset() {
    this.frame = new Int16Array(RELAY_FRAME_SAMPLES);
    this.used = 0;
    this.inputRate = null;
    this.inputIndex = 0;
    this.nextOutputNumerator = 0;
    this.previous = 0;
    this.clarity = new RelayPcmClarityFilter();
  }

  push(input, inputRate, onFrame) {
    if (!Number.isInteger(inputRate) || inputRate < 8_000 || inputRate > 192_000) {
      throw new RangeError('Unsupported capture sample rate.');
    }
    if (this.inputRate !== null && this.inputRate !== inputRate) this.reset();
    this.inputRate = inputRate;
    for (const raw of input) {
      const sample = this.clarity.process(raw);
      const index = this.inputIndex++;
      // Integer phase arithmetic prevents per-callback rounding loss at 44.1 kHz.
      while (this.nextOutputNumerator <= index * RELAY_SAMPLE_RATE) {
        const fraction = index === 0 ? 1
          : (this.nextOutputNumerator - (index - 1) * RELAY_SAMPLE_RATE) / RELAY_SAMPLE_RATE;
        const value = Math.max(-1, Math.min(1, this.previous + (sample - this.previous) * fraction));
        this.frame[this.used++] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7FFF);
        this.nextOutputNumerator += inputRate;
        if (this.used === RELAY_FRAME_SAMPLES) {
          const completed = this.frame;
          this.frame = new Int16Array(RELAY_FRAME_SAMPLES);
          this.used = 0;
          onFrame(completed);
        }
      }
      this.previous = sample;
    }
  }
}
