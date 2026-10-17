package com.roomsound.android.transport

import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class Pcm16FrameQueueTest {
    @Test
    fun recordsSignalBeforeAndAfterAdmBufferFill() {
        val pacing = DeterministicPacing()
        val queue = Pcm16FrameQueue(capacitySamples = 8, framePacer = pacing.pacer)
        queue.bind(sourceEpoch = 7L)
        val input = shortArrayOf(-1_000, 0, 1_000, 2_000)

        assertEquals(
            Pcm16PublishResult.PUBLISHED,
            queue.offer(
                Pcm16Frame(
                    samples = input,
                    sampleCount = input.size,
                    format = Pcm16AudioFormat(48_000, 1),
                    sourceEpoch = 7L,
                ),
            ),
        )

        val buffer = ByteBuffer.allocateDirect(input.size * 2)
        assertEquals(input.size, queue.fillAudioBuffer(
            buffer = buffer,
            reportedBytes = 0,
            audioFormat = 2,
            channels = 1,
            sampleRate = 48_000,
        ))

        val diagnostics = queue.pcmDiagnostics()
        assertEquals(4L, diagnostics.offered.samples)
        assertEquals(3L, diagnostics.offered.nonZeroSamples)
        assertEquals(-1_000, diagnostics.offered.minSample)
        assertEquals(2_000, diagnostics.offered.maxSample)
        assertTrue((diagnostics.offered.rms ?: 0.0) > 0.0)
        assertEquals(4L, diagnostics.admBuffer.samples)
        assertEquals(3L, diagnostics.admBuffer.nonZeroSamples)
        assertEquals(-1_000, diagnostics.admBuffer.minSample)
        assertEquals(2_000, diagnostics.admBuffer.maxSample)
        assertTrue((diagnostics.admBuffer.rms ?: 0.0) > 0.0)
        assertEquals(0, diagnostics.lastAdmReportedBytes)
        assertEquals(input.size * 2, diagnostics.lastAdmBufferBytes)
        assertEquals(2, diagnostics.lastAdmAudioFormat)
        assertEquals(1, diagnostics.lastAdmChannels)
        assertEquals(48_000, diagnostics.lastAdmSampleRate)
    }

    @Test
    fun recordsZeroPcmWhenAdmCallbackUnderruns() {
        val pacing = DeterministicPacing()
        val queue = Pcm16FrameQueue(capacitySamples = 4, framePacer = pacing.pacer)
        queue.bind(sourceEpoch = 11L)
        queue.offer(
            Pcm16Frame(
                samples = shortArrayOf(3_000, -3_000),
                sampleCount = 2,
                format = Pcm16AudioFormat(48_000, 1),
                sourceEpoch = 11L,
            ),
        )

        val buffer = ByteBuffer.allocateDirect(8)
        queue.fillAudioBuffer(buffer)
        queue.fillAudioBuffer(buffer)

        val diagnostics = queue.pcmDiagnostics()
        assertEquals(8L, diagnostics.admBuffer.samples)
        assertEquals(2L, diagnostics.admBuffer.nonZeroSamples)
        assertEquals(0L, diagnostics.lastAdmBuffer.nonZeroSamples)
        assertEquals(0, diagnostics.lastAdmBuffer.minSample)
        assertEquals(0, diagnostics.lastAdmBuffer.maxSample)
        assertEquals(0.0, diagnostics.lastAdmBuffer.rms ?: -1.0, 0.0)
    }

    @Test
    fun resetsPacingOnBindAndRevoke() {
        val pacing = DeterministicPacing()
        val queue = Pcm16FrameQueue(capacitySamples = 4, framePacer = pacing.pacer)
        val buffer = ByteBuffer.allocateDirect(8)

        queue.bind(sourceEpoch = 1L)
        queue.fillAudioBuffer(buffer)
        queue.fillAudioBuffer(buffer)
        assertEquals(listOf(10L), pacing.waits)

        queue.revoke(sourceEpoch = 1L)
        queue.fillAudioBuffer(buffer)
        assertEquals(listOf(10L), pacing.waits)

        queue.bind(sourceEpoch = 2L)
        queue.fillAudioBuffer(buffer)
        assertEquals(listOf(10L), pacing.waits)
    }

    private class DeterministicPacing {
        var nowNanos = 0L
        val waits = mutableListOf<Long>()
        val pacer = Pcm16FramePacer(
            intervalNanos = 10L,
            clock = Pcm16MonotonicClock { nowNanos },
            waiter = Pcm16PacingWaiter { nanos ->
                waits += nanos
                nowNanos += nanos
            },
        )
    }
}
