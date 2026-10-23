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
    private val clarityConditioner = Pcm16ClarityConditioner()

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
            nextSequence = 0L
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

    override fun stop(sourceEpoch: Long) {
        synchronized(lock) {
            if (activeEpoch != sourceEpoch) return
            started = false
            activeEpoch = null
            clarityConditioner.reset()
        }
    }

    override fun diagnostics(): String = synchronized(lock) {
        "relay=pcm16 started=$started epoch=${activeEpoch ?: "none"} " +
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
    }

    companion object {
        val FORMAT = Pcm16AudioFormat(
            Pcm16RelayPacketCodec.SAMPLE_RATE,
            Pcm16RelayPacketCodec.CHANNELS,
        )
    }
}
