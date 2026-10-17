package com.roomsound.android.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class SenderRetryPolicyTest {
    @Test
    fun backsOffAndCapsRetryDelay() {
        assertEquals(1_000L, SenderRetryPolicy.delayMs(0))
        assertEquals(2_000L, SenderRetryPolicy.delayMs(1))
        assertEquals(4_000L, SenderRetryPolicy.delayMs(2))
        assertEquals(30_000L, SenderRetryPolicy.delayMs(5))
        assertEquals(30_000L, SenderRetryPolicy.delayMs(20))
    }

    @Test
    fun invalidAttemptStartsAtInitialDelay() {
        assertEquals(SenderRetryPolicy.INITIAL_DELAY_MS, SenderRetryPolicy.delayMs(-1))
    }
}
