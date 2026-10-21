package com.roomsound.android.capture

/** Main-thread policy; Activity visibility is deliberately not a playback lifecycle input. */
internal class RoomPlaybackLifecycle {
    enum class Phase { IDLE, PREPARING, JOINED, RECOVERING }
    enum class Mode { PLAYBACK, CAPTURE }

    var phase = Phase.IDLE
        private set
    var sessionId: String? = null
        private set
    var captureId: String? = null
        private set
    var deadlineMs: Long? = null
        private set
    private var generation = 0L
    private var streaming = false

    val protected: Boolean get() = phase != Phase.IDLE
    val mode: Mode? get() = if (!protected) null else if (captureId != null) Mode.CAPTURE else Mode.PLAYBACK
    val actionToken: String? get() = sessionId?.let { "$it:$generation" }
    val needsLocks: Boolean get() = protected &&
        (streaming || captureId != null || phase == Phase.PREPARING || phase == Phase.RECOVERING)

    fun prepare(id: String, nowMs: Long): Boolean {
        if (protected) return false
        sessionId = id
        generation++
        phase = Phase.PREPARING
        deadlineMs = nowMs + PREPARATION_TIMEOUT_MS
        return true
    }

    fun joined(isStreaming: Boolean) {
        if (!protected) return // A late callback cannot revive an explicitly stopped session.
        phase = Phase.JOINED
        deadlineMs = null
        streaming = isStreaming
    }

    fun disconnected(nowMs: Long) {
        if (phase == Phase.JOINED) {
            phase = Phase.RECOVERING
            deadlineMs = nowMs + RECOVERY_TIMEOUT_MS
        }
        // Repeated failures/CONNECTING/OPEN must not extend the recovery budget.
    }

    fun initialJoinFailed() {
        if (phase == Phase.PREPARING) stop()
    }

    fun captureStarted(id: String): Boolean {
        if (!protected || captureId != null) return false
        captureId = id
        generation++
        return true
    }

    fun captureFinished(id: String) {
        if (captureId != id) return
        captureId = null
        generation++ // Invalidate capture notification and old media-session callbacks.
    }

    fun acceptsAction(token: String?): Boolean = protected && token != null && token == actionToken
    fun acceptsCaptureStop(token: String?, id: String?): Boolean =
        acceptsAction(token) && id != null && id == captureId

    fun isExpired(nowMs: Long): Boolean = deadlineMs?.let { nowMs >= it } == true

    fun stop() {
        phase = Phase.IDLE
        sessionId = null
        captureId = null
        streaming = false
        deadlineMs = null
        generation++
    }

    companion object {
        const val PREPARATION_TIMEOUT_MS = 60_000L
        const val RECOVERY_TIMEOUT_MS = 90_000L
    }
}
