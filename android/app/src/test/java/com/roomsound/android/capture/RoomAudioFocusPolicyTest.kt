package com.roomsound.android.capture

import org.junit.Assert.assertEquals
import org.junit.Test

class RoomAudioFocusPolicyTest {
    @Test
    fun local_capture_never_requests_focus_from_the_source_app() {
        assertEquals(
            RoomAudioFocusPolicy.Mode.NONE,
            RoomAudioFocusPolicy.mode(capturing = true, remoteAudio = true),
        )
    }

    @Test
    fun remote_room_playback_ducks_other_audio_instead_of_requesting_permanent_gain() {
        assertEquals(
            RoomAudioFocusPolicy.Mode.TRANSIENT_MAY_DUCK,
            RoomAudioFocusPolicy.mode(capturing = false, remoteAudio = true),
        )
    }

    @Test
    fun no_active_remote_playback_releases_focus() {
        assertEquals(
            RoomAudioFocusPolicy.Mode.NONE,
            RoomAudioFocusPolicy.mode(capturing = false, remoteAudio = false),
        )
    }
}
