package com.roomsound.android.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.roomsound.android.MainActivity
import com.roomsound.android.R
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Started + bound service. The room coordinator and capture controller live
 * here rather than in the Activity, so rotation cannot stop publication.
 */
class PlaybackCaptureService : Service() {
    companion object {
        const val ACTION_START = "com.roomsound.android.capture.START"
        const val ACTION_STOP = "com.roomsound.android.capture.STOP"
        const val EXTRA_RESULT_CODE = "com.roomsound.android.capture.RESULT_CODE"
        const val EXTRA_RESULT_DATA = "com.roomsound.android.capture.RESULT_DATA"
        const val EXTRA_SESSION_ID = "com.roomsound.android.capture.SESSION_ID"

        private const val CHANNEL_ID = "roomsound_capture"
        private const val NOTIFICATION_ID = 4101
    }

    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<(CaptureSnapshot) -> Unit>()
    private lateinit var controller: PlaybackCaptureController
    private lateinit var roomSession: RoomSessionCoordinator
    private var latestSnapshot = CaptureSnapshot(CaptureStatus.IDLE)
    private var foregroundStarted = false
    private var foregroundSessionId: String? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        roomSession = RoomSessionCoordinator(this) { id, message ->
            controller.stop(id, message, publishStopped = false)
            if (latestSnapshot.sessionId == id || foregroundSessionId == id ||
                latestSnapshot.status !in setOf(CaptureStatus.STARTING, CaptureStatus.READY, CaptureStatus.CAPTURING, CaptureStatus.NO_ACTIVE_PLAYBACK)
            ) {
                publish(CaptureSnapshot(CaptureStatus.STOPPED, message = message, sessionId = id))
            }
            finishCapture(id)
        }
        controller = PlaybackCaptureController(this) { snapshot ->
            val deliver = {
                try { if (roomSession.onCaptureSnapshot(snapshot)) {
                    publish(snapshot)
                    if (snapshot.status == CaptureStatus.ERROR || snapshot.status == CaptureStatus.STOPPED) {
                        snapshot.sessionId?.let(::finishCapture)
                    }
                } } catch (t: Throwable) { android.util.Log.e("RoomSound", "onSnapshot deliver failed", t) }
            }
            if (Looper.myLooper() == Looper.getMainLooper()) deliver() else main.post { deliver() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
        when (intent?.action) {
            ACTION_STOP -> {
                val requestedId = intent.getStringExtra(EXTRA_SESSION_ID)
                val pendingId = roomSession.pendingCapture()?.id
                try {
                    if (requestedId == null || requestedId == pendingId) {
                        roomSession.stopCapture("Capture stopped from the RoomSound notification.")
                    }
                } catch (t: Throwable) { android.util.Log.e("RoomSound", "stopCapture on ACTION_STOP failed", t) }
                stopCaptureNotification()
                try { stopSelf() } catch (_: Throwable) {}
            }

            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE)
                val projectionData = intent.parcelableExtra<Intent>(EXTRA_RESULT_DATA)
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                if (resultCode == Int.MIN_VALUE || projectionData == null || sessionId.isNullOrBlank()) {
                    if (!foregroundStarted) {
                        startForegroundCaptureNotification(null)
                        publish(CaptureSnapshot(CaptureStatus.ERROR, message = "Android capture consent data was missing."))
                        stopCaptureNotification()
                    }
                    return START_NOT_STICKY
                }
                if (!roomSession.consumeConsent(sessionId)) {
                    // Fulfill a foreground-start obligation without disrupting
                    // a different active capture. Never reuse stale consent.
                    if (!foregroundStarted) {
                        startForegroundCaptureNotification(null)
                        stopCaptureNotification()
                    }
                    return START_NOT_STICKY
                }
                try {
                    if (!startForegroundCaptureNotification(sessionId)) {
                        roomSession.cancelCapture(sessionId, "Foreground playback capture could not start. Check Android's foreground-service permission and try again.")
                        return START_NOT_STICKY
                    }
                    controller.start(sessionId, resultCode, projectionData, roomSession.pcmSink(sessionId))
                } catch (error: Throwable) {
                    roomSession.cancelCapture(sessionId, "Foreground playback capture could not start: ${error.message}")
                    finishCapture(sessionId)
                }
            }
        }
        } catch (t: Throwable) { android.util.Log.e("RoomSound", "onStartCommand failed", t) }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        roomSession.close()
        controller.close()
        listeners.clear()
        main.removeCallbacksAndMessages(null)
        stopCaptureNotification()
        super.onDestroy()
    }

    inner class LocalBinder : Binder() {
        fun service(): PlaybackCaptureService = this@PlaybackCaptureService
    }

    fun roomSession(): RoomSessionCoordinator = roomSession

    fun snapshot(): CaptureSnapshot = latestSnapshot

    fun addListener(listener: (CaptureSnapshot) -> Unit) {
        listeners += listener
        listener(latestSnapshot)
    }

    fun removeListener(listener: (CaptureSnapshot) -> Unit) {
        listeners -= listener
    }

    private fun publish(snapshot: CaptureSnapshot) {
        latestSnapshot = snapshot
        listeners.forEach { it(snapshot) }
    }

    private fun startForegroundCaptureNotification(sessionId: String?): Boolean {
        val stopIntent = Intent(this, PlaybackCaptureService::class.java).setAction(ACTION_STOP).apply {
            putExtra(EXTRA_SESSION_ID, sessionId)
            data = android.net.Uri.parse("roomsound://capture/${sessionId ?: "pending"}")
        }
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_IMMUTABLE,
        )
        val contentIntent = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.capture_notification_title))
            .setContentText(getString(R.string.capture_notification_text))
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setColor(Color.rgb(119, 147, 255))
            .addAction(Notification.Action.Builder(null, getString(R.string.stop_capture), stopPendingIntent).build())
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val fgType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                startForeground(NOTIFICATION_ID, notification, fgType)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (security: SecurityException) {
            android.util.Log.e("RoomSound", "startForeground SecurityException", security)
            publish(CaptureSnapshot(CaptureStatus.ERROR, message = "Foreground permission denied: ${security.message}", sessionId = sessionId))
            return false
        } catch (error: Throwable) {
            android.util.Log.e("RoomSound", "startForeground failed", error)
            publish(CaptureSnapshot(CaptureStatus.ERROR, message = "Could not start foreground capture: ${error.message}", sessionId = sessionId))
            return false
        }
        foregroundStarted = true
        foregroundSessionId = sessionId
        return true
    }

    private fun stopCaptureNotification() {
        if (!foregroundStarted) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        foregroundSessionId = null
    }

    private fun finishCapture(sessionId: String) {
        if (foregroundSessionId == sessionId) {
            stopCaptureNotification()
            // Keep the started service alive after a capture failure or a
            // projection callback. It owns the room WebSocket; stopping it
            // here would disconnect an otherwise healthy room unnecessarily.
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "RoomSound audio capture",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows while RoomSound captures supported device playback."
            setSound(null, null)
            enableVibration(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
}

private inline fun <reified T : android.os.Parcelable> Intent.parcelableExtra(key: String): T? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(key, T::class.java)
    } else {
        @Suppress("DEPRECATION")
        getParcelableExtra(key)
    }
}
