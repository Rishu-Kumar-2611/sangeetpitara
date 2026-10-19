package com.roomsound.android.transport

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import com.roomsound.android.room.Pcm16RelayPacket
import java.io.Closeable
import java.util.concurrent.ArrayBlockingQueue
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
 * Bounded PCM16 playout for relay listeners.
 *
 * Only the single writer thread calls AudioTrack.write. The queue drops the
 * oldest frame when full to keep latency bounded, and every stop/close clears
 * the queue before releasing the STREAM_MUSIC AudioTrack. No AudioRecord or
 * microphone API is used here.
 */
class Pcm16RelayPlayer(
    private val maxQueuedFrames: Int = DEFAULT_MAX_QUEUED_FRAMES,
    private val onStatus: (String) -> Unit = {},
) : Pcm16RelayPlayerSink {
    private data class QueuedFrame(val sourceEpoch: Long, val payload: ByteArray)

    private val lock = Any()
    private val writeLock = Any()
    private val queue = ArrayBlockingQueue<QueuedFrame>(maxQueuedFrames.also {
        require(it > 0) { "maxQueuedFrames must be positive." }
    })
    private val writer = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "RoomSound-PCM16-Relay-Player").apply { isDaemon = true }
    }

    @Volatile private var closed = false
    private var audioTrack: AudioTrack? = null
    private var activeEpoch: Long? = null
    private var volume = 1.0
    private var droppedFrames = 0L

    init {
        writer.execute(::writeLoop)
    }

    override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean {
        if (format != FORMAT || sourceEpoch !in 0..0xFFFF_FFFFL) return false
        synchronized(lock) {
            if (closed) return false
            if (activeEpoch == sourceEpoch && audioTrack != null) return true
        }

        val previous = synchronized(lock) {
            if (closed) return false
            detachTrackLocked()
        }
        releaseTrack(previous)

        val track = runCatching { createAudioTrack(format) }.getOrElse { error ->
            report("PCM16 relay output could not initialize: ${error.message ?: error.javaClass.simpleName}")
            return false
        }
        synchronized(lock) {
            if (closed) {
                // The track was created outside the state lock. Release it
                // below, after dropping the lock, so writer shutdown cannot
                // deadlock with an in-flight AudioTrack.write.
                audioTrack = null
                activeEpoch = null
            } else {
                audioTrack = track
                activeEpoch = sourceEpoch
                queue.clear()
            }
        }
        if (closed) {
            releaseTrack(track)
            return false
        }

        val startError = runCatching {
            synchronized(lock) {
                if (closed || audioTrack !== track || activeEpoch != sourceEpoch) {
                    throw IllegalStateException("PCM16 relay output was revoked before start.")
                }
                track.setVolume(volume.toFloat())
                track.play()
            }
        }.exceptionOrNull()
        if (startError != null) {
            val failedTrack = synchronized(lock) {
                if (audioTrack === track) detachTrackLocked() else null
            }
            releaseTrack(failedTrack ?: track)
            report("PCM16 relay output could not start: ${startError.message ?: startError.javaClass.simpleName}")
            return false
        }
        return true
    }

    override fun stop(sourceEpoch: Long?) {
        val track = synchronized(lock) {
            if (sourceEpoch != null && sourceEpoch != activeEpoch) return
            detachTrackLocked()
        }
        releaseTrack(track)
    }

    override fun play(packet: Pcm16RelayPacket): Boolean {
        synchronized(lock) {
            if (closed || activeEpoch != packet.sourceEpoch || audioTrack == null) return false
            val item = QueuedFrame(packet.sourceEpoch, packet.payload.copyOf())
            if (!queue.offer(item)) {
                queue.poll()
                droppedFrames += 1
                if (!queue.offer(item)) return false
            }
            return true
        }
    }

    override fun currentEpoch(): Long? = synchronized(lock) { activeEpoch }

    override fun setVolume(volume: Double) {
        if (!volume.isFinite()) return
        synchronized(lock) {
            if (closed) return
            this.volume = volume.coerceIn(0.0, 1.0)
            runCatching { audioTrack?.setVolume(this.volume.toFloat()) }
        }
    }

    fun droppedFrames(): Long = synchronized(lock) { droppedFrames }

    override fun close() {
        val track = synchronized(lock) {
            if (closed) return
            closed = true
            detachTrackLocked()
        }
        releaseTrack(track)
        writer.shutdownNow()
        runCatching { writer.awaitTermination(1, TimeUnit.SECONDS) }
    }

    private fun writeLoop() {
        while (!closed) {
            val item = try {
                queue.take()
            } catch (_: InterruptedException) {
                if (closed) return
                continue
            }
            val trackAndEpoch = synchronized(lock) {
                if (!closed && activeEpoch == item.sourceEpoch) audioTrack else null
            }
            val track = trackAndEpoch
            if (track != null) {
                synchronized(writeLock) {
                    if (isCurrentTrack(item.sourceEpoch, track)) {
                        var offset = 0
                        var failed = false
                        while (offset < item.payload.size && isCurrentTrack(item.sourceEpoch, track)) {
                            val result = runCatching {
                                track.write(
                                    item.payload,
                                    offset,
                                    item.payload.size - offset,
                                    AudioTrack.WRITE_BLOCKING,
                                )
                            }.getOrElse { error ->
                                report("PCM16 relay output failed: ${error.message ?: error.javaClass.simpleName}")
                                -1
                            }
                            if (result <= 0) {
                                failed = true
                                break
                            }
                            offset += result
                        }
                        if (failed || offset < item.payload.size) {
                            val failedTrack = synchronized(lock) {
                                droppedFrames += 1
                                if (audioTrack === track && activeEpoch == item.sourceEpoch) {
                                    detachTrackLocked()
                                } else null
                            }
                            releaseTrackLocked(failedTrack)
                        }
                    }
                }
            }
        }
    }

    private fun detachTrackLocked(): AudioTrack? {
        queue.clear()
        activeEpoch = null
        val track = audioTrack
        audioTrack = null
        return track
    }

    private fun releaseTrack(track: AudioTrack?) {
        if (track != null) {
            synchronized(writeLock) {
                releaseTrackLocked(track)
            }
        }
    }

    private fun releaseTrackLocked(track: AudioTrack?) {
        if (track == null) return
        runCatching { track.pause() }
        runCatching { track.flush() }
        runCatching { track.stop() }
        runCatching { track.release() }
    }

    private fun isCurrentTrack(sourceEpoch: Long, track: AudioTrack): Boolean = synchronized(lock) {
        !closed && activeEpoch == sourceEpoch && audioTrack === track
    }

    private fun createAudioTrack(format: Pcm16AudioFormat): AudioTrack {
        val minBufferBytes = AudioTrack.getMinBufferSize(
            format.sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBufferBytes > 0) { "Android returned an invalid AudioTrack buffer size: $minBufferBytes" }
        // Keep the hardware queue near 50 ms. The old 200 ms floor made a
        // burst or temporary stall audible as stale room audio.
        val bufferBytes = maxOf(minBufferBytes, format.sampleRate / 20 * 2)
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setLegacyStreamType(AudioManager.STREAM_MUSIC)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(format.sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(bufferBytes)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    private fun report(message: String) = runCatching { onStatus(message) }

    companion object {
        const val DEFAULT_MAX_QUEUED_FRAMES = 12
        val FORMAT = Pcm16AudioFormat(48_000, 1)
    }
}
