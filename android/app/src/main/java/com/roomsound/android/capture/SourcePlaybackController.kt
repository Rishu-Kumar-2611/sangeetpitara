package com.roomsound.android.capture

import android.content.ComponentName
import android.content.Context
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.provider.Settings

enum class ExternalPlaybackPauseResult(val userMessage: String) {
    PAUSED("The previous media app was paused."),
    NOTIFICATION_ACCESS_REQUIRED("Enable Android Notification Access to pause the previous media app automatically on source handoff."),
    NO_ACTIVE_SESSION("No controllable media session was found; the previous app may still be playing."),
    UNAVAILABLE("Android media controls are unavailable; the previous app may still be playing."),
}

/** Best-effort control of external playback when this device loses source control. */
class SourcePlaybackController(context: Context) {
    private val appContext = context.applicationContext

    fun pauseExternalPlayback(): ExternalPlaybackPauseResult {
        if (!isNotificationAccessEnabled(appContext)) return ExternalPlaybackPauseResult.NOTIFICATION_ACCESS_REQUIRED
        val manager = appContext.getSystemService(MediaSessionManager::class.java)
            ?: return ExternalPlaybackPauseResult.UNAVAILABLE
        val component = ComponentName(appContext, SourcePlaybackNotificationListenerService::class.java)
        val sessions = try {
            manager.getActiveSessions(component)
        } catch (_: SecurityException) {
            return ExternalPlaybackPauseResult.NOTIFICATION_ACCESS_REQUIRED
        } catch (_: Throwable) {
            return ExternalPlaybackPauseResult.UNAVAILABLE
        }

        var pauseSent = false
        sessions
            .filter { it.packageName != appContext.packageName }
            .filter { controller ->
                val state = controller.playbackState
                val actions = state?.actions ?: 0L
                state?.state == PlaybackState.STATE_PLAYING &&
                    (actions and (PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)) != 0L
            }
            .forEach { controller ->
                try {
                    controller.transportControls.pause()
                    pauseSent = true
                } catch (_: Throwable) {
                    // Another app may remove its session between inspection and pause.
                }
            }
        return if (pauseSent) ExternalPlaybackPauseResult.PAUSED else ExternalPlaybackPauseResult.NO_ACTIVE_SESSION
    }

    companion object {
        fun isNotificationAccessEnabled(context: Context): Boolean {
            val component = ComponentName(context, SourcePlaybackNotificationListenerService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners",
            ) ?: return false
            return enabled.split(':').any { value ->
                ComponentName.unflattenFromString(value) == component
            }
        }
    }
}
