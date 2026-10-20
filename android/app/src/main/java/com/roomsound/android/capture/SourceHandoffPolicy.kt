package com.roomsound.android.capture

/** Keeps user-initiated stops from pausing unrelated local media. */
internal object SourceHandoffPolicy {
    fun shouldPauseExternalPlayback(attemptPhase: ConsentPhase?, stillAuthorized: Boolean): Boolean =
        attemptPhase == ConsentPhase.LIVE && !stillAuthorized
}
