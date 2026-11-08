// Opus over the room relay, using the browser's WebCodecs encoder/decoder.
// Rooms switch to Opus only when every listener can decode it; anything that
// fails here falls back to PCM16, which every client supports.
import { encodeOpusFrame } from './media-relay.mjs?v=20261108-voice1';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const MAX_ENCODE_QUEUE = 25; // ~0.5 s of 20 ms frames
const MAX_DECODE_QUEUE = 50;

let supportPromise = null;

/** { decode, encode } booleans; cached. Never throws. */
export function detectOpusSupport(bitrate = 96_000) {
  if (!supportPromise) {
    supportPromise = (async () => {
      const result = { decode: false, encode: false };
      try {
        if (typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined') {
          const decoder = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
          result.decode = Boolean(decoder?.supported);
        }
      } catch {}
      try {
        if (typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
          const encoder = await AudioEncoder.isConfigSupported(encoderConfig(bitrate));
          result.encode = Boolean(encoder?.supported);
        }
      } catch {}
      return result;
    })();
  }
  return supportPromise;
}

function encoderConfig(bitrate) {
  return {
    codec: 'opus',
    sampleRate: SAMPLE_RATE,
    numberOfChannels: CHANNELS,
    bitrate,
    bitrateMode: 'variable',
    opus: { frameDuration: 20_000, complexity: 10, application: 'audio' },
  };
}

/**
 * One encoder per source epoch. push() takes 48 kHz mono Int16 frames; send()
 * receives finished relay frames with their own consecutive sequence numbers.
 */
export class OpusRelayEncoder {
  constructor({ sourceEpoch, bitrate, send, onDrop = () => {}, onFailure = () => {}, startSequence = 0 }) {
    this.sourceEpoch = sourceEpoch;
    // Continue the epoch's numbering when an encoder is recreated mid-epoch.
    this.sequence = startSequence >>> 0;
    this.timestampUs = 0;
    this.closed = false;
    this.send = send;
    this.onDrop = onDrop;
    this.onFailure = onFailure;
    this.encoder = new AudioEncoder({
      output: (chunk) => this.#output(chunk),
      error: (error) => this.#fail(error),
    });
    this.encoder.configure(encoderConfig(bitrate));
  }

  push(samples) {
    if (this.closed) return false;
    if (this.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) { this.onDrop(); return false; }
    let data;
    try {
      data = new AudioData({
        format: 's16',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: samples.length,
        numberOfChannels: CHANNELS,
        timestamp: this.timestampUs,
        data: samples,
      });
      this.timestampUs += Math.round(samples.length * 1_000_000 / SAMPLE_RATE);
      this.encoder.encode(data);
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    } finally {
      data?.close();
    }
  }

  #output(chunk) {
    if (this.closed) return;
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    let frame;
    try {
      frame = encodeOpusFrame({ sourceEpoch: this.sourceEpoch, sequence: this.sequence, payload });
    } catch {
      this.onDrop();
      return;
    }
    this.sequence = (this.sequence + 1) >>> 0;
    this.send(frame);
  }

  #fail(error) {
    if (this.closed) return;
    this.close();
    this.onFailure(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.encoder.state !== 'closed') this.encoder.close(); } catch {}
  }
}

/**
 * One decoder per source epoch. Output order matches input order, so each
 * decoded block is paired with the header of the packet that produced it.
 */
export class OpusRelayDecoder {
  constructor({ sourceEpoch, play, onFailure = () => {} }) {
    this.sourceEpoch = sourceEpoch;
    this.pending = [];
    this.closed = false;
    this.play = play;
    this.onFailure = onFailure;
    this.decoder = new AudioDecoder({
      output: (data) => this.#output(data),
      error: (error) => this.#fail(error),
    });
    this.decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
  }

  push(frame) {
    if (this.closed) return false;
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) return false;
    try {
      this.pending.push(frame);
      this.decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(frame.sequence * frame.sampleCount * 1_000_000 / SAMPLE_RATE),
        data: frame.payload,
      }));
      return true;
    } catch (error) {
      this.pending.pop();
      this.#fail(error);
      return false;
    }
  }

  #output(data) {
    try {
      const header = this.pending.shift();
      if (this.closed || !header) return;
      const count = data.numberOfFrames;
      const floats = new Float32Array(count);
      data.copyTo(floats, { planeIndex: 0, format: 'f32-planar' });
      const samples = new Int16Array(count);
      for (let index = 0; index < count; index += 1) {
        const value = Math.max(-1, Math.min(1, floats[index]));
        samples[index] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7FFF);
      }
      this.play({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        sourceEpoch: header.sourceEpoch,
        sequence: header.sequence,
        sampleCount: count,
        samples,
      });
    } finally {
      data.close();
    }
  }

  #fail(error) {
    if (this.closed) return;
    this.close();
    this.onFailure(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch {}
  }
}
