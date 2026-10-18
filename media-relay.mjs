/**
 * RoomSound's browser media relay wire format.
 *
 * The server forwards the encoded bytes without changing them. Keep the
 * validation here deliberately strict because this module is shared by the
 * browser client, the Node server, and the protocol regression tests.
 */
export const MEDIA_RELAY_MAGIC_BYTES = Uint8Array.from([0x52, 0x53, 0x52, 0x31]); // RSR1
export const MEDIA_RELAY_VERSION = 1;
export const MEDIA_RELAY_HEADER_BYTES = 20;
export const MEDIA_RELAY_SAMPLE_RATE = 48_000;
export const MEDIA_RELAY_CHANNELS = 1;
export const MEDIA_RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;
export const MEDIA_RELAY_MAX_FRAME_BYTES = MEDIA_RELAY_HEADER_BYTES + MEDIA_RELAY_MAX_PAYLOAD_BYTES;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Media relay frame must be an ArrayBuffer or byte view.');
}

function invalidFrame(message, code = 'INVALID_MEDIA_FRAME') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertUint32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
    throw invalidFrame(`${name} must be an unsigned 32-bit integer.`, `INVALID_${name.toUpperCase()}`);
  }
}

/**
 * Encode signed PCM16 samples as one relay frame.
 *
 * Int16Array is accepted for the browser packetizer and tests. Samples are
 * written through DataView so the wire representation is little-endian even
 * on a hypothetical big-endian JavaScript runtime.
 */
export function encodePcm16Frame({ sourceEpoch, sequence, samples }) {
  assertUint32(sourceEpoch, 'sourceEpoch');
  assertUint32(sequence, 'sequence');
  if (!(samples instanceof Int16Array)) {
    throw invalidFrame('PCM16 samples must be an Int16Array.', 'INVALID_SAMPLES');
  }
  const sampleCount = samples.length;
  if (sampleCount <= 0 || sampleCount > 0xFFFF) {
    throw invalidFrame('PCM16 sampleCount must be between 1 and 65535.', 'INVALID_SAMPLE_COUNT');
  }
  const payloadBytes = sampleCount * 2;
  if (payloadBytes > MEDIA_RELAY_MAX_PAYLOAD_BYTES) {
    throw invalidFrame('PCM16 payload is too large.', 'MEDIA_FRAME_TOO_LARGE');
  }

  const frame = new Uint8Array(MEDIA_RELAY_HEADER_BYTES + payloadBytes);
  frame.set(MEDIA_RELAY_MAGIC_BYTES, 0);
  frame[4] = MEDIA_RELAY_VERSION;
  frame[5] = MEDIA_RELAY_CHANNELS;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(6, MEDIA_RELAY_SAMPLE_RATE, true);
  view.setUint32(10, sourceEpoch, true);
  view.setUint32(14, sequence, true);
  view.setUint16(18, sampleCount, true);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(MEDIA_RELAY_HEADER_BYTES + index * 2, samples[index], true);
  }
  return frame;
}

/**
 * Validate and decode one frame. The returned `bytes` is a copy suitable for
 * forwarding or retaining after the caller's WebSocket buffer is released.
 */
export function decodePcm16Frame(input, { maxPayloadBytes = MEDIA_RELAY_MAX_PAYLOAD_BYTES } = {}) {
  const bytes = asBytes(input);
  if (bytes.byteLength < MEDIA_RELAY_HEADER_BYTES) {
    throw invalidFrame('Media relay frame is shorter than its header.', 'MEDIA_FRAME_TOO_SHORT');
  }
  if (bytes.byteLength > MEDIA_RELAY_HEADER_BYTES + maxPayloadBytes) {
    throw invalidFrame('Media relay frame is too large.', 'MEDIA_FRAME_TOO_LARGE');
  }

  for (let index = 0; index < MEDIA_RELAY_MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== MEDIA_RELAY_MAGIC_BYTES[index]) {
      throw invalidFrame('Media relay frame has an invalid magic header.', 'MEDIA_FRAME_BAD_MAGIC');
    }
  }
  if (bytes[4] !== MEDIA_RELAY_VERSION) {
    throw invalidFrame('Media relay frame has an unsupported version.', 'MEDIA_FRAME_BAD_VERSION');
  }
  if (bytes[5] !== MEDIA_RELAY_CHANNELS) {
    throw invalidFrame('Media relay frame must contain one channel.', 'MEDIA_FRAME_BAD_CHANNELS');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(6, true);
  if (sampleRate !== MEDIA_RELAY_SAMPLE_RATE) {
    throw invalidFrame('Media relay frame must use a 48000 Hz sample rate.', 'MEDIA_FRAME_BAD_SAMPLE_RATE');
  }
  const sourceEpoch = view.getUint32(10, true);
  const sequence = view.getUint32(14, true);
  const sampleCount = view.getUint16(18, true);
  if (sampleCount <= 0) {
    throw invalidFrame('Media relay frame must contain at least one sample.', 'MEDIA_FRAME_EMPTY');
  }

  const payloadBytes = bytes.byteLength - MEDIA_RELAY_HEADER_BYTES;
  if (payloadBytes !== sampleCount * 2) {
    throw invalidFrame('Media relay PCM16 payload length does not match sampleCount.', 'MEDIA_FRAME_BAD_LENGTH');
  }
  if (payloadBytes > maxPayloadBytes) {
    throw invalidFrame('Media relay PCM16 payload is too large.', 'MEDIA_FRAME_TOO_LARGE');
  }

  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(MEDIA_RELAY_HEADER_BYTES + index * 2, true);
  }
  return {
    bytes: bytes.slice(),
    sampleRate,
    channels: MEDIA_RELAY_CHANNELS,
    sourceEpoch,
    sequence,
    sampleCount,
    payload: bytes.slice(MEDIA_RELAY_HEADER_BYTES),
    samples,
  };
}
