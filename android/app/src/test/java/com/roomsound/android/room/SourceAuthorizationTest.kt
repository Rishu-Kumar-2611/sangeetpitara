package com.roomsound.android.room

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SourceAuthorizationTest {
    @Test
    fun onlyTheLiveSelfLeaseCanPublishFrames() {
        val live = SourceAuthorization(
            selfMemberId = "self",
            activeSourceId = "self",
            sourceStatus = "LIVE",
            sourceEpoch = 7L,
        )

        assertTrue(live.isSelfActiveSource)
        assertTrue(live.isAuthorized)
        assertTrue(live.canPublishFrames)
        assertFalse(
            SourceAuthorization("self", "self", "STARTING", 7L).canPublishFrames,
        )
        assertFalse(
            SourceAuthorization("self", "other", "LIVE", 7L).canPublishFrames,
        )
        assertFalse(
            SourceAuthorization("self", null, "LIVE", 7L).canPublishFrames,
        )
    }

    @Test
    fun sourceStatusComparisonIsCaseInsensitiveButMissingLeaseIsNotAuthorized() {
        assertTrue(SourceAuthorization("self", "self", "live", 8L).canPublishFrames)
        assertFalse(SourceAuthorization(null, "self", "LIVE", 8L).isAuthorized)
        assertFalse(SourceAuthorization("self", "self", "NONE", 8L).isAuthorized)
    }

    @Test
    fun relayPlaybackRequiresAnotherLiveSourceInTheCurrentLease() {
        assertTrue(SourceAuthorization("listener", "source", "live", 9L).canReceiveRelayFrames)
        assertFalse(SourceAuthorization("source", "source", "LIVE", 9L).canReceiveRelayFrames)
        assertFalse(SourceAuthorization("listener", "source", "STARTING", 9L).canReceiveRelayFrames)
        assertFalse(SourceAuthorization("listener", null, "LIVE", 9L).canReceiveRelayFrames)
    }
}
