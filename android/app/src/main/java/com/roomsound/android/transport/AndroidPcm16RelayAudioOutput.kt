package com.roomsound.android.transport

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Process

/** Output only: media/music routing, mono PCM16, no capture or enhancement. */
internal class AndroidPcm16RelayAudioOutput(format: Pcm16AudioFormat) : Pcm16RelayAudioOutput {
    private val track: AudioTrack
    // Only the writer touches this; legacy short-start capacity is restored
    // once playback has actually consumed data, never after a timed sleep.
    private var restoreBufferFrames: Int? = null

    init {
        val minimum = AudioTrack.getMinBufferSize(
            format.sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimum > 0) { "Android returned an invalid AudioTrack buffer size: $minimum" }
        // ~200 ms absorbs WAN/TCP transport and CPU jitter without underrunning.
        // A device may require a larger minimum; query its actual writable size.
        val targetFrames = (format.sampleRate * 2) / 5
        val created = AudioTrack.Builder()
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
            .setBufferSizeInBytes(maxOf(minimum, targetFrames * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        try {
            check(created.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack is uninitialized." }
            check(created.setBufferSizeInFrames(targetFrames) > 0) { "AudioTrack buffer configuration failed." }
            track = created
        } catch (error: Exception) {
            created.release()
            throw error
        }
    }

    override val bufferCapacityBytes: Int
        get() = minOf(track.bufferSizeInFrames, track.bufferCapacityInFrames) * 2

    override fun write(bytes: ByteArray, offset: Int, count: Int, blocking: Boolean): Int {
        // Even with a reduced legacy startup buffer, a racing write after
        // interrupt's pause/flush must fit in the empty buffer and return.
        val boundedCount = minOf(count, bufferCapacityBytes)
        val written = track.write(
            bytes, offset, boundedCount,
            if (blocking) AudioTrack.WRITE_BLOCKING else AudioTrack.WRITE_NON_BLOCKING,
        )
        val restore = restoreBufferFrames
        if (blocking && written > 0 && restore != null && track.playbackHeadPosition != 0) {
            track.setBufferSizeInFrames(restore)
            restoreBufferFrames = null
        }
        return written
    }

    override fun play(primedBytes: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // A short/isolated source packet must not wait indefinitely for the
            // default device threshold after the bounded startup timeout.
            track.setStartThresholdInFrames(minOf(primedBytes / 2, track.bufferCapacityInFrames).coerceAtLeast(1))
        } else if (primedBytes / 2 < track.bufferSizeInFrames) {
            // API 29/30 have no explicit start-threshold setter. Reducing the
            // writable size also reduces the implicit start threshold, subject
            // to the device's minimum. Restore the jitter buffer after startup.
            val original = track.bufferSizeInFrames
            if (track.setBufferSizeInFrames((primedBytes / 2).coerceAtLeast(1)) > 0) {
                restoreBufferFrames = original
            }
        }
        track.play()
    }

    override fun setVolume(volume: Float) {
        track.setVolume(volume)
    }

    override fun interrupt() {
        // pause interrupts WRITE_BLOCKING. flush makes room if the writer was
        // preempted just before entering write, then raced with this pause.
        // Neither operation waits for the application writer lock.
        try {
            track.pause()
        } finally {
            track.flush()
        }
    }

    override fun close() {
        try {
            runCatching { track.pause() }
            runCatching { track.flush() }
        } finally {
            track.release()
        }
    }

    companion object {
        fun setAudioThreadPriority() = Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    }
}
