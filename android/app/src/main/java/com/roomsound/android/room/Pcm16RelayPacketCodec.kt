package com.roomsound.android.room

import okio.ByteString
import okio.ByteString.Companion.toByteString

/** A validated RSR1 PCM16 relay packet. All unsigned wire values use Long. */
data class Pcm16RelayPacket(
    val sampleRate: Int,
    val channels: Int,
    val sourceEpoch: Long,
    val sequence: Long,
    val sampleCount: Int,
    val payload: ByteArray,
    val samples: ShortArray,
)

/**
 * Bounded codec for the RoomSound no-TURN media relay.
 *
 * Wire layout (little endian): RSR1 magic, version, channels, sample rate,
 * source epoch, sequence, sample count, then signed PCM16 mono samples.
 */
object Pcm16RelayPacketCodec {
    const val HEADER_BYTES = 20
    const val VERSION = 1
    const val CHANNELS = 1
    const val SAMPLE_RATE = 48_000
    const val MAX_PAYLOAD_BYTES = 64 * 1024
    const val MAX_FRAME_BYTES = HEADER_BYTES + MAX_PAYLOAD_BYTES
    /** Largest frame emitted by the current browser or Android publishers. */
    const val MAX_PLAYOUT_PAYLOAD_BYTES = 960 * 2
    const val UINT32_MAX = 0xFFFF_FFFFL

    private const val UINT16_MAX = 0xFFFF
    private const val BYTES_PER_SAMPLE = 2
    private val MAGIC = byteArrayOf(0x52, 0x53, 0x52, 0x31)

    /** Encode at most one bounded PCM frame. The input array is never mutated. */
    fun encode(
        samples: ShortArray,
        sampleCount: Int = samples.size,
        sampleRate: Int = SAMPLE_RATE,
        channels: Int = CHANNELS,
        sourceEpoch: Long,
        sequence: Long,
    ): ByteArray {
        require(sampleRate == SAMPLE_RATE) {
            "PCM16 relay sample rate must be $SAMPLE_RATE Hz."
        }
        require(channels == CHANNELS) { "PCM16 relay must contain one channel." }
        require(sourceEpoch in 0..UINT32_MAX) { "sourceEpoch must be an unsigned 32-bit integer." }
        require(sequence in 0..UINT32_MAX) { "sequence must be an unsigned 32-bit integer." }
        require(sampleCount in 1..samples.size) {
            "sampleCount must be between 1 and the supplied sample array size."
        }
        require(sampleCount <= UINT16_MAX) { "sampleCount must fit in an unsigned 16-bit integer." }
        val payloadBytes = sampleCount * BYTES_PER_SAMPLE
        require(payloadBytes <= MAX_PAYLOAD_BYTES) {
            "PCM16 relay payload is too large."
        }

        val frame = ByteArray(HEADER_BYTES + payloadBytes)
        MAGIC.copyInto(frame, destinationOffset = 0)
        frame[4] = VERSION.toByte()
        frame[5] = channels.toByte()
        putUint32(frame, 6, sampleRate.toLong())
        putUint32(frame, 10, sourceEpoch)
        putUint32(frame, 14, sequence)
        putUint16(frame, 18, sampleCount)
        repeat(sampleCount) { index ->
            putInt16(frame, HEADER_BYTES + index * BYTES_PER_SAMPLE, samples[index])
        }
        return frame
    }

    fun encodeByteString(
        samples: ShortArray,
        sampleCount: Int = samples.size,
        sampleRate: Int = SAMPLE_RATE,
        channels: Int = CHANNELS,
        sourceEpoch: Long,
        sequence: Long,
    ): ByteString = encode(samples, sampleCount, sampleRate, channels, sourceEpoch, sequence).toByteString()

    fun decode(input: ByteString, maxPayloadBytes: Int = MAX_PAYLOAD_BYTES): Pcm16RelayPacket {
        require(maxPayloadBytes in 0..MAX_PAYLOAD_BYTES) { "Invalid PCM16 relay payload bound." }
        require(input.size in HEADER_BYTES..HEADER_BYTES + maxPayloadBytes) {
            "Media relay frame is outside the bounded packet size."
        }
        return decode(input.toByteArray(), maxPayloadBytes)
    }

    /** Decode and copy one complete bounded frame. */
    fun decode(input: ByteArray, maxPayloadBytes: Int = MAX_PAYLOAD_BYTES): Pcm16RelayPacket {
        require(maxPayloadBytes in 0..MAX_PAYLOAD_BYTES) {
            "maxPayloadBytes must be between zero and $MAX_PAYLOAD_BYTES."
        }
        require(input.size >= HEADER_BYTES) { "Media relay frame is shorter than its header." }
        require(input.size <= HEADER_BYTES + maxPayloadBytes) { "Media relay frame is too large." }
        MAGIC.indices.forEach { index ->
            require(input[index] == MAGIC[index]) { "Media relay frame has an invalid magic header." }
        }
        require((input[4].toInt() and 0xff) == VERSION) {
            "Media relay frame has an unsupported version."
        }
        require((input[5].toInt() and 0xff) == CHANNELS) {
            "Media relay frame must contain one channel."
        }

        val sampleRate = readUint32(input, 6)
        require(sampleRate == SAMPLE_RATE.toLong()) {
            "Media relay frame must use a $SAMPLE_RATE Hz sample rate."
        }
        val sourceEpoch = readUint32(input, 10)
        val sequence = readUint32(input, 14)
        val sampleCount = readUint16(input, 18)
        require(sampleCount > 0) { "Media relay frame must contain at least one sample." }

        val payloadBytes = input.size - HEADER_BYTES
        require(payloadBytes == sampleCount * BYTES_PER_SAMPLE) {
            "Media relay PCM16 payload length does not match sampleCount."
        }
        require(payloadBytes <= maxPayloadBytes) { "Media relay PCM16 payload is too large." }

        val payload = input.copyOfRange(HEADER_BYTES, input.size)
        val samples = ShortArray(sampleCount)
        repeat(sampleCount) { index ->
            samples[index] = readInt16(input, HEADER_BYTES + index * BYTES_PER_SAMPLE)
        }
        return Pcm16RelayPacket(
            sampleRate = sampleRate.toInt(),
            channels = CHANNELS,
            sourceEpoch = sourceEpoch,
            sequence = sequence,
            sampleCount = sampleCount,
            payload = payload,
            samples = samples,
        )
    }

    private fun putUint16(output: ByteArray, offset: Int, value: Int) {
        output[offset] = value.toByte()
        output[offset + 1] = (value ushr 8).toByte()
    }

    private fun putUint32(output: ByteArray, offset: Int, value: Long) {
        output[offset] = value.toByte()
        output[offset + 1] = (value ushr 8).toByte()
        output[offset + 2] = (value ushr 16).toByte()
        output[offset + 3] = (value ushr 24).toByte()
    }

    private fun putInt16(output: ByteArray, offset: Int, value: Short) {
        val unsigned = value.toInt() and UINT16_MAX
        putUint16(output, offset, unsigned)
    }

    private fun readUint16(input: ByteArray, offset: Int): Int =
        (input[offset].toInt() and 0xff) or ((input[offset + 1].toInt() and 0xff) shl 8)

    private fun readUint32(input: ByteArray, offset: Int): Long =
        (input[offset].toLong() and 0xffL) or
            ((input[offset + 1].toLong() and 0xffL) shl 8) or
            ((input[offset + 2].toLong() and 0xffL) shl 16) or
            ((input[offset + 3].toLong() and 0xffL) shl 24)

    private fun readInt16(input: ByteArray, offset: Int): Short =
        readUint16(input, offset).toShort()
}
