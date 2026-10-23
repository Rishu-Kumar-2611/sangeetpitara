package com.roomsound.android.capture

/**
 * Audio focus is only for playing a remote room source. A local source must
 * keep the source app's playback untouched while Android playback capture reads
 * it, and remote room playback should duck rather than pause that app.
 */
internal object RoomAudioFocusPolicy {
    enum class Mode { NONE, TRANSIENT_MAY_DUCK }

    fun mode(capturing: Boolean, remoteAudio: Boolean): Mode = when {
        capturing -> Mode.NONE
        remoteAudio -> Mode.TRANSIENT_MAY_DUCK
        else -> Mode.NONE
    }
}
