package com.roomsound.android.transport

import com.roomsound.android.room.Pcm16RelayPacket
import com.roomsound.android.room.Pcm16RelayPacketCodec
import java.io.Closeable
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Injectable relay-player seam used by RoomAudioTransport and JVM tests. */
interface Pcm16RelayPlayerSink : Closeable {
    fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean
    fun stop(sourceEpoch: Long? = null)
    fun play(packet: Pcm16RelayPacket): Boolean
    fun currentEpoch(): Long?
    fun setVolume(volume: Double)
}

/**
 * One audio-priority writer, with actual hardware prefill before play(). Once
 * started, AudioTrack's blocking write supplies the clock: an empty software
 * queue never pauses playback or starts another prebuffer cycle.
 *
 * A session owns its queue AND output, so even a same-epoch restart cannot
 * route an old partially written frame into a new track. Stop revokes first,
 * interrupts the output without taking a writer lock, and lets the writer
 * release it after write returns. No microphone or sample processing is used.
 */
class Pcm16RelayPlayer internal constructor(
    private val outputFactory: (Pcm16AudioFormat) -> Pcm16RelayAudioOutput,
    private val audioThreadPriority: () -> Unit,
    private val maxQueuedFrames: Int = DEFAULT_MAX_QUEUED_FRAMES,
    private val maxQueuedBytes: Int = MAX_QUEUED_BYTES,
    private val onStatus: (String) -> Unit = {},
    private val startupTimeoutNanos: Long = TimeUnit.MILLISECONDS.toNanos(120),
    private val nanoTime: () -> Long = System::nanoTime,
    private val catchUpQueuedBytes: Int = Int.MAX_VALUE,
    private val catchUpLandingBytes: Int = 0,
) : Pcm16RelayPlayerSink {
    constructor(
        maxQueuedFrames: Int = DEFAULT_MAX_QUEUED_FRAMES,
        maxQueuedBytes: Int = MAX_QUEUED_BYTES,
        catchUpQueuedBytes: Int = Int.MAX_VALUE,
        catchUpLandingBytes: Int = 0,
        onStatus: (String) -> Unit = {},
    ) : this(
        outputFactory = ::AndroidPcm16RelayAudioOutput,
        audioThreadPriority = { AndroidPcm16RelayAudioOutput.setAudioThreadPriority() },
        maxQueuedFrames = maxQueuedFrames,
        maxQueuedBytes = maxQueuedBytes,
        onStatus = onStatus,
        catchUpQueuedBytes = catchUpQueuedBytes,
        catchUpLandingBytes = catchUpLandingBytes,
    )

    private class Session(val epoch: Long, val output: Pcm16RelayAudioOutput) {
        // Queue/sequence fields are guarded by the player's lock.
        val queue = ArrayDeque<ByteArray>()
        var queuedBytes = 0
        var lastSequence: Long? = null
        var firstPacketAt: Long? = null
        var playbackStarted = false
        @Volatile var cancelled = false
        // Control calls are serialized, but never share a lock with write().
        val outputLock = Any()
        var released = false
        var interrupted = false

        fun interrupt() = synchronized(outputLock) {
            if (!released && !interrupted) {
                interrupted = true
                runCatching { output.interrupt() }
            }
        }

        fun release() = synchronized(outputLock) {
            if (!released) {
                released = true
                runCatching { output.close() }
            }
        }
    }

    private val lock = Object()
    private var closed = false
    private var generation = 0L
    private var startingEpoch: Long? = null
    private var active: Session? = null
    private var volume = 1.0f
    private var dropped = 0L
    private var rejectedSequences = 0L
    private var missingSequences = 0L
    @Volatile private var writerThread: Thread? = null
    private val writer = Executors.newSingleThreadExecutor { task ->
        Thread({
            runCatching { audioThreadPriority() }
            task.run()
        }, "RoomSound-PCM16-Relay-Player").apply {
            isDaemon = true
            writerThread = this
        }
    }

    init {
        require(maxQueuedFrames > 0) { "maxQueuedFrames must be positive." }
        require(maxQueuedBytes > 0) { "maxQueuedBytes must be positive." }
        require(startupTimeoutNanos > 0) { "startupTimeoutNanos must be positive." }
        require(catchUpLandingBytes in 0 until catchUpQueuedBytes) { "catchUpLandingBytes must be below catchUpQueuedBytes." }
    }

    override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean {
        if (format != FORMAT || sourceEpoch !in 0..UINT32_MAX) return false
        val previous: Session?
        val ticket: Long
        synchronized(lock) {
            if (closed) return false
            if (active?.epoch == sourceEpoch) return true
            previous = detachLocked()
            ticket = ++generation
            startingEpoch = sourceEpoch
        }
        previous?.interrupt()
        val session = try {
            Session(sourceEpoch, outputFactory(format))
        } catch (error: Exception) {
            synchronized(lock) { if (generation == ticket) startingEpoch = null }
            report("PCM16 relay output could not initialize: ${error.message}")
            return false
        }
        val installed = synchronized(lock) {
            if (closed || generation != ticket) false else {
                startingEpoch = null
                active = session
                // Scheduling while holding the state lock prevents close from
                // shutting down the executor between installation and submit.
                writer.execute { writeSession(session) }
                true
            }
        }
        if (!installed) session.release()
        return installed
    }

    override fun stop(sourceEpoch: Long?) {
        val session = synchronized(lock) {
            if (sourceEpoch != null && sourceEpoch != active?.epoch && sourceEpoch != startingEpoch) return
            ++generation // Also invalidates an output currently being constructed.
            startingEpoch = null
            detachLocked()
        }
        session?.interrupt()
    }

    override fun play(packet: Pcm16RelayPacket): Boolean = synchronized(lock) {
        val session = active ?: return false
        if (closed || session.epoch != packet.sourceEpoch ||
            packet.sampleRate != FORMAT.sampleRate || packet.channels != FORMAT.channels ||
            packet.sequence !in 0..UINT32_MAX || packet.sampleCount !in 1..960 ||
            packet.payload.size != packet.sampleCount * 2
        ) return false

        session.lastSequence?.let { last ->
            // Serial-number arithmetic: wrap is forward; duplicate, backwards
            // and the ambiguous half-range are rejected before touching audio.
            val distance = (packet.sequence - last) and UINT32_MAX
            if (distance == 0L || distance >= 0x8000_0000L) {
                rejectedSequences++
                return false
            }
            missingSequences += distance - 1
        }
        session.lastSequence = packet.sequence
        if (session.firstPacketAt == null) session.firstPacketAt = nanoTime()
        // Bound duration as well as packet count: 10 ms and 20 ms publishers
        // receive the same configured maximum software backlog.
        while (session.queue.size >= maxQueuedFrames ||
            session.queuedBytes + packet.payload.size > maxQueuedBytes
        ) {
            session.queuedBytes -= session.queue.removeFirst().size
            dropped++
        }
        val payload = packet.payload.copyOf()
        session.queue.addLast(payload)
        session.queuedBytes += payload.size
        // The blocking write is the clock, so a backlog left by a network stall
        // would otherwise play late forever. Once playing, skip it in one jump.
        if (session.playbackStarted && session.queuedBytes > catchUpQueuedBytes) {
            while (session.queuedBytes > catchUpLandingBytes && session.queue.size > 1) {
                session.queuedBytes -= session.queue.removeFirst().size
                dropped++
            }
        }
        lock.notifyAll()
        true
    }

    override fun currentEpoch(): Long? = synchronized(lock) { active?.epoch }

    override fun setVolume(volume: Double) {
        if (!volume.isFinite()) return
        val session = synchronized(lock) {
            if (closed) return
            this.volume = volume.coerceIn(0.0, 1.0).toFloat()
            active
        } ?: return
        synchronized(session.outputLock) {
            if (!session.cancelled && !session.released) {
                val latest = synchronized(lock) { this.volume }
                runCatching { session.output.setVolume(latest) }
            }
        }
    }

    fun droppedFrames(): Long = synchronized(lock) { dropped }

    internal fun rejectedSequenceFrames(): Long = synchronized(lock) { rejectedSequences }
    internal fun missingSequenceFrames(): Long = synchronized(lock) { missingSequences }

    override fun close() {
        val session = synchronized(lock) {
            if (closed) return
            closed = true
            ++generation
            startingEpoch = null
            detachLocked()
        }
        session?.interrupt()
        // Queued revoked sessions must run their finally/release, not be lost
        // through shutdownNow(). Never join ourselves from an onStatus callback.
        writer.shutdown()
        if (Thread.currentThread() !== writerThread) {
            try {
                writer.awaitTermination(1, TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
    }

    private fun detachLocked(): Session? {
        val session = active
        active = null
        session?.let {
            it.cancelled = true
            it.queue.clear()
            it.queuedBytes = 0
        }
        lock.notifyAll()
        return session
    }

    private fun writeSession(session: Session) {
        var failure: Exception? = null
        try {
            writeAudio(session)
        } catch (error: Exception) {
            if (!session.cancelled) failure = error
        } finally {
            synchronized(lock) {
                if (active === session) detachLocked()
            }
            session.release()
        }
        // User callbacks never run under a state/output lock or before cleanup.
        failure?.let { report("PCM16 relay output failed: ${it.message ?: it.javaClass.simpleName}") }
    }

    private fun writeAudio(session: Session) {
        val targetBytes = session.output.bufferCapacityBytes
        check(targetBytes > 0 && targetBytes % 2 == 0) { "Invalid output buffer capacity." }
        var primedBytes = 0
        var playing = false
        var payload: ByteArray? = null
        var offset = 0
        var noProgressAt: Long? = null

        while (!session.cancelled) {
            val firstPacketAt = synchronized(lock) { session.firstPacketAt }
            val startupExpired = firstPacketAt != null && nanoTime() - firstPacketAt >= startupTimeoutNanos
            if (!playing && primedBytes > 0 && (primedBytes >= targetBytes || startupExpired)) {
                if (!beginPlayback(session, primedBytes)) return
                playing = true
            }
            if (!playing && startupExpired && primedBytes == 0 && noProgressAt != null) {
                error("Output made no progress during startup.")
            }

            if (payload == null) {
                synchronized(lock) {
                    if (session.cancelled) return
                    payload = session.queue.pollFirst()
                    if (payload != null) session.queuedBytes -= payload!!.size else {
                        // Only startup has a timed prefill wait. After play(),
                        // the next single frame is written immediately.
                        val remaining = if (!playing && firstPacketAt != null) {
                            (startupTimeoutNanos - (nanoTime() - firstPacketAt)).coerceAtLeast(1)
                        } else 0L
                        waitLocked(remaining)
                    }
                }
                if (payload == null) continue
                offset = 0
            }

            if (session.cancelled) return
            val bytes = payload!!
            val requested = if (playing) bytes.size - offset else minOf(bytes.size - offset, targetBytes - primedBytes)
            val written = session.output.write(bytes, offset, requested, blocking = playing)
            if (session.cancelled) return
            check(written in 0..requested && written % 2 == 0) { "Invalid PCM16 write result: $written" }
            if (written == 0) {
                if (!playing && primedBytes > 0) {
                    // A full nonblocking output is sufficient priming, even
                    // when a device reports a larger capacity than it accepts.
                    if (!beginPlayback(session, primedBytes)) return
                    playing = true
                } else {
                    val now = nanoTime()
                    val since = noProgressAt ?: now.also { noProgressAt = it }
                    check(now - since < ZERO_WRITE_TIMEOUT_NANOS) { "Output write stalled." }
                    synchronized(lock) {
                        if (!session.cancelled) waitLocked(ZERO_WRITE_RETRY_NANOS)
                    }
                }
                continue // Never drop or replay the unwritten tail.
            }
            noProgressAt = null
            offset += written
            if (!playing) primedBytes += written
            if (offset == bytes.size) payload = null
        }
    }

    private fun beginPlayback(session: Session, primedBytes: Int): Boolean = synchronized(session.outputLock) {
        if (session.cancelled || session.released) return false
        session.output.setVolume(synchronized(lock) { volume })
        session.output.play(primedBytes)
        synchronized(lock) { session.playbackStarted = true }
        true
    }

    /** Call only while holding lock; zero means an interruptible indefinite wait. */
    private fun waitLocked(nanos: Long) {
        if (nanos == 0L) lock.wait() else TimeUnit.NANOSECONDS.timedWait(lock, nanos)
    }

    private fun report(message: String) = runCatching { onStatus(message) }

    companion object {
        const val DEFAULT_MAX_QUEUED_FRAMES = 12
        const val PRODUCTION_MAX_QUEUED_FRAMES = 75
        const val PRODUCTION_MAX_QUEUED_BYTES = 48_000 * 2 * 1_500 / 1_000
        // Skip ahead once 400 ms is queued behind the full AudioTrack, keeping 50 ms.
        const val PRODUCTION_CATCH_UP_QUEUED_BYTES = 48_000 * 2 * 400 / 1_000
        const val PRODUCTION_CATCH_UP_LANDING_BYTES = 48_000 * 2 * 50 / 1_000
        val FORMAT = Pcm16AudioFormat(48_000, 1)
        private const val UINT32_MAX = Pcm16RelayPacketCodec.UINT32_MAX
        private const val MAX_QUEUED_BYTES = 48_000 * 2 * 120 / 1_000
        private val ZERO_WRITE_RETRY_NANOS = TimeUnit.MILLISECONDS.toNanos(2)
        private val ZERO_WRITE_TIMEOUT_NANOS = TimeUnit.MILLISECONDS.toNanos(120)
    }
}
