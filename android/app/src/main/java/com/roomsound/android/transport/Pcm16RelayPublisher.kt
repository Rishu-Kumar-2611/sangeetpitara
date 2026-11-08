package com.roomsound.android.transport

import com.roomsound.android.room.Pcm16RelayPacketCodec
import com.roomsound.android.room.RoomSoundWebSocketClient
import java.util.concurrent.atomic.AtomicLong

/**
 * Media publisher for the server's no-TURN PCM16 WebSocket relay.
 *
 * The room transport has already checked the live source lease before calling
 * this class. This class repeats the current room/epoch check at the final
 * WebSocket boundary so a state transition racing a capture callback cannot
 * put stale PCM on the wire.
 */
class Pcm16RelayPublisher(
    private val roomClient: RoomSoundWebSocketClient,
) : Pcm16FramePublisher {
    private val lock = Any()
    private val publishedFrames = AtomicLong(0L)
    private val droppedFrames = AtomicLong(0L)
    private var closed = false
    private var started = false
    private var activeEpoch: Long? = null
    private var nextSequence = 0L
    private var sequenceEpoch: Long? = null
    private val clarityConditioner = Pcm16ClarityConditioner()

    // Opus state is used only from the capture thread except close/stop.
    private val opusLock = Any()
    private var opusEncoder: OpusRelayEncoder? = null
    private var opusEpoch: Long? = null
    private var opusSequence = 0L
    // Packet numbers belong to the source epoch, not to one encoder: a reconnect
    // that recreates the encoder must continue counting, or listeners would see
    // every new packet as old and go silent.
    private var opusSequenceEpoch: Long? = null
    @Volatile private var opusFailed = false

    override fun isAvailable(): Boolean = synchronized(lock) { !closed }

    override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean {
        if (format != Pcm16AudioFormat(FORMAT.sampleRate, FORMAT.channels)) return false
        if (sourceEpoch !in 0..Pcm16RelayPacketCodec.UINT32_MAX) return false
        val authorized = roomClient.currentRoomState()?.let { state ->
            state.room.sourceEpoch == sourceEpoch && state.sourceAuthorization().canPublishFrames
        } == true
        if (!authorized) return false

        synchronized(lock) {
            if (closed) return false
            if (started && activeEpoch == sourceEpoch) return true
            started = true
            activeEpoch = sourceEpoch
            if (sequenceEpoch != sourceEpoch) nextSequence = 0L
            sequenceEpoch = sourceEpoch
            clarityConditioner.reset()
        }
        return true
    }

    override fun publish(frame: Pcm16Frame): Pcm16PublishResult {
        val sequence: Long
        synchronized(lock) {
            if (closed || !started || activeEpoch == null) {
                droppedFrames.incrementAndGet()
                return Pcm16PublishResult.DROPPED_UNAUTHORIZED
            }
            if (activeEpoch != frame.sourceEpoch) {
                droppedFrames.incrementAndGet()
                return Pcm16PublishResult.DROPPED_STALE_EPOCH
            }
            if (frame.format != FORMAT || frame.sampleCount !in 1..frame.samples.size) {
                droppedFrames.incrementAndGet()
                return Pcm16PublishResult.INVALID_FORMAT
            }
            sequence = nextSequence
            nextSequence = (nextSequence + 1L) % (Pcm16RelayPacketCodec.UINT32_MAX + 1L)
        }

        val state = roomClient.currentRoomState()
        val authorized = state != null && state.room.sourceEpoch == frame.sourceEpoch &&
            state.sourceAuthorization().canPublishFrames
        if (!authorized) {
            droppedFrames.incrementAndGet()
            return Pcm16PublishResult.DROPPED_STALE_EPOCH
        }

        val conditionedSamples = synchronized(lock) {
            if (closed || !started || activeEpoch != frame.sourceEpoch) {
                droppedFrames.incrementAndGet()
                return Pcm16PublishResult.DROPPED_STALE_EPOCH
            }
            clarityConditioner.process(frame.samples, frame.sampleCount)
        }

        if (state?.room?.relayCodec == "opus" && !opusFailed && OpusSupport.capabilities().encode) {
            when (publishOpus(conditionedSamples, frame.sampleCount, frame.sourceEpoch)) {
                true -> { publishedFrames.incrementAndGet(); return Pcm16PublishResult.PUBLISHED }
                false -> { droppedFrames.incrementAndGet(); return Pcm16PublishResult.BACKEND_UNAVAILABLE }
                null -> Unit // Encoder failed: send this and later frames as PCM16.
            }
        } else {
            closeOpusEncoder()
        }

        val encoded = runCatching {
            Pcm16RelayPacketCodec.encodeByteString(
                samples = conditionedSamples,
                sampleCount = frame.sampleCount,
                sampleRate = frame.format.sampleRate,
                channels = frame.format.channels,
                sourceEpoch = frame.sourceEpoch,
                sequence = sequence,
            )
        }.getOrElse {
            droppedFrames.incrementAndGet()
            return Pcm16PublishResult.INVALID_FORMAT
        }

        return if (roomClient.sendPcm16Frame(encoded)) {
            publishedFrames.incrementAndGet()
            Pcm16PublishResult.PUBLISHED
        } else {
            droppedFrames.incrementAndGet()
            Pcm16PublishResult.BACKEND_UNAVAILABLE
        }
    }

    /** true: queued or sent; false: socket refused a packet; null: encoder unusable. */
    private fun publishOpus(samples: ShortArray, sampleCount: Int, sourceEpoch: Long): Boolean? = synchronized(opusLock) {
        if (opusEncoder == null || opusEpoch != sourceEpoch) {
            opusEncoder?.close()
            opusEncoder = OpusRelayEncoder.create(roomClient.opusBitrate())
            opusEpoch = sourceEpoch
            if (opusSequenceEpoch != sourceEpoch) {
                opusSequenceEpoch = sourceEpoch
                opusSequence = 0L
            }
        }
        val encoder = opusEncoder ?: run { opusFailed = true; return null }
        val packets = runCatching { encoder.encode(samples, sampleCount) }.getOrElse {
            encoder.close()
            opusEncoder = null
            opusFailed = true
            return null
        }
        var allSent = true
        for (packet in packets) {
            val samplesInPacket = opusPacketSampleCount(packet)
            val frame = runCatching {
                Pcm16RelayPacketCodec.encodeOpus(packet, samplesInPacket, sourceEpoch, opusSequence)
            }.getOrNull() ?: continue
            opusSequence = (opusSequence + 1L) % (Pcm16RelayPacketCodec.UINT32_MAX + 1L)
            if (!roomClient.sendPcm16Frame(frame)) allSent = false
        }
        allSent
    }

    private fun closeOpusEncoder() = synchronized(opusLock) {
        opusEncoder?.close()
        opusEncoder = null
        opusEpoch = null
    }

    override fun stop(sourceEpoch: Long) {
        synchronized(lock) {
            if (activeEpoch != sourceEpoch) return
            started = false
            activeEpoch = null
            clarityConditioner.reset()
        }
        closeOpusEncoder()
    }

    override fun diagnostics(): String = synchronized(lock) {
        "relay=${if (opusEncoder != null) "opus" else "pcm16"} started=$started epoch=${activeEpoch ?: "none"} " +
            "publishedFrames=${publishedFrames.get()} droppedFrames=${droppedFrames.get()}"
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            started = false
            activeEpoch = null
            clarityConditioner.reset()
        }
        closeOpusEncoder()
    }

    companion object {
        val FORMAT = Pcm16AudioFormat(
            Pcm16RelayPacketCodec.SAMPLE_RATE,
            Pcm16RelayPacketCodec.CHANNELS,
        )
    }
}
