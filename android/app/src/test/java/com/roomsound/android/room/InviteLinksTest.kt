package com.roomsound.android.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InviteLinksTest {
    private val host = "sangeet-pitaraa.onrender.com"

    @Test
    fun readsTheRoomCodeFromAnInviteLink() {
        assertEquals("ABCD2345", InviteLinks.roomCode("https://$host/join/ABCD2345", host))
        assertEquals("ABCD2345", InviteLinks.roomCode("https://$host/join/abcd-2345/", host))
        assertEquals("ABCD2345", InviteLinks.roomCode("https://SANGEET-PITARAA.onrender.com/join/ABCD2345?x=1", host))
    }

    @Test
    fun ignoresLinksForOtherSitesPathsOrSchemes() {
        assertNull(InviteLinks.roomCode("https://evil.example/join/ABCD2345", host))
        assertNull(InviteLinks.roomCode("http://$host/join/ABCD2345", host))
        assertNull(InviteLinks.roomCode("https://$host/join/", host))
        assertNull(InviteLinks.roomCode("https://$host/join/AB<script>", host))
        assertNull(InviteLinks.roomCode("https://$host/join/ABCD2345/extra", host))
        assertNull(InviteLinks.roomCode("https://$host/?room=ABCD2345", host))
        assertNull(InviteLinks.roomCode(null, host))
        assertNull(InviteLinks.roomCode("https://$host/join/ABCD2345", null))
    }

    @Test
    fun buildsShareLinksOnlyForPublicServers() {
        assertEquals("https://$host/join/ABCD2345", InviteLinks.forRoom("wss://$host", "abcd-2345"))
        assertEquals("https://example.test:8443/join/ABCD2345", InviteLinks.forRoom("wss://example.test:8443/ws", "ABCD2345"))
        assertNull(InviteLinks.forRoom("ws://127.0.0.1:8765", "ABCD2345"))
        assertNull(InviteLinks.forRoom("wss://$host", ""))
        assertNull(InviteLinks.forRoom(null, "ABCD2345"))
    }
}
