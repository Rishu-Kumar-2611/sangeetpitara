// Shared by the capture AudioWorklet and the compatibility fallback. Resampling
// phase and the last input sample survive callback boundaries (128/512/etc.).
export const RELAY_FRAME_SAMPLES = 960;
export const RELAY_SAMPLE_RATE = 48_000;

export class RelayPcmPacketizer {
  constructor() { this.reset(); }

  reset() {
    this.frame = new Int16Array(RELAY_FRAME_SAMPLES);
    this.used = 0;
    this.inputRate = null;
    this.inputIndex = 0;
    this.nextOutputNumerator = 0;
    this.previous = 0;
  }

  push(input, inputRate, onFrame) {
    if (!Number.isInteger(inputRate) || inputRate < 8_000 || inputRate > 192_000) {
      throw new RangeError('Unsupported capture sample rate.');
    }
    if (this.inputRate !== null && this.inputRate !== inputRate) this.reset();
    this.inputRate = inputRate;
    for (const raw of input) {
      const sample = Number.isFinite(raw) ? raw : 0;
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
