package com.roomsound.android.transport

import com.roomsound.android.room.Pcm16RelayPacket
import com.roomsound.android.room.Pcm16RelayPacketCodec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** These tests run the production writer, queue and codec, not a startup policy. */
class Pcm16RelayPlayerTest {
    @Test
    fun fillsActualHundredMillisecondOutputBeforePlayForBothPacketSizes() {
        for (samples in listOf(480, 960)) {
            val prioritySet = AtomicBoolean()
            val output = Output(capacity = 9_600)
            output.beforeWrite = { assertTrue(prioritySet.get()) }
            player(output, priority = { prioritySet.set(true) }).use { player ->
                assertTrue(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
                val packets = (0 until 4_800 / samples).map { packet(it.toLong(), samples) }
                packets.forEach { assertTrue(player.play(it)) }
                output.await { playCount == 1 }
                assertEquals(9_600, output.bytesAtPlay)
                assertTrue(output.calls().all { !it.blocking })
                assertArrayEquals(concat(packets), output.bytes())
            }
            assertEquals(1, output.closeCount)
        }
    }

    @Test
    fun steadyAndBurstyFramesStayBlockingAfterPrimeEvenWhenSoftwareQueueDrains() {
        for (samples in listOf(480, 960)) {
            val output = Output(capacity = samples * 2)
            player(output).use { player ->
                player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
                val packets = (0L..15L).map { packet(it, samples) }
                player.play(packets.first())
                output.await { playCount == 1 }
                // Each of these arrives only after the preceding frame has
                // drained completely from the software queue/output write.
                for (index in 1..6) {
                    player.play(packets[index])
                    output.await { byteCount == (index + 1) * samples * 2 }
                }
                for (batch in packets.drop(7).chunked(3)) {
                    batch.forEach { player.play(it) }
                    val expected = (batch.last().sequence + 1).toInt() * samples * 2
                    output.await { byteCount == expected }
                }
                assertEquals(1, output.playCount)
                assertEquals(0, output.interruptCount)
                assertTrue(output.calls().drop(1).all { it.blocking })
                assertArrayEquals(concat(packets), output.bytes())
                assertEquals(0L, player.droppedFrames())
            }
        }
    }

    @Test
    fun hundredMillisecondHardwarePrefillAbsorbsBurstsWithoutRebuffering() {
        for (samples in listOf(480, 960)) {
            val output = Output(capacity = 9_600, manualConsumption = true)
            player(output).use { player ->
                player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
                val packets = mutableListOf<Pcm16RelayPacket>()
                fun send(count: Int) {
                    repeat(count) {
                        val next = packet(packets.size.toLong(), samples)
                        packets.add(next)
                        assertTrue(player.play(next))
                    }
                    output.await { byteCount == packets.size * samples * 2 }
                }
                send(4_800 / samples)
                output.await { playCount == 1 }
                repeat(4) {
                    // Source delivery pauses for 60 ms while the hardware
                    // continues consuming. Then 60 ms arrives as one burst.
                    repeat(6) { output.consume(960) }
                    send(2_880 / samples)
                }
                assertEquals(0, output.underrunBytes)
                assertEquals(1, output.playCount)
                assertEquals(0, output.interruptCount)
                assertArrayEquals(concat(packets), output.bytes())
            }
        }
    }

    @Test
    fun hardwareCapacityMaySplitAPacketBetweenPrimeAndBlockingPlayback() {
        val output = Output(capacity = 2_400)
        player(output).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val packets = listOf(packet(0, 960), packet(1, 960))
            packets.forEach { player.play(it) }
            output.await { byteCount == 3_840 }
            assertEquals(2_400, output.bytesAtPlay)
            assertArrayEquals(concat(packets), output.bytes())
            assertEquals(WriteCall(480, 1_440, true), output.calls().last())
        }
    }

    @Test
    fun partialWritesPreserveEveryPcmByteAcrossCodecQueueAndOutput() {
        val output = Output(capacity = 9_600, maxWrite = 318)
        player(output).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val packets = (0L..5L).map { packet(it, 960) }
            packets.forEach { player.play(it) }
            output.await { byteCount == 11_520 }
            assertEquals(9_600, output.bytesAtPlay)
            assertArrayEquals(concat(packets), output.bytes())
            assertTrue(output.calls().any { it.offset > 0 && !it.blocking })
            assertTrue(output.calls().any { it.offset > 0 && it.blocking })
            assertEquals(1, output.playCount)
        }
    }

    @Test
    fun nonblockingAndBlockingZeroWritesRetainTheUnwrittenTail() {
        val output = Output(capacity = 9_600, results = listOf(0, 400, 0, 0, 200))
        player(output).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val packet = packet(0, 960)
            player.play(packet)
            output.await { byteCount == packet.payload.size }
            assertEquals(400, output.bytesAtPlay)
            assertArrayEquals(packet.payload, output.bytes())
            assertEquals(listOf(false, false, false, true, true, true), output.calls().map { it.blocking })
            assertEquals(0L, player.droppedFrames())
        }
    }

    @Test
    fun oneIsolatedPacketStartsAfterBoundedWaitWithoutPaddingOrEmptyPlay() {
        val output = Output(capacity = 9_600)
        player(output, timeoutMillis = 40).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            assertEquals(0, output.playCount)
            assertEquals(0, output.byteCount)
            val begin = System.nanoTime()
            val packet = packet(0)
            player.play(packet)
            output.await { playCount == 1 }
            val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - begin)
            assertTrue("Must wait for the bounded prefill deadline: $elapsedMillis", elapsedMillis >= 35)
            assertTrue("An isolated packet must not wait for another packet", elapsedMillis < 2_000)
            assertEquals(960, output.bytesAtPlay)
            assertArrayEquals(packet.payload, output.bytes())
        }
    }

    @Test
    fun permanentlyZeroOutputTimesOutWithoutBusySpinOrPlayingEmptyAudio() {
        val output = Output(capacity = 9_600, maxWrite = 0)
        val failed = CountDownLatch(1)
        player(output, timeoutMillis = 30, status = { failed.countDown() }).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            player.play(packet(0))
            await(failed)
            assertEquals(0, output.playCount)
            assertEquals(0, output.byteCount)
            assertEquals(1, output.closeCount)
            assertNull(player.currentEpoch())
            assertTrue(output.calls().size in 1..100)
        }
    }

    @Test
    fun stalledBlockingOutputAlsoTimesOutWithoutDiscardingOrSpinning() {
        val output = Output(capacity = 960, results = listOf(960))
        val failed = CountDownLatch(1)
        player(output, status = { failed.countDown() }).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val first = packet(0)
            player.play(first)
            output.await { playCount == 1 }
            output.maxWrite = 0
            player.play(packet(1))
            await(failed)
            assertArrayEquals(first.payload, output.bytes())
            assertEquals(1, output.closeCount)
            assertTrue(output.calls().size in 2..150)
        }
    }

    @Test
    fun stopInterruptsBlockedWriteBeforeReleaseWithoutWaitingForWriterLock() {
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val output = Output(capacity = 960)
        output.beforeWrite = { if (it.blocking) { entered.countDown(); await(resume) } }
        output.onInterrupt = { resume.countDown() }
        player(output).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            player.play(packet(0))
            output.await { playCount == 1 }
            player.play(packet(1))
            await(entered)
            val stop = async { player.stop(EPOCH) }
            stop.get(1, TimeUnit.SECONDS)
            output.await { closeCount == 1 }
            assertNull(player.currentEpoch())
            assertEquals(1, output.interruptCount)
            assertFalse(output.closedDuringWrite)
            assertFalse(player.play(packet(2)))
        }
    }

    @Test
    fun closeInterruptsAnActuallyFullBlockingOutputAndReleasesItOnce() {
        val output = Output(capacity = 960, manualConsumption = true)
        val player = player(output)
        try {
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            player.play(packet(0))
            output.await { playCount == 1 }
            player.play(packet(1))
            output.await { waitingWrites > 0 }
            async { player.close() }.get(1, TimeUnit.SECONDS)
            assertEquals(1, output.closeCount)
            assertEquals(1, output.interruptCount)
            assertFalse(output.closedDuringWrite)
            assertFalse(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
        } finally {
            player.close()
        }
    }

    @Test
    fun sameEpochRestartCannotWriteAnOldPartialFrameIntoNewOutput() {
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val first = Output(capacity = 960, results = listOf(960, 200))
        first.beforeWrite = { if (it.blocking && it.offset == 200) { entered.countDown(); await(resume) } }
        val second = Output(capacity = 960)
        val outputs = ConcurrentLinkedQueue(listOf(first, second))
        Pcm16RelayPlayer({ outputs.remove() }, {}, startupTimeoutNanos = TimeUnit.SECONDS.toNanos(1)).use { player ->
            try {
                player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
                player.play(packet(0))
                first.await { playCount == 1 }
                player.play(packet(1))
                await(entered)
                player.play(packet(2)) // Must be cleared, along with the in-flight tail.
                async { player.stop(EPOCH) }.get(1, TimeUnit.SECONDS)
                assertEquals(0, first.closeCount) // Release waits for the write to return.
                assertTrue(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
                val fresh = packet(0, seed = 67)
                assertTrue(player.play(fresh)) // Sequence tracking resets with the session.
                resume.countDown()
                second.await { byteCount == fresh.payload.size && playCount == 1 }
                assertArrayEquals(fresh.payload, second.bytes())
                assertEquals(EPOCH, player.currentEpoch())
                assertEquals(1, first.closeCount)
                assertFalse(first.closedDuringWrite)
            } finally {
                resume.countDown()
            }
        }
    }

    @Test
    fun stopDuringOutputConstructionRevokesThatGenerationEvenForSameEpoch() {
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val first = Output()
        val second = Output()
        val creates = AtomicInteger()
        Pcm16RelayPlayer({
            if (creates.getAndIncrement() == 0) {
                entered.countDown()
                await(resume)
                first
            } else second
        }, {}).use { player ->
            try {
                val starting = async { player.start(Pcm16RelayPlayer.FORMAT, EPOCH) }
                await(entered)
                player.stop(EPOCH)
                assertTrue(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
                resume.countDown()
                assertFalse(starting.get(1, TimeUnit.SECONDS))
                assertEquals(1, first.closeCount)
                assertEquals(0, first.playCount)
                assertEquals(EPOCH, player.currentEpoch())
                val packet = packet(0)
                player.play(packet)
                second.await { playCount == 1 }
                assertArrayEquals(packet.payload, second.bytes())
            } finally {
                resume.countDown()
            }
        }
    }

    @Test
    fun closeDuringOutputConstructionReleasesItWithoutSchedulingAudio() {
        val entered = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val output = Output()
        val player = Pcm16RelayPlayer({ entered.countDown(); await(resume); output }, {})
        try {
            val starting = async { player.start(Pcm16RelayPlayer.FORMAT, EPOCH) }
            await(entered)
            player.close()
            resume.countDown()
            assertFalse(starting.get(1, TimeUnit.SECONDS))
            assertEquals(1, output.closeCount)
            assertEquals(0, output.playCount)
            assertFalse(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
        } finally {
            resume.countDown()
            player.close()
        }
    }

    @Test
    fun forwardUint32WrapIsAcceptedWhileDuplicatesStaleAndHalfRangeAreRejected() {
        val output = Output()
        player(output).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val packets = listOf(0xFFFF_FFFEL, 0xFFFF_FFFFL, 0L, 1L, 3L).map { packet(it) }
            packets.take(4).forEach { assertTrue(player.play(it)) }
            assertFalse(player.play(packet(1)))
            assertFalse(player.play(packet(0)))
            assertFalse(player.play(packet(0xFFFF_FFFFL)))
            assertFalse(player.play(packet(0x8000_0001L)))
            assertFalse(player.play(packet(2, epoch = EPOCH + 1)))
            assertTrue(player.play(packets.last()))
            output.await { byteCount == 5 * 960 }
            assertArrayEquals(concat(packets), output.bytes())
            assertEquals(4L, player.rejectedSequenceFrames())
            assertEquals(1L, player.missingSequenceFrames())
        }
    }

    @Test
    fun staleEpochStopAndPacketsCannotRevokeNewEpoch() {
        val first = Output()
        val second = Output()
        val outputs = ConcurrentLinkedQueue(listOf(first, second))
        Pcm16RelayPlayer({ outputs.remove() }, {}).use { player ->
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            player.play(packet(0))
            first.await { playCount == 1 }
            assertTrue(player.start(Pcm16RelayPlayer.FORMAT, EPOCH + 1))
            player.stop(EPOCH)
            assertFalse(player.play(packet(1)))
            val fresh = packet(0, epoch = EPOCH + 1)
            assertTrue(player.play(fresh))
            second.await { playCount == 1 }
            assertArrayEquals(fresh.payload, second.bytes())
            assertEquals(EPOCH + 1, player.currentEpoch())
            assertEquals(1, first.closeCount)
        }
    }

    @Test
    fun softwareBacklogIsBoundedByDurationForBothTenAndTwentyMillisecondPackets() {
        for (samples in listOf(480, 960)) {
            val resume = CountDownLatch(1)
            val output = Output(capacity = 9_600)
            player(output, priority = { await(resume) }, maxFrames = 100).use { player ->
                try {
                    player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
                    val packets = (0L..19L).map { packet(it, samples) }
                    packets.forEach { assertTrue(player.play(it)) }
                    val retainedCount = 5_760 / samples
                    assertEquals((20 - retainedCount).toLong(), player.droppedFrames())
                    resume.countDown()
                    output.await { byteCount == 11_520 }
                    assertArrayEquals(concat(packets.takeLast(retainedCount)), output.bytes())
                } finally {
                    resume.countDown()
                }
            }
        }
    }

    @Test
    fun configuredPacketLimitStillAppliesAndQueuedPayloadIsAnOwnedCopy() {
        val resume = CountDownLatch(1)
        val output = Output(capacity = 1_920)
        player(output, priority = { await(resume) }, maxFrames = 2).use { player ->
            try {
                player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
                val packets = (0L..4L).map { packet(it) }
                packets.forEach { player.play(it) }
                val expected = concat(packets.takeLast(2))
                packets.forEach { it.payload.fill(0); it.samples.fill(0) }
                assertEquals(3L, player.droppedFrames())
                resume.countDown()
                output.await { playCount == 1 }
                assertArrayEquals(expected, output.bytes())
            } finally {
                resume.countDown()
            }
        }
    }

    @Test
    fun invalidPacketsDoNotAdvanceSequenceOrReachOutput() {
        val output = Output()
        player(output).use { player ->
            assertFalse(player.start(Pcm16AudioFormat(44_100, 1), EPOCH))
            assertFalse(player.start(Pcm16RelayPlayer.FORMAT, -1))
            assertTrue(player.start(Pcm16RelayPlayer.FORMAT, EPOCH))
            val valid = packet(0)
            val invalid = listOf(
                valid.copy(sampleRate = 44_100), valid.copy(channels = 2),
                valid.copy(sequence = -1), valid.copy(sequence = 0x1_0000_0000L),
                valid.copy(sampleCount = 0), valid.copy(sampleCount = 961),
                valid.copy(payload = ByteArray(959)),
            )
            invalid.forEach { assertFalse(player.play(it)) }
            assertTrue(player.play(valid))
            output.await { playCount == 1 }
            assertArrayEquals(valid.payload, output.bytes())
            assertEquals(0L, player.missingSequenceFrames())
        }
    }

    @Test
    fun volumeAndMuteStayOutputControlsAndNeverAlterPcmSamples() {
        val output = Output()
        player(output).use { player ->
            player.setVolume(0.0)
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            val packet = packet(0)
            player.play(packet)
            output.await { playCount == 1 }
            assertEquals(0f, output.appliedVolume, 0f)
            player.setVolume(0.25)
            assertEquals(0.25f, output.appliedVolume, 0f)
            player.setVolume(Double.NaN)
            player.setVolume(Double.POSITIVE_INFINITY)
            assertEquals(0.25f, output.appliedVolume, 0f)
            player.setVolume(2.0)
            assertEquals(1f, output.appliedVolume, 0f)
            player.setVolume(-1.0)
            assertEquals(0f, output.appliedVolume, 0f)
            assertArrayEquals(packet.payload, output.bytes())
        }
    }

    @Test
    fun failedWriterCleansUpBeforeCallbackAndCallbackMayClosePlayer() {
        val output = Output(results = listOf(-6))
        val reported = CountDownLatch(1)
        lateinit var player: Pcm16RelayPlayer
        player = player(output, status = {
            assertNull(player.currentEpoch())
            assertEquals(1, output.closeCount)
            player.close()
            reported.countDown()
        })
        player.use {
            player.start(Pcm16RelayPlayer.FORMAT, EPOCH)
            player.play(packet(0))
            await(reported)
            assertEquals(0, output.playCount)
            assertFalse(player.play(packet(1)))
        }
    }

    private fun player(
        output: Output,
        timeoutMillis: Long = 1_000,
        priority: () -> Unit = {},
        maxFrames: Int = Pcm16RelayPlayer.DEFAULT_MAX_QUEUED_FRAMES,
        status: (String) -> Unit = {},
    ) = Pcm16RelayPlayer(
        outputFactory = { output },
        audioThreadPriority = priority,
        maxQueuedFrames = maxFrames,
        onStatus = status,
        startupTimeoutNanos = TimeUnit.MILLISECONDS.toNanos(timeoutMillis),
    )

    private fun packet(sequence: Long, samples: Int = 480, epoch: Long = EPOCH, seed: Int = sequence.toInt()): Pcm16RelayPacket {
        // Include both rails, silence, signed low-amplitude samples and a
        // changing pattern. The output assertion compares exact LE bytes.
        val values = ShortArray(samples) { index ->
            when (index % 9) {
                0 -> Short.MIN_VALUE
                1 -> Short.MAX_VALUE
                2 -> 0
                3 -> -1
                4 -> 1
                else -> (index * 631 + seed * 31).toShort()
            }
        }
        return Pcm16RelayPacketCodec.decode(Pcm16RelayPacketCodec.encode(values, sourceEpoch = epoch, sequence = sequence))
    }

    private fun concat(packets: List<Pcm16RelayPacket>): ByteArray =
        ByteArrayOutputStream().apply { packets.forEach { write(it.payload) } }.toByteArray()

    private data class WriteCall(val offset: Int, val count: Int, val blocking: Boolean)

    /** Models a stopped hardware FIFO, then a consuming output after play(). */
    private class Output(
        capacity: Int = 960,
        @Volatile var maxWrite: Int = Int.MAX_VALUE,
        results: List<Int> = emptyList(),
        private val manualConsumption: Boolean = false,
    ) : Pcm16RelayAudioOutput {
        override val bufferCapacityBytes = capacity
        private val lock = Object()
        private val received = ByteArrayOutputStream()
        private val writes = mutableListOf<WriteCall>()
        private val scripted = ConcurrentLinkedQueue(results)
        private var inWrite = 0
        private var buffered = 0
        @Volatile var beforeWrite: (WriteCall) -> Unit = {}
        @Volatile var onInterrupt: () -> Unit = {}
        @Volatile var playCount = 0
        @Volatile var bytesAtPlay = 0
        @Volatile var closeCount = 0
        @Volatile var interruptCount = 0
        @Volatile var closedDuringWrite = false
        @Volatile var appliedVolume = 1f
        @Volatile var underrunBytes = 0
        @Volatile var waitingWrites = 0
        val byteCount: Int get() = synchronized(lock) { received.size() }

        override fun write(bytes: ByteArray, offset: Int, count: Int, blocking: Boolean): Int {
            val call = WriteCall(offset, count, blocking)
            synchronized(lock) {
                check(closeCount == 0)
                check(!blocking || playCount > 0) { "Blocking write before playback would deadlock a stopped full track." }
                writes.add(call)
                inWrite++
            }
            try {
                beforeWrite(call)
                return synchronized(lock) {
                    while (blocking && manualConsumption && buffered == bufferCapacityBytes && interruptCount == 0) {
                        waitingWrites++
                        lock.notifyAll()
                        try { lock.wait() } finally { waitingWrites-- }
                    }
                    if (interruptCount > 0) return@synchronized -3
                    val result = scripted.poll() ?: maxWrite
                    if (result < 0) return@synchronized result
                    val room = if (blocking && !manualConsumption) Int.MAX_VALUE else bufferCapacityBytes - buffered
                    val accepted = minOf(count, result, room)
                    received.write(bytes, offset, accepted)
                    if (!blocking || manualConsumption) buffered += accepted
                    lock.notifyAll()
                    accepted
                }
            } finally {
                synchronized(lock) { inWrite--; lock.notifyAll() }
            }
        }

        override fun play(primedBytes: Int) = synchronized(lock) {
            check(primedBytes > 0 && primedBytes == received.size())
            check(closeCount == 0 && interruptCount == 0)
            bytesAtPlay = primedBytes
            playCount++
            lock.notifyAll()
        }

        override fun setVolume(volume: Float) { appliedVolume = volume }

        override fun interrupt() {
            synchronized(lock) { interruptCount++; lock.notifyAll() }
            onInterrupt()
        }

        override fun close() = synchronized(lock) {
            closedDuringWrite = inWrite > 0
            closeCount++
            lock.notifyAll()
        }

        fun bytes(): ByteArray = synchronized(lock) { received.toByteArray() }
        fun calls(): List<WriteCall> = synchronized(lock) { writes.toList() }

        fun consume(count: Int) = synchronized(lock) {
            check(manualConsumption && playCount > 0)
            underrunBytes += (count - buffered).coerceAtLeast(0)
            buffered = (buffered - count).coerceAtLeast(0)
            lock.notifyAll()
        }

        fun await(condition: Output.() -> Boolean) = synchronized(lock) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (!condition()) {
                val remaining = deadline - System.nanoTime()
                assertTrue("Timed out: bytes=${received.size()}, play=$playCount, close=$closeCount", remaining > 0)
                TimeUnit.NANOSECONDS.timedWait(lock, remaining)
            }
        }
    }

    companion object {
        private const val EPOCH = 7L

        private fun await(latch: CountDownLatch) {
            assertTrue("Timed out waiting for writer barrier", latch.await(2, TimeUnit.SECONDS))
        }

        private fun <T> async(action: () -> T): FutureTask<T> = FutureTask(action).also {
            Thread(it, "relay-test-control").apply { isDaemon = true }.start()
        }
    }
}
