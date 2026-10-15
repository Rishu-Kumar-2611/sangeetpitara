package com.roomsound.android.capture

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.max

/** Every run owns its resources; a previous reader can never release a later run. */
class PlaybackCaptureController(
    private val context: Context,
    private val onSnapshot: (CaptureSnapshot) -> Unit,
) {
    companion object {
        const val SAMPLE_RATE = 48_000
        const val CHANNELS = 1
        const val FRAME_SAMPLES = 480
        private const val SILENCE_TIMEOUT_MS = 2_000L
        private const val UI_UPDATE_MS = 250L
        private const val EMPTY_READ_TIMEOUT_MS = 5_000L
    }

    private class CaptureRun(
        val id: String,
        val projection: MediaProjection,
        val sink: Pcm16Sink?,
    ) {
        val stopped = AtomicBoolean(false)
        val released = AtomicBoolean(false)
        val resourcesLock = Any()
        var record: AudioRecord? = null
        var thread: Thread? = null
        lateinit var callback: MediaProjection.Callback
        @Volatile var sampleFrames = 0L
        @Volatile var signalFrames = 0L
        @Volatile var ready = false
    }

    private val lock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var active: CaptureRun? = null
    private var closed = false
    @Volatile private var configuredSink: Pcm16Sink? = null

    /** Replaces the sink for the next run; an active run keeps its own sink. */
    fun setPcm16Sink(sink: Pcm16Sink?) {
        configuredSink = sink
    }

    /** The service calls this only once per fresh system-consent operation. */
    fun start(sessionId: String, resultCode: Int, projectionData: Intent, sink: Pcm16Sink?) {
        stop(publishStopped = false)
        synchronized(lock) { if (closed) return }
        val manager = context.getSystemService(MediaProjectionManager::class.java)
        val projection = try {
            checkNotNull(manager) { "MediaProjection is unavailable on this device." }
                .getMediaProjection(resultCode, projectionData)
                ?: throw IllegalStateException("New system capture consent is required.")
        } catch (error: Exception) {
            onSnapshot(CaptureSnapshot(
                CaptureStatus.ERROR,
                message = "Android could not start playback capture: ${error.message}",
                sessionId = sessionId,
            ))
            return
        }

        val run = CaptureRun(sessionId, projection, sink ?: configuredSink)
        run.callback = object : MediaProjection.Callback() {
            override fun onStop() {
                finish(run, CaptureStatus.STOPPED, "Android stopped system capture or revoked consent.", stopProjection = false)
            }
        }
        synchronized(lock) {
            if (closed) {
                release(run)
                return
            }
            active = run
        }
        try {
            projection.registerCallback(run.callback, mainHandler)
            publish(run, CaptureStatus.STARTING, "Initializing device playback capture…")
            val reader = Thread({ captureLoop(run) }, "RoomSound-PlaybackCapture-${sessionId.take(8)}").apply {
                isDaemon = true
            }
            synchronized(run.resourcesLock) {
                if (run.stopped.get()) return
                run.thread = reader
                reader.start()
            }
        } catch (error: Exception) {
            finish(run, CaptureStatus.ERROR, "Playback capture could not initialize: ${error.message}")
        }
    }

    /** A stale caller specifying another session cannot stop current capture. */
    fun stop(sessionId: String? = null, message: String = "Device audio sharing stopped.", publishStopped: Boolean = true) {
        val run = synchronized(lock) {
            val current = active ?: return
            if (sessionId != null && current.id != sessionId) return
            active = null
            current.stopped.set(true)
            current
        }
        release(run)
        if (publishStopped) onSnapshot(snapshot(run, CaptureStatus.STOPPED, message, ready = false))
    }

    fun close() {
        synchronized(lock) { closed = true }
        stop(publishStopped = false)
    }

    private fun captureLoop(run: CaptureRun) {
        var record: AudioRecord? = null
        try {
            val created = createAudioRecord(run.projection)
            synchronized(run.resourcesLock) {
                if (run.stopped.get()) {
                    created.release()
                    return
                }
                run.record = created
                record = created
                created.startRecording()
                check(created.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    "AudioRecord did not enter recording state."
                }
            }
            val reader = checkNotNull(record)
            val frame = ShortArray(FRAME_SAMPLES)
            var filled = 0
            var lastSignalAt = SystemClock.elapsedRealtime()
            var lastReadAt = lastSignalAt
            var lastUiAt = 0L
            var lastStatus: CaptureStatus? = null

            while (!run.stopped.get() && !Thread.currentThread().isInterrupted) {
                // Read exactly 480 mono sample frames, even on devices returning partial reads.
                // stop() stops/releases this run's recorder to unblock READ_BLOCKING.
                val count = reader.read(frame, filled, FRAME_SAMPLES - filled, AudioRecord.READ_BLOCKING)
                if (run.stopped.get()) break
                if (count < 0) throw IllegalStateException("AudioRecord read failed ($count).")
                val now = SystemClock.elapsedRealtime()
                if (count == 0) {
                    check(now - lastReadAt < EMPTY_READ_TIMEOUT_MS) { "AudioRecord returned no samples." }
                    Thread.sleep(5)
                    continue
                }
                lastReadAt = now
                run.sampleFrames += count
                var signalCount = 0
                for (index in filled until filled + count) {
                    if (abs(frame[index].toInt()) > 2) signalCount++
                }
                run.signalFrames += signalCount
                if (signalCount > 0) lastSignalAt = now
                if (!run.ready) {
                    run.ready = true
                    // Silence is a valid successful read and must not prevent source activation.
                    publish(run, CaptureStatus.READY, "Playback capture initialized and reading. Silence is valid.")
                }
                filled += count
                if (filled == FRAME_SAMPLES) {
                    if (!run.stopped.get()) run.sink?.onFrame(frame.copyOf(), FRAME_SAMPLES, SAMPLE_RATE, CHANNELS)
                    filled = 0
                }
                val status = if (now - lastSignalAt >= SILENCE_TIMEOUT_MS) {
                    CaptureStatus.NO_ACTIVE_PLAYBACK
                } else {
                    CaptureStatus.CAPTURING
                }
                if (status != lastStatus || now - lastUiAt >= UI_UPDATE_MS) {
                    publish(run, status, if (status == CaptureStatus.NO_ACTIVE_PLAYBACK) {
                        "Reading silence. Playback may be paused, quiet, in another profile, or ineligible for capture; this does not identify which app allows capture."
                    } else {
                        "Device playback capture is running. You can open a supported music app."
                    })
                    lastStatus = status
                    lastUiAt = now
                }
            }
        } catch (error: Exception) {
            if (!run.stopped.get()) finish(run, CaptureStatus.ERROR, "Device playback capture failed: ${error.message}")
        } finally {
            // This is idempotent and references only this run, never a shared recorder.
            release(run)
        }
    }

    private fun createAudioRecord(mediaProjection: MediaProjection): AudioRecord {
        val captureConfig = AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            // Do not recapture RoomSound's own remote playback into the source.
            .excludeUid(android.os.Process.myUid())
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        check(minBuffer > 0) { "Android returned an invalid AudioRecord buffer size: $minBuffer" }
        return AudioRecord.Builder()
            .setAudioFormat(format)
            .setBufferSizeInBytes(max(minBuffer, FRAME_SAMPLES * 2 * 4))
            .setAudioPlaybackCaptureConfig(captureConfig)
            .build()
    }

    private fun finish(
        run: CaptureRun,
        status: CaptureStatus,
        message: String,
        stopProjection: Boolean = true,
    ) {
        val shouldPublish = synchronized(lock) {
            if (active !== run) return@synchronized false
            active = null
            run.stopped.set(true)
            true
        }
        release(run, stopProjection)
        if (shouldPublish) onSnapshot(snapshot(run, status, message, ready = run.ready))
    }

    /** Idempotent per run. It may be called by stop(), the reader, and projection onStop. */
    private fun release(run: CaptureRun, stopProjection: Boolean = true) {
        if (!run.released.compareAndSet(false, true)) return
        run.stopped.set(true)
        val record = synchronized(run.resourcesLock) {
            val value = run.record
            run.record = null
            value
        }
        if (record != null) {
            runCatching { record.stop() }
            runCatching { record.release() }
        }
        run.thread?.let { thread ->
            if (thread !== Thread.currentThread()) thread.interrupt()
        }
        runCatching { run.projection.unregisterCallback(run.callback) }
        if (stopProjection) runCatching { run.projection.stop() }
    }

    private fun snapshot(
        run: CaptureRun,
        status: CaptureStatus,
        message: String?,
        ready: Boolean = run.ready,
    ) = CaptureSnapshot(
        status = status,
        framesCaptured = run.sampleFrames,
        nonSilentFrames = run.signalFrames,
        message = message,
        ready = ready,
        sessionId = run.id,
    )

    private fun publish(run: CaptureRun, status: CaptureStatus, message: String?) {
        if (run.stopped.get()) return
        onSnapshot(snapshot(run, status, message))
    }
}
