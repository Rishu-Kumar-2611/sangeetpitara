package com.roomsound.android.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomEndpointBootstrapTest {
    @Test
    fun configuredEndpointWinsForEveryDeviceAndBuildType() {
        assertEquals(
            "ws://configured-endpoint:4173",
            RoomEndpointBootstrap.selectEndpoint(" ws://configured-endpoint:4173 ", false, false),
        )
    }

    @Test
    fun blankConfigurationUsesTheExistingDebugEmulatorFallback() {
        assertEquals(
            RoomEndpointBootstrap.EMULATOR_FALLBACK_ENDPOINT,
            RoomEndpointBootstrap.selectEndpoint("  ", true, true),
        )
    }

    @Test
    fun missingConfigurationDoesNotChooseAnEndpointForPhysicalOrReleaseBuilds() {
        assertNull(RoomEndpointBootstrap.selectEndpoint(null, true, false))
        assertNull(RoomEndpointBootstrap.selectEndpoint(null, false, true))
    }

    @Test
    fun invalidNonBlankConfigurationDoesNotFallBackSilently() {
        assertEquals(
            "not-a-websocket-endpoint",
            RoomEndpointBootstrap.selectEndpoint("not-a-websocket-endpoint", true, true),
        )
    }
}
