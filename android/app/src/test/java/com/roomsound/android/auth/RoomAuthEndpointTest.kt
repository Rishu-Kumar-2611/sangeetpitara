package com.roomsound.android.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RoomAuthEndpointTest {
    @Test
    fun convertsWebSocketOriginToSameOriginHttpApiBase() {
        assertEquals("http://192.168.1.20:4173", RoomAuthEndpoint.httpBase("ws://192.168.1.20:4173"))
        assertEquals("https://rooms.example.test", RoomAuthEndpoint.httpBase("wss://rooms.example.test/room"))
    }

    @Test
    fun rejectsEndpointsThatCouldSmuggleCredentialsOrFragments() {
        assertNull(RoomAuthEndpoint.httpBase("wss://user:password@rooms.example.test"))
        assertNull(RoomAuthEndpoint.httpBase("wss://rooms.example.test/room#fragment"))
        assertNull(RoomAuthEndpoint.httpBase("https://rooms.example.test"))
    }

    @Test
    fun rejectsSessionValuesThatCouldBreakBearerHeaders() {
        assertEquals("safe-token", normalizeRoomAuthToken(" safe-token "))
        assertNull(normalizeRoomAuthToken("token\nvalue"))
        assertNull(normalizeRoomAuthToken("token\u0000value"))
    }

    @Test
    fun invalidSavedTokenFailsBeforeBuildingAnAuthorizationRequest() {
        var result: Result<RoomAccountUser?>? = null
        RoomAuthClient().currentUser("wss://rooms.example.test", "token\nvalue") { result = it }

        assertEquals("The saved RoomSound session is invalid.", result?.exceptionOrNull()?.message)
    }
}
