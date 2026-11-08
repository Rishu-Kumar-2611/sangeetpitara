package com.roomsound.android.transport

import android.media.MediaCodec
import android.media.MediaFormat
import java.io.Closeable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Opus for the room relay, using the platform MediaCodec encoder/decoder
 * (Android 10+). Rooms switch to Opus only when every listener can decode it,
 * and this device only claims support after a local encode/decode self-test,
 * so PCM16 remains the fallback on any device whose codecs misbehave.
 */
object OpusSupport {
    data class Capabilities(val decode: Boolean, val encode: Boolean)

    @Volatile private var cached: Capabilities? = null

    /** Runs the self-test once (about 100-300 ms) and caches the result. Never throws. */
    fun capabilities(): Capabilities {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val result = runCatching { selfTest() }.getOrDefault(Capabilities(decode = false, encode = false))
            cached = result
            return result
        }
    }

    /** Called after a decoder fails in a real room so later joins ask for PCM16. */
    fun markDecodeBroken() {
        cached = Capabilities(decode = false, encode = cached?.encode ?: false)
    }

    private fun selfTest(): Capabilities {
        // Decode a valid 20 ms CELT silence packet first: the minimum to listen.
        val decodeOk = OpusRelayDecoder.create()?.use { decoder ->
            var produced = 0
            repeat(4) { index -> produced += decoder.decode(SILENCE_PACKET, index * 20_000L).size }
            produced > 0
        } ?: false
        if (!decodeOk) return Capabilities(decode = false, encode = false)

        // Encode 200 ms of a 440 Hz tone and require audible decoded output.
        val encodeOk = OpusRelayEncoder.create(96_000)?.use { encoder ->
            val packets = mutableListOf<ByteArray>()
            val frame = ShortArray(OpusRelayEncoder.FRAME_SAMPLES)
            for (block in 0 until 10) {
                for (i in frame.indices) {
                    val t = (block * frame.size + i).toDouble() / SAMPLE_RATE
                    frame[i] = (sin(2 * PI * 440.0 * t) * 12_000).toInt().toShort()
                }
                packets += encoder.encode(frame, frame.size)
            }
            packets += encoder.drain(20_000)
            if (packets.isEmpty()) return@use false
            OpusRelayDecoder.create()?.use { decoder ->
                val decoded = packets.flatMapIndexed { index, packet -> decoder.decode(packet, index * 20_000L).asIterable() }
                decoded.size >= OpusRelayEncoder.FRAME_SAMPLES && rms(decoded) > 1_000.0
            } ?: false
        } ?: false
        return Capabilities(decode = true, encode = encodeOk)
    }

    private fun rms(samples: List<Short>): Double {
        if (samples.isEmpty()) return 0.0
        var sum = 0.0
        for (sample in samples) sum += sample.toDouble() * sample.toDouble()
        return sqrt(sum / samples.size)
    }

    const val SAMPLE_RATE = 48_000
    private val SILENCE_PACKET = byteArrayOf(0xF8.toByte(), 0xFF.toByte(), 0xFE.toByte())
}

/** Samples at 48 kHz in one Opus packet, from its TOC byte (RFC 6716 section 3.1). */
fun opusPacketSampleCount(packet: ByteArray): Int {
    if (packet.isEmpty()) return 0
    val toc = packet[0].toInt() and 0xff
    val config = toc shr 3
    val frameSamples = when {
        config < 12 -> intArrayOf(480, 960, 1920, 2880)[config and 3]
        config < 16 -> intArrayOf(480, 960)[config and 1]
        else -> intArrayOf(120, 240, 480, 960)[config and 3]
    }
    val frames = when (toc and 3) {
        0 -> 1
        1, 2 -> 2
        else -> if (packet.size < 2) 0 else packet[1].toInt() and 0x3f
    }
    val total = frameSamples * frames
    return if (frames > 0 && total <= 5_760) total else 0
}

/** Synchronous MediaCodec Opus decoder for 48 kHz mono relay packets. */
class OpusRelayDecoder private constructor(private val codec: MediaCodec) : Closeable {
    private val info = MediaCodec.BufferInfo()
    private var closed = false

    /** Decoded PCM16 for this packet; may include output still pending from earlier packets. */
    fun decode(packet: ByteArray, presentationUs: Long): ShortArray {
        if (closed || packet.isEmpty()) return ShortArray(0)
        val input = codec.dequeueInputBuffer(INPUT_TIMEOUT_US)
        if (input < 0) return drain(0)
        val buffer = codec.getInputBuffer(input) ?: return ShortArray(0)
        buffer.clear()
        buffer.put(packet)
        codec.queueInputBuffer(input, 0, packet.size, presentationUs, 0)
        return drain(OUTPUT_TIMEOUT_US)
    }

    private fun drain(firstTimeoutUs: Long): ShortArray {
        var out = ShortArray(0)
        var timeout = firstTimeoutUs
        while (true) {
            val index = codec.dequeueOutputBuffer(info, timeout)
            when {
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index)
                    if (buffer != null && info.size > 0) {
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        val shorts = ShortArray(info.size / 2)
                        buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
                        out += shorts
                    }
                    codec.releaseOutputBuffer(index, false)
                    timeout = 0
                }
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> timeout = 0
                else -> return out
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { codec.stop() }
        runCatching { codec.release() }
    }

    companion object {
        private const val INPUT_TIMEOUT_US = 10_000L
        private const val OUTPUT_TIMEOUT_US = 5_000L

        fun create(): OpusRelayDecoder? = runCatching {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, OpusSupport.SAMPLE_RATE, 1)
            format.setByteBuffer("csd-0", ByteBuffer.wrap(opusHead()))
            format.setByteBuffer("csd-1", ByteBuffer.wrap(longLittleEndian(0L))) // codec delay (ns)
            format.setByteBuffer("csd-2", ByteBuffer.wrap(longLittleEndian(80_000_000L))) // seek pre-roll (ns)
            val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            try {
                codec.configure(format, null, null, 0)
                codec.start()
            } catch (error: Throwable) {
                codec.release()
                throw error
            }
            OpusRelayDecoder(codec)
        }.getOrNull()

        /** RFC 7845 identification header for a mono 48 kHz stream with no pre-skip. */
        internal fun opusHead(): ByteArray = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("OpusHead".toByteArray(Charsets.US_ASCII))
            put(1) // version
            put(1) // channels
            putShort(0) // pre-skip
            putInt(OpusSupport.SAMPLE_RATE)
            putShort(0) // output gain
            put(0) // channel mapping family
        }.array()

        private fun longLittleEndian(value: Long): ByteArray =
            ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(value).array()
    }
}

/** Synchronous MediaCodec Opus encoder: 48 kHz mono PCM16 in, raw Opus packets out. */
class OpusRelayEncoder private constructor(private val codec: MediaCodec) : Closeable {
    private val info = MediaCodec.BufferInfo()
    private var presentationUs = 0L
    private var closed = false

    /** Queues one block of PCM16 and returns every finished Opus packet. */
    fun encode(samples: ShortArray, sampleCount: Int): List<ByteArray> {
        if (closed || sampleCount <= 0) return emptyList()
        val input = codec.dequeueInputBuffer(INPUT_TIMEOUT_US)
        if (input < 0) return drain(0)
        val buffer = codec.getInputBuffer(input) ?: return emptyList()
        buffer.clear()
        val count = minOf(sampleCount, buffer.capacity() / 2)
        buffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(samples, 0, count)
        codec.queueInputBuffer(input, 0, count * 2, presentationUs, 0)
        presentationUs += count * 1_000_000L / OpusSupport.SAMPLE_RATE
        return drain(0)
    }

    /** Collects packets still inside the encoder, waiting up to [timeoutUs] for the first. */
    fun drain(timeoutUs: Long): List<ByteArray> {
        val packets = mutableListOf<ByteArray>()
        var timeout = timeoutUs
        while (true) {
            val index = codec.dequeueOutputBuffer(info, timeout)
            when {
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index)
                    // Codec-config buffers carry stream headers, not audio.
                    if (buffer != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        val packet = ByteArray(info.size)
                        buffer.get(packet)
                        if (opusPacketSampleCount(packet) > 0) packets += packet
                    }
                    codec.releaseOutputBuffer(index, false)
                    timeout = 0
                }
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> timeout = 0
                else -> return packets
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { codec.stop() }
        runCatching { codec.release() }
    }

    companion object {
        const val FRAME_SAMPLES = 960
        private const val INPUT_TIMEOUT_US = 10_000L

        fun create(bitrate: Int): OpusRelayEncoder? = runCatching {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, OpusSupport.SAMPLE_RATE, 1)
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate.coerceIn(32_000, 128_000))
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME_SAMPLES * 2 * 4)
            val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                codec.start()
            } catch (error: Throwable) {
                codec.release()
                throw error
            }
            OpusRelayEncoder(codec)
        }.getOrNull()
    }
}
