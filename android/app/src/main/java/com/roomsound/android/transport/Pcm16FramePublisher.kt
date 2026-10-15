package com.roomsound.android.transport

/** The PCM format supplied by the Android playback-capture probe. */
data class Pcm16AudioFormat(
    val sampleRate: Int,
    val channels: Int,
) {
    init {
        require(sampleRate > 0) { "sampleRate must be positive." }
        require(channels > 0) { "channels must be positive." }
    }
}

/**
 * A frame of signed little-endian PCM16 samples represented as Android
 * `Short` values. `sourceEpoch` is assigned by RoomAudioTransport only after
 * the room server authorizes this member as the live source.
 */
data class Pcm16Frame(
    val samples: ShortArray,
    val sampleCount: Int,
    val format: Pcm16AudioFormat,
    val sourceEpoch: Long,
    val capturedAtNanos: Long = System.nanoTime(),
) {
    init {
        require(sampleCount in 0..samples.size) {
            "sampleCount must be between zero and the sample array size."
        }
    }
}

enum class Pcm16PublishResult {
    PUBLISHED,
    DROPPED_UNAUTHORIZED,
    DROPPED_NOT_LIVE,
    DROPPED_STALE_EPOCH,
    BACKEND_UNAVAILABLE,
    INVALID_FORMAT,
}

/**
 * Media-plane seam for a future native audio backend.
 *
 * Implementations must bind to exactly one RoomSound source epoch at a time.
 * A future WebRTC/native implementation can create or replace its audio track
 * in [start], accept frames in [publish], and tear it down in [stop]. No
 * microphone fallback or generated audio is part of this interface.
 */
interface Pcm16FramePublisher {
    fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean

    fun publish(frame: Pcm16Frame): Pcm16PublishResult

    fun stop(sourceEpoch: Long)

    fun close() = Unit
}

/**
 * Explicit current implementation boundary: OkHttp signaling is available,
 * but arbitrary PCM injection into a WebRTC audio sender is not implemented.
 */
class UnavailablePcm16FramePublisher(
    val reason: String = DEFAULT_REASON,
) : Pcm16FramePublisher {
    override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean = false

    override fun publish(frame: Pcm16Frame): Pcm16PublishResult = Pcm16PublishResult.BACKEND_UNAVAILABLE

    override fun stop(sourceEpoch: Long) = Unit

    companion object {
        const val DEFAULT_REASON =
            "No native WebRTC PCM publisher is installed. Android playback PCM is never routed through the microphone or a fake publisher."
    }
}
