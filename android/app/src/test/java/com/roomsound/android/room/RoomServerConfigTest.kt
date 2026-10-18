package com.roomsound.android.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomServerConfigTest {
    @Test
    fun missingMediaRelayConfigDefaultsToEnabledPcm16() {
        val config = RoomServerConfig.DEFAULT
        assertTrue(config.mediaRelay.enabled)
        assertTrue(config.mediaRelay.isPcm16Enabled)
        assertEquals(48_000, config.mediaRelay.sampleRate)
        assertEquals(1, config.mediaRelay.channels)
    }

    @Test
    fun storesIceAndExplicitDirectWebRtcOptOutTogether() {
        val config = RoomServerConfig(
            iceServers = listOf(
                RoomIceServer(
                    urls = listOf("stun:stun.example.test"),
                    username = "u",
                    credential = "p",
                ),
            ),
            mediaRelay = RoomMediaRelayConfig(enabled = false),
        )
        assertEquals(listOf("stun:stun.example.test"), config.iceServers.single().urls)
        assertEquals("u", config.iceServers.single().username)
        assertFalse(config.mediaRelay.enabled)
        assertFalse(config.mediaRelay.isPcm16Enabled)
    }

    @Test
    fun incompatibleRelayShapeDoesNotPretendToBePcm16() {
        val config = RoomServerConfig(
            mediaRelay = RoomMediaRelayConfig(
                enabled = true,
                mode = "opus",
                sampleRate = 48_000,
                channels = 1,
            ),
        )
        assertTrue(config.mediaRelay.enabled)
        assertFalse(config.mediaRelay.isPcm16Enabled)
    }
}
