package com.roomsound.android.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class Pcm16FramePacerTest {
    @Test
    fun firstCallbackIsImmediateAndLaterCallbacksUseMonotonicDeadline() {
        val clock = FakeClock()
        val waits = mutableListOf<Long>()
        val pacer = Pcm16FramePacer(
            intervalNanos = 10L,
            clock = Pcm16MonotonicClock { clock.nowNanos },
            waiter = Pcm16PacingWaiter { nanos ->
                waits += nanos
                clock.nowNanos += nanos
            },
        )

        pacer.awaitNextBuffer()
        assertEquals(emptyList<Long>(), waits)

        pacer.awaitNextBuffer()
        assertEquals(listOf(10L), waits)

        clock.nowNanos += 3L
        pacer.awaitNextBuffer()
        assertEquals(listOf(10L, 7L), waits)
    }

    @Test
    fun resetMakesNextCallbackImmediateAndDropsOldDeadline() {
        val clock = FakeClock()
        val waits = mutableListOf<Long>()
        val pacer = Pcm16FramePacer(
            intervalNanos = 10L,
            clock = Pcm16MonotonicClock { clock.nowNanos },
            waiter = Pcm16PacingWaiter { nanos ->
                waits += nanos
                clock.nowNanos += nanos
            },
        )

        pacer.awaitNextBuffer()
        clock.nowNanos += 4L
        pacer.reset()
        pacer.awaitNextBuffer()
        assertEquals(emptyList<Long>(), waits)

        pacer.awaitNextBuffer()
        assertEquals(listOf(10L), waits)
    }

    private class FakeClock(var nowNanos: Long = 0L)
}
