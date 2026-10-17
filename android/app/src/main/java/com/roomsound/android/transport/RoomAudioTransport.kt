package com.roomsound.android.transport

import com.roomsound.android.capture.Pcm16Sink
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomSoundWebSocketClient
import com.roomsound.android.room.RoomState
import com.roomsound.android.room.SourceAuthorization
import java.io.Closeable

data class RoomAudioTransportSnapshot(
    val roomId: String?,
    val authorization: SourceAuthorization?,
    val mediaBackendConfigured: Boolean,
    val backendReady: Boolean,
    val publisherEpoch: Long?,
    val acceptedFrames: Long,
    val droppedUnauthorizedFrames: Long,
    val droppedNotLiveFrames: Long,
    val droppedStaleEpochFrames: Long,
    val droppedUnavailableFrames: Long,
    val lastResult: Pcm16PublishResult?,
    val publisherDiagnostics: String?,
)

/**
 * Bridges PlaybackCaptureController's [Pcm16Sink] callback to a media-plane
 * publisher while enforcing the RoomSound source lease.
 *
 * Frames are accepted only when the latest accepted room state says that this
 * client's member is the active source, the source status is LIVE, and the
 * publisher is bound to that same source epoch. State transitions stop the
 * publisher before a new epoch can be started. The default backend is
 * intentionally unavailable until a real native WebRTC audio-device adapter
 * is supplied.
 */
class RoomAudioTransport(
    private val roomClient: RoomSoundWebSocketClient,
    private val framePublisher: Pcm16FramePublisher = UnavailablePcm16FramePublisher(),
) : Pcm16Sink, RoomSoundWebSocketClient.Listener, Closeable {
    companion object {
        const val CAPTURE_SAMPLE_RATE = 48_000
        const val CAPTURE_CHANNELS = 1
    }

    private val lock = Any()
    private var closed = false
    private var roomId: String? = null
    private var authorization: SourceAuthorization? = null
    private var publisherEpoch: Long? = null
    private var backendReady = false
    private var acceptedFrames = 0L
    private var droppedUnauthorizedFrames = 0L
    private var droppedNotLiveFrames = 0L
    private var droppedStaleEpochFrames = 0L
    private var droppedUnavailableFrames = 0L
    private var lastResult: Pcm16PublishResult? = null

    init {
        roomClient.addListener(this)
        if (roomClient.connectionState() == RoomConnectionState.JOINED) {
            roomClient.currentRoomState()?.let(::applyRoomState)
        }
    }

    override fun onConnectionStateChanged(state: RoomConnectionState) {
        if (state == RoomConnectionState.JOINED) return
        synchronized(lock) {
            if (closed) return
            // A room lease is not considered usable while the signaling
            // socket is unavailable. Reconnect must deliver a fresh state
            // before media can be published again.
            stopPublisherLocked()
            authorization = null
            roomId = null
        }
    }

    override fun onEvent(event: RoomSoundEvent) {
        when (event) {
            is RoomSoundEvent.Joined -> applyRoomState(event.state)
            is RoomSoundEvent.State -> applyRoomState(event.state)
            is RoomSoundEvent.SourceDisconnected -> revokeIfSource(event.memberId)
            is RoomSoundEvent.Removed,
            is RoomSoundEvent.RoomEnded,
            -> revoke()
            else -> Unit
        }
    }

    /**
     * This is the method that PlaybackCaptureController can receive as its
     * sink. The controller already supplies a copied ShortArray, so this class
     * does not retain or mutate that capture buffer.
     */
    override fun onFrame(samples: ShortArray, sampleCount: Int, sampleRate: Int, channels: Int) {
        synchronized(lock) {
            if (closed) return
            val result = publishLocked(samples, sampleCount, sampleRate, channels)
            lastResult = result
            when (result) {
                Pcm16PublishResult.PUBLISHED -> acceptedFrames += 1
                Pcm16PublishResult.DROPPED_UNAUTHORIZED -> droppedUnauthorizedFrames += 1
                Pcm16PublishResult.DROPPED_NOT_LIVE -> droppedNotLiveFrames += 1
                Pcm16PublishResult.DROPPED_STALE_EPOCH -> droppedStaleEpochFrames += 1
                Pcm16PublishResult.BACKEND_UNAVAILABLE -> droppedUnavailableFrames += 1
                Pcm16PublishResult.INVALID_FORMAT -> Unit
            }
        }
    }

    fun snapshot(): RoomAudioTransportSnapshot = synchronized(lock) {
        RoomAudioTransportSnapshot(
            roomId = roomId,
            authorization = authorization,
            mediaBackendConfigured = framePublisher !is UnavailablePcm16FramePublisher,
            backendReady = backendReady,
            publisherEpoch = publisherEpoch,
            acceptedFrames = acceptedFrames,
            droppedUnauthorizedFrames = droppedUnauthorizedFrames,
            droppedNotLiveFrames = droppedNotLiveFrames,
            droppedStaleEpochFrames = droppedStaleEpochFrames,
            droppedUnavailableFrames = droppedUnavailableFrames,
            lastResult = lastResult,
            publisherDiagnostics = framePublisher.diagnostics(),
        )
    }

    /** True only when the caller supplied an initialized media-plane implementation. */
    fun hasMediaBackend(): Boolean = synchronized(lock) {
        !closed && framePublisher.isAvailable()
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            stopPublisherLocked()
        }
        roomClient.removeListener(this)
        runCatching { framePublisher.close() }
    }

    private fun applyRoomState(state: RoomState) {
        synchronized(lock) {
            if (closed) return

            val previousAuthorization = authorization
            val sameRoom = roomId == state.room.id
            if (sameRoom && previousAuthorization != null &&
                state.room.sourceEpoch < previousAuthorization.sourceEpoch
            ) {
                // RoomSoundWebSocketClient normally filters this already. Keep
                // the guard here because a transport can be fed by another
                // state source in tests or during future reconnect work.
                return
            }

            val nextAuthorization = state.sourceAuthorization()
            val leaseChanged = !sameRoom || previousAuthorization != nextAuthorization
            roomId = state.room.id
            authorization = nextAuthorization
            if (leaseChanged) stopPublisherLocked()

            if (nextAuthorization.canPublishFrames) {
                startPublisherLocked(nextAuthorization.sourceEpoch)
            }
        }
    }

    private fun revokeIfSource(memberId: String?) {
        synchronized(lock) {
            if (closed) return
            if (memberId == null || memberId == authorization?.activeSourceId) revokeLocked()
        }
    }

    private fun revoke() {
        synchronized(lock) {
            if (closed) return
            revokeLocked()
        }
    }

    private fun revokeLocked() {
        stopPublisherLocked()
        authorization = null
        roomId = null
    }

    private fun startPublisherLocked(sourceEpoch: Long) {
        if (backendReady && publisherEpoch == sourceEpoch) return
        if (publisherEpoch != null && publisherEpoch != sourceEpoch) stopPublisherLocked()

        val format = Pcm16AudioFormat(CAPTURE_SAMPLE_RATE, CAPTURE_CHANNELS)
        backendReady = runCatching { framePublisher.start(format, sourceEpoch) }.getOrDefault(false)
        publisherEpoch = if (backendReady) sourceEpoch else null
    }

    private fun stopPublisherLocked() {
        val activeEpoch = publisherEpoch
        if (activeEpoch != null) runCatching { framePublisher.stop(activeEpoch) }
        publisherEpoch = null
        backendReady = false
    }

    private fun publishLocked(
        samples: ShortArray,
        sampleCount: Int,
        sampleRate: Int,
        channels: Int,
    ): Pcm16PublishResult {
        if (sampleCount !in 0..samples.size || sampleCount == 0) return Pcm16PublishResult.INVALID_FORMAT
        val currentAuthorization = authorization ?: return Pcm16PublishResult.DROPPED_UNAUTHORIZED
        if (!currentAuthorization.isSelfActiveSource) return Pcm16PublishResult.DROPPED_UNAUTHORIZED
        if (!currentAuthorization.canPublishFrames) return Pcm16PublishResult.DROPPED_NOT_LIVE
        if (!backendReady) return Pcm16PublishResult.BACKEND_UNAVAILABLE
        if (publisherEpoch != currentAuthorization.sourceEpoch) {
            stopPublisherLocked()
            return Pcm16PublishResult.DROPPED_STALE_EPOCH
        }
        if (sampleRate != CAPTURE_SAMPLE_RATE || channels != CAPTURE_CHANNELS) {
            return Pcm16PublishResult.INVALID_FORMAT
        }

        val frame = Pcm16Frame(
            samples = samples,
            sampleCount = sampleCount,
            format = Pcm16AudioFormat(sampleRate, channels),
            sourceEpoch = currentAuthorization.sourceEpoch,
        )
        return try {
            framePublisher.publish(frame)
        } catch (_: Throwable) {
            runCatching { framePublisher.stop(currentAuthorization.sourceEpoch) }
            backendReady = false
            publisherEpoch = null
            Pcm16PublishResult.BACKEND_UNAVAILABLE
        }
    }
}
