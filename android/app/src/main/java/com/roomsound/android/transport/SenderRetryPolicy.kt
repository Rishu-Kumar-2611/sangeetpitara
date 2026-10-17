package com.roomsound.android.transport

/** Bounded retry timing for a native sender that failed without a source revoke. */
internal object SenderRetryPolicy {
    const val INITIAL_DELAY_MS = 1_000L
    const val MAX_DELAY_MS = 30_000L

    fun delayMs(attempt: Int): Long {
        val exponent = attempt.coerceIn(0, 5)
        return (INITIAL_DELAY_MS * (1L shl exponent)).coerceAtMost(MAX_DELAY_MS)
    }
}
