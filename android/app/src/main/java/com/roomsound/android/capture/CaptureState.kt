package com.roomsound.android.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build

enum class CaptureStatus {
    IDLE,
    UNSUPPORTED_API,
    PERMISSION_REQUIRED,
    PROJECTION_REQUIRED,
    STARTING,
    READY,
    CAPTURING,
    NO_ACTIVE_PLAYBACK,
    STOPPED,
    ERROR,
}

data class CaptureSnapshot(
    val status: CaptureStatus,
    /** Mono sample frames read, including silence (480 frames = 10 ms at 48 kHz). */
    val framesCaptured: Long = 0,
    /** Individual sample frames whose absolute PCM16 value exceeds 2. */
    val nonSilentFrames: Long = 0,
    val message: String? = null,
    /** True after AudioRecord initialized, started, and returned a positive read. */
    val ready: Boolean = false,
    /** Identifies one consent/capture operation, including its terminal callbacks. */
    val sessionId: String? = null,
)

data class CaptureCapabilityReport(
    val apiSupported: Boolean,
    val mediaProjectionAvailable: Boolean,
    val recordAudioGranted: Boolean,
    val summary: String,
)

object PlaybackCaptureCapabilities {
    fun inspect(context: Context): CaptureCapabilityReport {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return CaptureCapabilityReport(
                apiSupported = false,
                mediaProjectionAvailable = false,
                recordAudioGranted = false,
                summary = "Android 10 or newer is required for playback capture.",
            )
        }

        val projectionAvailable = context.getSystemService(MediaProjectionManager::class.java) != null
        val recordAudioGranted = context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val summary = when {
            !projectionAvailable -> "MediaProjection is unavailable on this device."
            !recordAudioGranted -> "Android requires audio permission for playback capture; RoomSound does not use your microphone."
            else -> "Ready to request Android's system capture consent."
        }
        return CaptureCapabilityReport(
            apiSupported = true,
            mediaProjectionAvailable = projectionAvailable,
            recordAudioGranted = recordAudioGranted,
            summary = summary,
        )
    }
}

fun interface Pcm16Sink {
    /**
     * Receives one copied 10 ms PCM16 frame. Capture never writes audio to disk.
     * RoomAudioTransport enforces the room's server-issued source lease.
     */
    fun onFrame(samples: ShortArray, sampleCount: Int, sampleRate: Int, channels: Int)
}
