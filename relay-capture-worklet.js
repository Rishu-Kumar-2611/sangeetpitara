import { RelayPcmPacketizer } from './relay-pcm.js?v=20261024-prod';

// This processor only captures playback already selected by getDisplayMedia or
// the in-app audio file player. No microphone, AGC, timers, or local echo are
// introduced here. When two stereo channels are supplied, it performs a
// phase-safe Mid/Side blend so wide-panned stereo instruments do not cancel.
class RelayCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packetizer = new RelayPcmPacketizer();
    this.epoch = null;
    this.sequence = 0;
    this.inFlight = 0;
    this.maxInFlight = 8;
    this.stopped = false;
    this.monoScratch = null;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.inFlight = Math.max(0, this.inFlight - 1);
      if (data?.type === 'stop') this.stopped = true;
      if (data?.type === 'config' && Number.isInteger(data.maxInFlight) && data.maxInFlight >= 8) {
        this.maxInFlight = Math.min(64, data.maxInFlight);
      }
      if (data?.type === 'lease' && data.epoch !== this.epoch) {
        this.epoch = Number.isInteger(data.epoch) ? data.epoch : null;
        this.sequence = 0;
        this.packetizer.reset();
      }
    };
  }

  process(inputs, outputs) {
    // The muted sink keeps the processing graph pulled, not locally audible.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const ch0 = inputs[0]?.[0];
    if (this.epoch === null || !ch0?.length) return true;
    const ch1 = inputs[0]?.[1];
    let monoInput = ch0;
    if (ch1 && ch1.length === ch0.length) {
      if (!this.monoScratch || this.monoScratch.length !== ch0.length) {
        this.monoScratch = new Float32Array(ch0.length);
      }
      for (let i = 0; i < ch0.length; i += 1) {
        const l = ch0[i];
        const r = ch1[i];
        const mid = 0.5 * (l + r);
        const side = 0.5 * (l - r);
        this.monoScratch[i] = Math.max(-1, Math.min(1, mid + 0.25 * side));
      }
      monoInput = this.monoScratch;
    }
    this.packetizer.push(monoInput, sampleRate, (samples) => {
      const sequence = this.sequence;
      this.sequence = (sequence + 1) >>> 0;
      // Backpressure also bounds messages when the page's main thread stalls.
      if (this.inFlight >= this.maxInFlight) return;
      this.inFlight += 1;
      this.port.postMessage({
        samples, sequence, sourceEpoch: this.epoch, capturedAt: currentTime,
      }, [samples.buffer]);
    });
    return true;
  }
}

registerProcessor('roomsound-relay-capture', RelayCaptureProcessor);
