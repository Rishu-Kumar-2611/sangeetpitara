import { RelayPcmPacketizer } from './relay-pcm.js?v=20261021-playback-4';

// This processor only captures playback already selected by getDisplayMedia.
// No microphone, filters, AGC, timers, or local echo are introduced here.
class RelayCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packetizer = new RelayPcmPacketizer();
    this.epoch = null;
    this.sequence = 0;
    this.inFlight = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'ack') this.inFlight = Math.max(0, this.inFlight - 1);
      if (data?.type === 'stop') this.stopped = true;
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
    const input = inputs[0]?.[0]; // Node is configured to downmix to mono.
    if (this.epoch === null || !input?.length) return true;
    this.packetizer.push(input, sampleRate, (samples) => {
      const sequence = this.sequence;
      this.sequence = (sequence + 1) >>> 0;
      // Backpressure also bounds messages when the page's main thread stalls.
      if (this.inFlight >= 8) return;
      this.inFlight += 1;
      this.port.postMessage({
        samples, sequence, sourceEpoch: this.epoch, capturedAt: currentTime,
      }, [samples.buffer]);
    });
    return true;
  }
}

registerProcessor('roomsound-relay-capture', RelayCaptureProcessor);
