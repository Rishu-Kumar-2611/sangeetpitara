package com.roomsound.android.nearby

/** Bounds audio work without turning a recorder backlog into a room disconnect. */
internal class NearbyAudioBudget {
    private var available = CAPACITY.toDouble()
    private var updatedAt: Long? = null
    fun allow(bytes: Int, nowMs: Long): Boolean {
        val previous = updatedAt ?: nowMs
        available = minOf(CAPACITY.toDouble(),available + (nowMs-previous).coerceAtLeast(0)*BYTES_PER_MS)
        updatedAt = nowMs
        if(bytes <= 0 || bytes > available) return false
        available -= bytes
        return true
    }
    companion object {
        private const val CAPACITY = 393_216 // Four seconds of current PCM traffic.
        private const val BYTES_PER_MS = 194.0 // About twice the normal 48 kHz mono rate.
    }
}
