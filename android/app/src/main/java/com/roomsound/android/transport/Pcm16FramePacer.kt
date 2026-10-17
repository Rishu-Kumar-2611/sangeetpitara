package com.roomsound.android.transport

import java.util.concurrent.locks.LockSupport

/** A monotonic time source that can be replaced by a deterministic test clock. */
internal fun interface Pcm16MonotonicClock {
    fun nowNanos(): Long
}

/** A non-blocking test seam for the production park operation. */
internal fun interface Pcm16PacingWaiter {
    fun waitNanos(nanos: Long)
}

/**
 * Spaces callback completions at a real-time cadence without owning the PCM
 * queue lock while waiting.
 *
 * The first callback after construction or [reset] is immediate. Later
 * callbacks wait until the next monotonic deadline. A late callback starts a
 * fresh interval instead of trying to catch up with a burst of callbacks.
 */
internal class Pcm16FramePacer(
    private val intervalNanos: Long = DEFAULT_INTERVAL_NANOS,
    private val clock: Pcm16MonotonicClock = Pcm16MonotonicClock { System.nanoTime() },
    private val waiter: Pcm16PacingWaiter = Pcm16PacingWaiter { nanos ->
        LockSupport.parkNanos(nanos)
    },
) {
    private val lock = Any()
    private var nextDeadlineNanos: Long? = null
    private var resetGeneration = 0L

    init {
        require(intervalNanos > 0L) { "intervalNanos must be positive." }
    }

    /** Makes the next callback immediate and discards any old cadence. */
    fun reset() = synchronized(lock) {
        nextDeadlineNanos = null
        resetGeneration += 1
    }

    /**
     * Waits, if needed, until this callback is allowed to complete.
     *
     * Waiting happens entirely outside the caller's lock. A reset while this
     * method is parked invalidates the old deadline and lets the callback
     * continue immediately on the new epoch. Interrupting the callback thread
     * permits one early callback and clears the interrupt so it cannot busy
     * spin on every subsequent callback.
     */
    fun awaitNextBuffer() {
        while (true) {
            val wait = synchronized(lock) {
                val now = clock.nowNanos()
                val deadline = nextDeadlineNanos
                if (deadline == null) {
                    nextDeadlineNanos = deadlineAfter(now)
                    return@synchronized null
                }

                val remaining = deadline - now
                if (remaining <= 0L) {
                    nextDeadlineNanos = deadlineAfter(now)
                    null
                } else {
                    WaitRequest(remaining, resetGeneration)
                }
            }

            if (wait == null) return
            if (Thread.interrupted()) return

            waiter.waitNanos(wait.remainingNanos)

            // Re-check the deadline after parking. This handles early returns
            // from the waiter and a concurrent reset without spinning.
            val wasReset = synchronized(lock) { wait.generation != resetGeneration }
            if (wasReset) {
                // The reset cleared nextDeadlineNanos; the next loop
                // iteration will grant the first callback of that epoch.
                continue
            }
        }
    }

    private fun deadlineAfter(nowNanos: Long): Long =
        if (nowNanos > Long.MAX_VALUE - intervalNanos) Long.MAX_VALUE
        else nowNanos + intervalNanos

    private data class WaitRequest(
        val remainingNanos: Long,
        val generation: Long,
    )

    companion object {
        const val DEFAULT_INTERVAL_NANOS = 10_000_000L // 10 ms / 480 samples at 48 kHz mono.
    }
}
