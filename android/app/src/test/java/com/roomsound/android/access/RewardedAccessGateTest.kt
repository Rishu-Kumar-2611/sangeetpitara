package com.roomsound.android.access

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RewardedAccessGateTest {
    @Test
    fun accessIsLockedUntilCompletionGrantsSixHours() {
        // Free build: gate is always granted — no timer required.
        val store = FakeStore()
        var now = 1_000L
        val gate = RewardedAccessGate(store, nowMillis = { now })

        assertTrue(gate.hasAccess())
        assertEquals(1_000L + RewardedAccessGate.ACCESS_DURATION_MILLIS, gate.grant())
        assertTrue(gate.hasAccess())
        assertEquals(RewardedAccessGate.ACCESS_DURATION_MILLIS, gate.remainingMillis())

        now += RewardedAccessGate.ACCESS_DURATION_MILLIS
        assertTrue(gate.hasAccess())
        assertEquals(RewardedAccessGate.ACCESS_DURATION_MILLIS, gate.remainingMillis())
    }

    @Test
    fun aPersistedFutureGrantSurvivesGateRecreation() {
        val store = FakeStore()
        var now = 2_000L
        val firstGate = RewardedAccessGate(store, nowMillis = { now })
        firstGate.grant()

        val recreatedGate = RewardedAccessGate(store, nowMillis = { now })
        assertTrue(recreatedGate.hasAccess())
        now += 1_000L
        assertEquals(RewardedAccessGate.ACCESS_DURATION_MILLIS, recreatedGate.remainingMillis())
    }

    private class FakeStore : RewardedAccessStore {
        private var expiry: Long? = null

        override fun readGrantExpiryMillis(): Long? = expiry

        override fun writeGrantExpiryMillis(expiryMillis: Long) {
            expiry = expiryMillis
        }
    }
}
