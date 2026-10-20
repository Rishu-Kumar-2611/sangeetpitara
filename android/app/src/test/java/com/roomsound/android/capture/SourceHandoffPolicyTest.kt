package com.roomsound.android.capture

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceHandoffPolicyTest {
    @Test
    fun pauses_external_playback_only_when_a_live_source_lease_is_lost() {
        assertTrue(SourceHandoffPolicy.shouldPauseExternalPlayback(ConsentPhase.LIVE, stillAuthorized = false))
        assertFalse(SourceHandoffPolicy.shouldPauseExternalPlayback(ConsentPhase.LIVE, stillAuthorized = true))
        assertFalse(SourceHandoffPolicy.shouldPauseExternalPlayback(ConsentPhase.AWAITING_LIVE, stillAuthorized = false))
        assertFalse(SourceHandoffPolicy.shouldPauseExternalPlayback(null, stillAuthorized = false))
    }
}
