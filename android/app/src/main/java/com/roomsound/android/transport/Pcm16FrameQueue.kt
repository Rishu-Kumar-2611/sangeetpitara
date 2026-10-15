package com.roomsound.android.transport

import java.nio.ByteBuffer

/**
 * A bounded PCM16 sample FIFO used at the JavaAudioDeviceModule boundary.
 *
 * The capture callback and WebRTC's audio callback run on different threads.
 * The critical sections only copy the small 10 ms buffers, and the queue
 * drops the oldest samples when it is full so a stalled producer cannot grow
 * latency without bound.
 */
internal class Pcm16FrameQueue(
    private val capacitySamples: Int = DEFAULT_CAPACITY_SAMPLES,
    private val expectedFormat: Pcm16AudioFormat = Pcm16AudioFormat(48_000, 1),
) {
    data class EnqueueResult(
        val acceptedSamples: Int,
        val droppedSamples: Int,
    )

    private val lock = Any()
    private val samples = ShortArray(capacitySamples.also {
        require(it > 0) { "capacitySamples must be positive." }
    })
    private var readIndex = 0
    private var size = 0
    private var activeEpoch: Long? = null
    private var droppedSamples = 0L
    private var underrunSamples = 0L
    private var enqueuedSamples = 0L
    private var drainedSamples = 0L
    private var callbackCount = 0L
    private var revocationCount = 0L

    /** Binds the FIFO to a fresh source epoch and removes all previous audio. */
    fun bind(sourceEpoch: Long) = synchronized(lock) {
        clearLocked()
        activeEpoch = sourceEpoch
    }

    /** Revokes the current epoch. A stale stop cannot revoke a newer epoch. */
    fun revoke(sourceEpoch: Long? = null) = synchronized(lock) {
        if (sourceEpoch != null && activeEpoch != sourceEpoch) return
        clearLocked()
        activeEpoch = null
        revocationCount += 1
    }

    fun offer(frame: Pcm16Frame): Pcm16PublishResult = synchronized(lock) {
        when {
            activeEpoch == null -> Pcm16PublishResult.DROPPED_UNAUTHORIZED
            activeEpoch != frame.sourceEpoch -> Pcm16PublishResult.DROPPED_STALE_EPOCH
            frame.format != expectedFormat || frame.sampleCount !in 1..frame.samples.size ->
                Pcm16PublishResult.INVALID_FORMAT
            else -> {
                offerLocked(frame.samples, frame.sampleCount)
                Pcm16PublishResult.PUBLISHED
            }
        }
    }

    /**
     * Fully overwrites an ADM callback buffer. Any missing samples remain zero,
     * including the entire buffer after revoke or before the first frame.
     * Returns the number of queued samples copied into the buffer.
     */
    fun fillAudioBuffer(buffer: ByteBuffer): Int = synchronized(lock) {
        callbackCount += 1
        buffer.clear()
        while (buffer.hasRemaining()) buffer.put(0)
        buffer.clear()

        val requestedSamples = buffer.capacity() / BYTES_PER_SAMPLE
        if (activeEpoch == null || requestedSamples == 0) {
            underrunSamples += requestedSamples.toLong()
            buffer.position(0)
            return@synchronized 0
        }

        val copied = minOf(size, requestedSamples)
        repeat(copied) { index ->
            val sample = samples[(readIndex + index) % capacitySamples]
            val byteOffset = index * BYTES_PER_SAMPLE
            // Write explicitly as little endian; ADM supplies PCM16LE to the
            // native audio sender regardless of the JVM's default byte order.
            buffer.put(byteOffset, (sample.toInt() and 0xff).toByte())
            buffer.put(byteOffset + 1, (sample.toInt() ushr 8 and 0xff).toByte())
        }
        readIndex = (readIndex + copied) % capacitySamples
        size -= copied
        drainedSamples += copied.toLong()
        if (copied < requestedSamples) underrunSamples += (requestedSamples - copied).toLong()
        buffer.position(0)
        copied
    }

    fun queuedSamples(): Int = synchronized(lock) { size }

    fun droppedSamples(): Long = synchronized(lock) { droppedSamples }

    fun underrunSamples(): Long = synchronized(lock) { underrunSamples }

    fun enqueuedSamples(): Long = synchronized(lock) { enqueuedSamples }

    fun drainedSamples(): Long = synchronized(lock) { drainedSamples }

    fun callbackCount(): Long = synchronized(lock) { callbackCount }

    fun revocationCount(): Long = synchronized(lock) { revocationCount }

    fun currentEpoch(): Long? = synchronized(lock) { activeEpoch }

    private fun offerLocked(input: ShortArray, inputCount: Int) {
        var sourceOffset = 0
        var count = inputCount

        if (count >= capacitySamples) {
            // Keep only the newest complete window from an oversized frame.
            sourceOffset = count - capacitySamples
            count = capacitySamples
            droppedSamples += size.toLong() + sourceOffset.toLong()
            readIndex = 0
            size = 0
        } else {
            val overflow = (size + count - capacitySamples).coerceAtLeast(0)
            if (overflow > 0) {
                readIndex = (readIndex + overflow) % capacitySamples
                size -= overflow
                droppedSamples += overflow.toLong()
            }
        }

        val writeIndex = (readIndex + size) % capacitySamples
        repeat(count) { index ->
            samples[(writeIndex + index) % capacitySamples] = input[sourceOffset + index]
        }
        size += count
        enqueuedSamples += count.toLong()
    }

    private fun clearLocked() {
        readIndex = 0
        size = 0
    }

    companion object {
        const val DEFAULT_CAPACITY_SAMPLES = 9_600 // 200 ms at 48 kHz mono.
        private const val BYTES_PER_SAMPLE = 2
    }
}
