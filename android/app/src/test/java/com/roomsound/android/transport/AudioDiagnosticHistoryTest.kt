package com.roomsound.android.transport

import org.junit.Assert.*
import org.junit.Test

class AudioDiagnosticHistoryTest {
    @Test fun excludesIdentitiesAndInvalidMeasurements() {
        val history = AudioDiagnosticHistory { 1000 }
        history.record(mapOf("receivedPackets" to 3, "roomCode" to 123456, "jitterMs" to Double.NaN), "secret", "token", "private", "invite")
        val result = history.export("secret")
        assertTrue(result.contains("receivedPackets"))
        for (word in listOf("roomCode", "123456", "jitterMs", "secret", "token", "private", "invite\"")) assertFalse(word, result.contains(word))
    }
    @Test fun preservesBoundedIncidentHistoryAndSamples() {
        var now = 0L
        val history = AudioDiagnosticHistory { now }
        repeat(1000) {
            now = it * 1000L
            history.record(mapOf("underruns" to it), "listener", "connected", "running", "internet")
        }
        val result = history.export("1.1.13")
        assertTrue(result.length < 100000)
        assertTrue(result.contains("underrun"))
        assertFalse(result.contains("\"at\":0,"))
    }
}
