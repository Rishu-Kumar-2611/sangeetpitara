package com.roomsound.android.room

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomAccessStateTest {
    private fun room(): JSONObject = JSONObject().put("id", "room-1").put("code", "K7QM4PZT").put("name", "Sunday riyaz")

    @Test fun lockedFlagIsReadFromTheServerRoomState() {
        assertTrue(parseRoomSummary(room().put("locked", true)).locked)
        assertFalse(parseRoomSummary(room().put("locked", false)).locked)
    }

    @Test fun olderServersWithoutTheFlagAreTreatedAsOpen() {
        val summary = parseRoomSummary(room())
        assertFalse(summary.locked)
        assertEquals("K7QM4PZT", summary.code)
    }
}
