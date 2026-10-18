package com.roomsound.android.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomEndpointValidatorTest {
    @Test
    fun mapsAllSupportedServerSchemesToTheMatchingWebSocketScheme() {
        assertEquals("ws://192.168.1.20:4173", RoomEndpointValidator.normalize("ws://192.168.1.20:4173"))
        assertEquals("ws://192.168.1.20:4173", RoomEndpointValidator.normalize("http://192.168.1.20:4173/"))
        assertEquals("wss://rooms.example.test/room", RoomEndpointValidator.normalize("wss://rooms.example.test/room"))
        assertEquals("wss://rooms.example.test/room", RoomEndpointValidator.normalize("https://rooms.example.test/room/"))
    }

    @Test
    fun classifiesLanAndPublicEndpointGuidance() {
        assertEquals(RoomEndpointKind.LAN, RoomEndpointValidator.parse("http://192.168.1.20:4173")?.kind)
        assertEquals(RoomEndpointKind.PUBLIC, RoomEndpointValidator.parse("https://rooms.example.test")?.kind)
        assertEquals(
            "LAN endpoint: ws:// or http:// becomes ws://. Use the computer's LAN IP on the same Wi-Fi.",
            RoomEndpointValidator.guidance("ws://192.168.1.20:4173"),
        )
    }

    @Test
    fun mapsWebSocketEndpointToItsServerConfigOrigin() {
        assertEquals(
            "http://192.168.1.20:4173/config",
            RoomEndpointValidator.configUrl("ws://192.168.1.20:4173/rooms?transport=ws"),
        )
        assertEquals(
            "https://rooms.example.test/config",
            RoomEndpointValidator.configUrl("wss://rooms.example.test/rooms"),
        )
    }

    @Test
    fun rejectsCredentialsFragmentsUnsupportedSchemesAndMalformedHosts() {
        assertNull(RoomEndpointValidator.normalize("wss://user:password@rooms.example.test"))
        assertNull(RoomEndpointValidator.normalize("https://rooms.example.test/room#fragment"))
        assertNull(RoomEndpointValidator.normalize("ftp://rooms.example.test"))
        assertNull(RoomEndpointValidator.normalize("ws://"))
        assertNull(RoomEndpointValidator.normalize("ws://rooms.example.test:99999"))
    }
}
