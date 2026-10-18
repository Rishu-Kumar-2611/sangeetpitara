package com.roomsound.android.transport

import java.nio.ByteBuffer
import kotlin.math.sqrt

/** PCM signal measurements collected without changing the samples being sent. */
internal data class Pcm16SignalStats(
    val samples: Long = 0,
    val nonZeroSamples: Long = 0,
    val minSample: Int? = null,
    val maxSample: Int? = null,
    val rms: Double? = null,
)

/** Measurements on both sides of the JavaAudioDeviceModule callback boundary. */
internal data class Pcm16BoundaryDiagnostics(
    val offered: Pcm16SignalStats,
    val admBuffer: Pcm16SignalStats,
    val lastOffered: Pcm16SignalStats,
    val lastAdmBuffer: Pcm16SignalStats,
    val capacitySamples: Int = 0,
    val peakQueuedSamples: Int = 0,
    val lastAdmCallbackIntervalNanos: Long? = null,
    val lastAdmReportedBytes: Int? = null,
    val lastAdmBufferBytes: Int? = null,
    val lastAdmAudioFormat: Int? = null,
    val lastAdmChannels: Int? = null,
    val lastAdmSampleRate: Int? = null,
)

private class Pcm16SignalAccumulator {
    private var samples = 0L
    private var nonZeroSamples = 0L
    private var minSample = Int.MAX_VALUE
    private var maxSample = Int.MIN_VALUE
    private var sumSquares = 0.0

    fun reset() {
        samples = 0L
        nonZeroSamples = 0L
        minSample = Int.MAX_VALUE
        maxSample = Int.MIN_VALUE
        sumSquares = 0.0
    }

    fun add(input: ShortArray, offset: Int, count: Int) {
        repeat(count) { index -> addSample(input[offset + index].toInt()) }
    }

    fun addPcm16Le(buffer: ByteBuffer, sampleCount: Int) {
        repeat(sampleCount) { index ->
            val byteOffset = index * BYTES_PER_SAMPLE
            val sample = (buffer.get(byteOffset + 1).toInt() shl 8) or
                (buffer.get(byteOffset).toInt() and 0xff)
            addSample(sample)
        }
    }

    private fun addSample(sample: Int) {
        samples += 1
        if (sample != 0) nonZeroSamples += 1
        minSample = minOf(minSample, sample)
        maxSample = maxOf(maxSample, sample)
        sumSquares += sample.toDouble() * sample.toDouble()
    }

    fun snapshot(): Pcm16SignalStats = if (samples == 0L) {
        Pcm16SignalStats()
    } else {
        Pcm16SignalStats(
            samples = samples,
            nonZeroSamples = nonZeroSamples,
            minSample = minSample,
            maxSample = maxSample,
            rms = sqrt(sumSquares / samples.toDouble()),
        )
    }

    companion object {
        private const val BYTES_PER_SAMPLE = 2
    }
}

/**
 * A bounded PCM16 sample FIFO used at the JavaAudioDeviceModule boundary.
 *
 * The capture callback and WebRTC's audio callback run on different threads.
 * The critical sections only copy the small 10 ms buffers, and the queue
 * drops the oldest samples when it is full so a stalled producer cannot grow
 * latency without bound. ADM callback completion is paced by
 * [Pcm16FramePacer] outside the queue lock.
 */
internal class Pcm16FrameQueue(
    private val capacitySamples: Int = DEFAULT_CAPACITY_SAMPLES,
    private val expectedFormat: Pcm16AudioFormat = Pcm16AudioFormat(48_000, 1),
    private val framePacer: Pcm16FramePacer = Pcm16FramePacer(),
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
    private var peakQueuedSamples = 0
    private var lastAdmCallbackStartedAtNanos: Long? = null
    private var lastAdmCallbackIntervalNanos: Long? = null
    private val offeredSignal = Pcm16SignalAccumulator()
    private val admBufferSignal = Pcm16SignalAccumulator()
    private var lastAdmReportedBytes: Int? = null
    private var lastAdmBufferBytes: Int? = null
    private var lastAdmAudioFormat: Int? = null
    private var lastAdmChannels: Int? = null
    private var lastAdmSampleRate: Int? = null
    private val lastOfferedAccumulator = Pcm16SignalAccumulator()
    private val lastAdmBufferAccumulator = Pcm16SignalAccumulator()

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

    fun offer(frame: Pcm16Frame): Pcm16PublishResult = try { synchronized(lock) {
        when {
            activeEpoch == null -> Pcm16PublishResult.DROPPED_UNAUTHORIZED
            activeEpoch != frame.sourceEpoch -> Pcm16PublishResult.DROPPED_STALE_EPOCH
            frame.format != expectedFormat || frame.sampleCount !in 1..frame.samples.size ->
                Pcm16PublishResult.INVALID_FORMAT
            else -> {
                offeredSignal.add(frame.samples, 0, frame.sampleCount)
                lastOfferedAccumulator.reset()
                lastOfferedAccumulator.add(frame.samples, 0, frame.sampleCount)
                offerLocked(frame.samples, frame.sampleCount)
                peakQueuedSamples = maxOf(peakQueuedSamples, size)
                Pcm16PublishResult.PUBLISHED
            }
        }
    } } catch (t: Throwable) { android.util.Log.e("RoomSound", "offer failed", t); Pcm16PublishResult.BACKEND_UNAVAILABLE }

    /**
     * Fully overwrites an ADM callback buffer. Any missing samples remain zero,
     * including the entire buffer after revoke or before the first frame.
     * Returns the number of queued samples copied into the buffer.
     */
    fun fillAudioBuffer(
        buffer: ByteBuffer,
        reportedBytes: Int? = null,
        audioFormat: Int? = null,
        channels: Int? = null,
        sampleRate: Int? = null,
    ): Int = try {
        val requestedSamples = buffer.capacity() / BYTES_PER_SAMPLE
        val callbackStartedAtNanos = System.nanoTime()
        val shouldPace = synchronized(lock) {
            lastAdmCallbackIntervalNanos = lastAdmCallbackStartedAtNanos?.let {
                (callbackStartedAtNanos - it).coerceAtLeast(0L)
            }
            lastAdmCallbackStartedAtNanos = callbackStartedAtNanos
            callbackCount += 1
            lastAdmReportedBytes = reportedBytes
            lastAdmBufferBytes = buffer.capacity()
            lastAdmAudioFormat = audioFormat
            lastAdmChannels = channels
            lastAdmSampleRate = sampleRate
            requestedSamples > 0
        }

        // The recordingless ADM callback forwards the complete buffer to
        // native immediately after this method returns. Pace that return
        // outside the queue lock so native receives one 10 ms buffer at a
        // time without blocking offer/bind/revoke operations.
        if (shouldPace) framePacer.awaitNextBuffer()

        synchronized(lock) {
            buffer.clear()
            while (buffer.hasRemaining()) buffer.put(0)
            buffer.clear()

            if (activeEpoch == null || requestedSamples == 0) {
                underrunSamples += requestedSamples.toLong()
                buffer.position(0)
                lastAdmBufferAccumulator.reset()
                lastAdmBufferAccumulator.addPcm16Le(buffer, requestedSamples)
                admBufferSignal.addPcm16Le(buffer, requestedSamples)
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
            lastAdmBufferAccumulator.reset()
            lastAdmBufferAccumulator.addPcm16Le(buffer, requestedSamples)
            admBufferSignal.addPcm16Le(buffer, requestedSamples)
            copied
        }
    } catch (t: Throwable) {
        android.util.Log.e("RoomSound", "fillAudioBuffer failed", t)
        try { buffer.clear(); while (buffer.hasRemaining()) buffer.put(0); buffer.clear(); buffer.position(0) } catch (_: Throwable) {}
        0
    }

    fun queuedSamples(): Int = synchronized(lock) { size }

    fun droppedSamples(): Long = synchronized(lock) { droppedSamples }

    fun underrunSamples(): Long = synchronized(lock) { underrunSamples }

    fun enqueuedSamples(): Long = synchronized(lock) { enqueuedSamples }

    fun drainedSamples(): Long = synchronized(lock) { drainedSamples }

    fun callbackCount(): Long = synchronized(lock) { callbackCount }

    fun revocationCount(): Long = synchronized(lock) { revocationCount }

    fun currentEpoch(): Long? = synchronized(lock) { activeEpoch }

    /** Returns a coherent snapshot of PCM values observed before and at the ADM callback. */
    fun pcmDiagnostics(): Pcm16BoundaryDiagnostics = synchronized(lock) {
        Pcm16BoundaryDiagnostics(
            offered = offeredSignal.snapshot(),
            admBuffer = admBufferSignal.snapshot(),
            lastOffered = lastOfferedAccumulator.snapshot(),
            lastAdmBuffer = lastAdmBufferAccumulator.snapshot(),
            capacitySamples = capacitySamples,
            peakQueuedSamples = peakQueuedSamples,
            lastAdmCallbackIntervalNanos = lastAdmCallbackIntervalNanos,
            lastAdmReportedBytes = lastAdmReportedBytes,
            lastAdmBufferBytes = lastAdmBufferBytes,
            lastAdmAudioFormat = lastAdmAudioFormat,
            lastAdmChannels = lastAdmChannels,
            lastAdmSampleRate = lastAdmSampleRate,
        )
    }

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
        framePacer.reset()
    }

    companion object {
        const val DEFAULT_CAPACITY_SAMPLES = 4_800 // 100 ms at 48 kHz mono.
        private const val BYTES_PER_SAMPLE = 2
    }
}
