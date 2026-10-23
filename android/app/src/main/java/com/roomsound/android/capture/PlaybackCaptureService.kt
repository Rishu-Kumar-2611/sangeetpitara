package com.roomsound.android.capture

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import com.roomsound.android.MainActivity
import com.roomsound.android.R
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomState
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Started + bound service. The room coordinator and capture controller live
 * here rather than in the Activity, so rotation cannot stop publication.
 */
class PlaybackCaptureService : Service() {
    companion object {
        const val ACTION_START = "com.roomsound.android.capture.START"
        const val ACTION_STOP = "com.roomsound.android.capture.STOP"
        const val ACTION_LEAVE = "com.roomsound.android.capture.LEAVE"
        private const val EXTRA_ACTION_TOKEN = "com.roomsound.android.capture.ACTION_TOKEN"
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
    private lateinit var sourcePlaybackController: SourcePlaybackController
    private lateinit var controlRequestNotifications: RoomControlRequestNotifications
    private var latestSnapshot = CaptureSnapshot(CaptureStatus.IDLE)
    private enum class ForegroundMode { ROOM_PLAYBACK, CAPTURE }
    private var foregroundMode: ForegroundMode? = null
    private var foregroundSessionId: String? = null
    private val lifecycle = RoomPlaybackLifecycle()
    private var notificationToken: String? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var mediaSession: MediaSession? = null
    private var mediaSessionToken: String? = null
    private var focusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private var focusSuppressed = false
    private var destroyed = false
    private val protectionTimeout = Runnable {
        if (lifecycle.isExpired(SystemClock.elapsedRealtime())) {
            roomSession.leaveRoom()
        } else scheduleProtectionTimeout()
    }

    private val roomNotificationListener = object : RoomSessionCoordinator.Listener {
        override fun onConnectionStateChanged(state: RoomConnectionState) {
            if (state != RoomConnectionState.JOINED) controlRequestNotifications.dismissAll()
            if (lifecycle.phase == RoomPlaybackLifecycle.Phase.PREPARING && state in setOf(
                    RoomConnectionState.FAILED, RoomConnectionState.CLOSED, RoomConnectionState.RECONNECT_WAIT,
                )
            ) {
                roomSession.leaveRoom()
                return
            }
            if (state != RoomConnectionState.JOINED) lifecycle.disconnected(SystemClock.elapsedRealtime())
            refreshRoomProtection()
        }

        override fun onEvent(event: RoomSoundEvent) {
            when (event) {
                is RoomSoundEvent.Joined -> {
                    syncControlRequestNotifications(event.state)
                    refreshRoomProtection()
                }
                is RoomSoundEvent.State -> {
                    syncControlRequestNotifications(event.state)
                    if (!event.state.room.status.equals("ACTIVE", ignoreCase = true)) roomSession.leaveRoom()
                    else refreshRoomProtection()
                }
                is RoomSoundEvent.ControlRequested -> showControlRequestIfAllowed(event.request, prominent = true)
                is RoomSoundEvent.RequestResult -> {
                    event.request?.id?.let { requestId ->
                        if (!event.status.equals("PENDING", ignoreCase = true)) {
                            controlRequestNotifications.dismiss(requestId)
                        }
                    }
                }
                is RoomSoundEvent.ControlRequestExpired -> controlRequestNotifications.dismiss(event.requestId)
                is RoomSoundEvent.Removed, is RoomSoundEvent.RoomEnded -> {
                    controlRequestNotifications.dismissAll()
                    releaseRoomProtection()
                }
                is RoomSoundEvent.Error, is RoomSoundEvent.LocalError -> {
                    if (lifecycle.phase == RoomPlaybackLifecycle.Phase.PREPARING) {
                        lifecycle.initialJoinFailed()
                        roomSession.leaveRoom()
                    }
                }
                else -> Unit
            }
        }

        override fun onPublisherStatus(message: String) = Unit

        override fun onSessionChanged() {
            syncControlRequestNotifications(roomSession.currentRoomState())
            refreshRoomProtection()
        }

        override fun onRoomSessionStopped() = releaseRoomProtection()
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        controlRequestNotifications = RoomControlRequestNotifications(this)
        sourcePlaybackController = SourcePlaybackController(this)
        roomSession = RoomSessionCoordinator(this) { id, message, pauseExternalPlayback ->
            val pauseMessage = if (pauseExternalPlayback) {
                sourcePlaybackController.pauseExternalPlayback().userMessage
            } else {
                null
            }
            val finalMessage = listOfNotNull(message, pauseMessage).joinToString(" ")
            controller.stop(id, finalMessage, publishStopped = false)
            if (latestSnapshot.sessionId == id || foregroundSessionId == id ||
                latestSnapshot.status !in setOf(CaptureStatus.STARTING, CaptureStatus.READY, CaptureStatus.CAPTURING, CaptureStatus.NO_ACTIVE_PLAYBACK)
            ) {
                publish(CaptureSnapshot(CaptureStatus.STOPPED, message = finalMessage, sessionId = id))
            }
            finishCapture(id)
        }
        roomSession.addListener(roomNotificationListener)
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
            RoomControlRequestNotifications.ACTION_APPROVE_REQUEST -> {
                handleControlRequestAction(intent, approve = true)
            }

            RoomControlRequestNotifications.ACTION_REJECT_REQUEST -> {
                handleControlRequestAction(intent, approve = false)
            }

            ACTION_STOP -> {
                val requestedId = intent.getStringExtra(EXTRA_SESSION_ID)
                if (lifecycle.acceptsCaptureStop(intent.getStringExtra(EXTRA_ACTION_TOKEN), requestedId) &&
                    roomSession.pendingCapture()?.id == requestedId
                ) roomSession.stopCapture("Capture stopped from the SangeetPitara notification.")
            }

            ACTION_LEAVE -> {
                if (lifecycle.acceptsAction(intent.getStringExtra(EXTRA_ACTION_TOKEN))) roomSession.leaveRoom()
            }

            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Int.MIN_VALUE)
                val projectionData = intent.parcelableExtra<Intent>(EXTRA_RESULT_DATA)
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                if (resultCode != Activity.RESULT_OK || projectionData == null || sessionId.isNullOrBlank()) {
                    if (roomSession.pendingCapture()?.phase == ConsentPhase.SYSTEM_DIALOG_OPEN) {
                        sessionId?.let { roomSession.cancelCapture(it, "Android capture consent data was missing.") }
                    }
                    if (!lifecycle.protected) stopSelf(startId)
                    return START_NOT_STICKY
                }
                if (!lifecycle.protected || !roomSession.consumeConsent(sessionId)) {
                    // Never manufacture a mediaProjection foreground type for
                    // stale/missing consent. Capture is sent to an already-started service.
                    if (!lifecycle.protected) stopSelf(startId)
                    return START_NOT_STICKY
                }
                try {
                    if (!lifecycle.captureStarted(sessionId) || !syncProtection()) {
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
        if (!lifecycle.protected) stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The Activity task is disposable; an active room/capture session is
        // owned by this started foreground service. Reassert its protection so
        // task removal, screen-off, and launcher process cleanup do not turn a
        // valid room session into an unprotected background service.
        if (lifecycle.protected && !syncProtection()) roomSession.leaveRoom()
        else if (!lifecycle.protected && !destroyed) stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        destroyed = true
        roomSession.removeListener(roomNotificationListener)
        releaseRoomProtection(stopStartedService = false)
        releaseResource("room session") { roomSession.close() }
        releaseResource("capture controller") { controller.close() }
        listeners.clear()
        main.removeCallbacksAndMessages(null)
        releaseResource("control notifications") { controlRequestNotifications.close() }
        stopForegroundNotification()
        super.onDestroy()
    }

    inner class LocalBinder : Binder() {
        fun service(): PlaybackCaptureService = this@PlaybackCaptureService
    }

    fun roomSession(): RoomSessionCoordinator = roomSession

    /** Called synchronously by a validated Create/Join tap while the Activity is visible. */
    fun prepareRoomPlayback(): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (destroyed || !roomSession.canSelectRoom() || lifecycle.protected) return false
        lifecycle.prepare(UUID.randomUUID().toString(), SystemClock.elapsedRealtime())
        focusSuppressed = false
        return try {
            // Keep the bound instance started after Activity unbind/close. There
            // is no deferred foreground-start command racing an async join.
            startService(Intent(this, PlaybackCaptureService::class.java))
            if (syncProtection()) true else {
                releaseRoomProtection()
                false
            }
        } catch (error: Exception) {
            android.util.Log.e("RoomSound", "Could not prepare foreground room playback", error)
            releaseRoomProtection()
            false
        }
    }

    fun cancelRoomPreparation() {
        if (lifecycle.phase == RoomPlaybackLifecycle.Phase.PREPARING) roomSession.leaveRoom()
    }

    fun snapshot(): CaptureSnapshot = latestSnapshot

    fun addListener(listener: (CaptureSnapshot) -> Unit) {
        listeners += listener
        listener(latestSnapshot)
    }

    fun removeListener(listener: (CaptureSnapshot) -> Unit) {
        listeners -= listener
    }

    private fun handleControlRequestAction(intent: Intent, approve: Boolean) {
        val requestId = intent.getStringExtra(RoomControlRequestNotifications.EXTRA_REQUEST_ID)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: return
        controlRequestNotifications.dismiss(requestId)
        val accepted = if (approve) {
            roomSession.approveRequest(requestId)
        } else {
            roomSession.rejectRequest(requestId)
        }
        if (!accepted) syncControlRequestNotifications(roomSession.currentRoomState())
    }

    private fun showControlRequestIfAllowed(
        request: com.roomsound.android.room.RoomRequest,
        prominent: Boolean = false,
    ) {
        val state = roomSession.currentRoomState() ?: return
        if (isModerator(state) && state.room.status.equals("ACTIVE", ignoreCase = true)) {
            controlRequestNotifications.show(request, prominent = prominent)
        }
    }

    private fun syncControlRequestNotifications(state: RoomState?) {
        if (state == null || !state.room.status.equals("ACTIVE", ignoreCase = true) || !isModerator(state)) {
            controlRequestNotifications.dismissAll()
            return
        }
        val pending = state.requests.filter { it.status.equals("PENDING", ignoreCase = true) }
        pending.forEach { request -> controlRequestNotifications.show(request, prominent = false) }
        controlRequestNotifications.dismissExcept(pending.mapTo(mutableSetOf()) { it.id })
    }

    private fun isModerator(state: RoomState): Boolean {
        val selfId = state.self?.id ?: return false
        return selfId == state.room.hostId || selfId == state.room.cohostId
    }

    private fun publish(snapshot: CaptureSnapshot) {
        latestSnapshot = snapshot
        listeners.forEach { it(snapshot) }
    }

    private fun refreshRoomProtection() {
        if (destroyed || !lifecycle.protected) return
        val state = roomSession.currentRoomState()
        if (state != null) {
            lifecycle.joined(state.room.activeSourceId != null && state.room.sourceStatus in setOf("STARTING", "LIVE"))
        } else lifecycle.disconnected(SystemClock.elapsedRealtime())
        if (!syncProtection()) roomSession.leaveRoom()
    }

    /** A capture -> listener transition updates the existing FGS without stopForeground. */
    private fun syncProtection(): Boolean {
        if (destroyed || !lifecycle.protected) return false
        val capture = lifecycle.mode == RoomPlaybackLifecycle.Mode.CAPTURE
        val desiredMode = if (capture) ForegroundMode.CAPTURE else ForegroundMode.ROOM_PLAYBACK
        val token = lifecycle.actionToken ?: return false
        try {
            updateMediaSession(token, capture)
            if (foregroundMode != desiredMode || notificationToken != token) {
                val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
                    (if (capture) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0)
                startForeground(NOTIFICATION_ID, playbackNotification(capture, token), type)
                foregroundMode = desiredMode
                foregroundSessionId = lifecycle.captureId
                notificationToken = token
            }
            setNetworkLocks(lifecycle.needsLocks)
            scheduleProtectionTimeout()
            updateAudioFocus()
            return true
        } catch (error: Exception) {
            android.util.Log.e("RoomSound", "Could not protect room playback", error)
            return false
        }
    }

    private fun playbackNotification(capture: Boolean, token: String): Notification {
        fun action(action: String, label: Int): Notification.Action {
            val intent = Intent(this, PlaybackCaptureService::class.java).setAction(action).apply {
                putExtra(EXTRA_ACTION_TOKEN, token)
                putExtra(EXTRA_SESSION_ID, lifecycle.captureId)
                data = android.net.Uri.parse("roomsound://playback/$token/$action")
            }
            val pending = PendingIntent.getService(this, 1, intent, PendingIntent.FLAG_IMMUTABLE)
            val icon = Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel)
            return Notification.Action.Builder(icon, getString(label), pending).build()
        }
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(if (capture) R.string.capture_notification_title else R.string.room_playback_notification_title))
            .setContentText(getString(if (capture) R.string.capture_notification_text else R.string.room_playback_notification_text))
            .setSmallIcon(R.drawable.ic_stat_diya)
            .setContentIntent(PendingIntent.getActivity(
                this, 2, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setColor(Color.rgb(119, 147, 255))
        if (capture) builder.addAction(action(ACTION_STOP, R.string.stop_capture))
        builder.addAction(action(ACTION_LEAVE, if (capture) R.string.leave_room_notification else R.string.stop_listening))
        mediaSession?.let { builder.setStyle(Notification.MediaStyle().setMediaSession(it.sessionToken).setShowActionsInCompactView(0)) }
        return builder.build()
    }

    private fun scheduleProtectionTimeout() {
        main.removeCallbacks(protectionTimeout)
        lifecycle.deadlineMs?.let { deadline ->
            main.postDelayed(protectionTimeout, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1L))
        }
    }

    @Suppress("DEPRECATION")
    private fun setNetworkLocks(required: Boolean) {
        if (!required) {
            releaseResource("CPU lock") { wakeLock?.let { if (it.isHeld) it.release() } }
            releaseResource("Wi-Fi lock") { wifiLock?.let { if (it.isHeld) it.release() } }
            return
        }
        val cpu = wakeLock ?: getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoomSound:room-audio").apply {
                setReferenceCounted(false)
                wakeLock = this
            }
        val wifi = wifiLock ?: applicationContext.getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "RoomSound:room-audio").apply {
                setReferenceCounted(false)
                wifiLock = this
            }
        if (!cpu.isHeld) cpu.acquire()
        if (!wifi.isHeld) wifi.acquire()
    }

    private fun updateMediaSession(token: String, capture: Boolean) {
        if (mediaSessionToken == token && !capture) return
        mediaSession?.release()
        mediaSession = null
        mediaSessionToken = null
        // The external source app owns playback controls/focus during capture.
        if (capture) return
        mediaSession = MediaSession(this, "RoomSound listening").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onStop() { if (lifecycle.acceptsAction(token)) roomSession.leaveRoom() }
                override fun onPause() { if (lifecycle.acceptsAction(token)) roomSession.leaveRoom() }
                override fun onPlay() {
                    if (!lifecycle.acceptsAction(token)) return
                    // Only an explicit transport action may retry after permanent focus loss.
                    focusSuppressed = false
                    updateAudioFocus()
                }
            }, main)
            setPlaybackToLocal(mediaAudioAttributes())
            isActive = true
        }
        mediaSessionToken = token
    }

    private fun mediaAudioAttributes(): AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
        .build()

    private fun updateAudioFocus() {
        val state = roomSession.currentRoomState()
        val capturing = roomSession.pendingCapture() != null || lifecycle.captureId != null ||
            (state?.room?.activeSourceId != null && state.room.activeSourceId == state.self?.id)
        val remoteAudio = state != null && !capturing && state.room.activeSourceId != null &&
            state.room.sourceStatus in setOf("STARTING", "LIVE")
        val focusMode = RoomAudioFocusPolicy.mode(capturing, remoteAudio)
        if (focusMode == RoomAudioFocusPolicy.Mode.NONE) {
            abandonAudioFocus()
        } else if (remoteAudio && focusRequest == null && !focusSuppressed) {
            val roomId = lifecycle.sessionId
            lateinit var request: AudioFocusRequest
            request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(mediaAudioAttributes())
                .setWillPauseWhenDucked(false)
                .setOnAudioFocusChangeListener({ change ->
                    if (destroyed || lifecycle.sessionId != roomId || focusRequest !== request) return@setOnAudioFocusChangeListener
                    when (change) {
                        AudioManager.AUDIOFOCUS_GAIN,
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK,
                        -> {
                            // A competing app may ask us to duck, but that must
                            // not pause the relay. The native output is already
                            // a media stream and Android applies the ducking
                            // policy at the focus boundary when appropriate.
                            hasAudioFocus = true
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                            hasAudioFocus = false
                        }
                        AudioManager.AUDIOFOCUS_LOSS -> {
                            focusSuppressed = true
                            abandonAudioFocus()
                        }
                    }
                    // Never request focus in response to a loss.
                    roomSession.setPlaybackAllowed(hasAudioFocus)
                    updateMediaPlaybackState()
                }, main)
                .build()
            focusRequest = request
            hasAudioFocus = getSystemService(AudioManager::class.java).requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            if (!hasAudioFocus) {
                focusSuppressed = true
                abandonAudioFocus()
            }
        }
        roomSession.setPlaybackAllowed(remoteAudio && hasAudioFocus)
        updateMediaPlaybackState()
    }

    private fun updateMediaPlaybackState() {
        val state = when {
            lifecycle.phase in setOf(RoomPlaybackLifecycle.Phase.PREPARING, RoomPlaybackLifecycle.Phase.RECOVERING) -> PlaybackState.STATE_BUFFERING
            hasAudioFocus -> PlaybackState.STATE_PLAYING
            else -> PlaybackState.STATE_PAUSED
        }
        mediaSession?.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_STOP or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY)
            .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, if (hasAudioFocus) 1f else 0f)
            .build())
    }

    private fun abandonAudioFocus() {
        val request = focusRequest
        focusRequest = null // Ignore already-queued callbacks from the abandoned request.
        hasAudioFocus = false
        request?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
    }

    private fun releaseRoomProtection(stopStartedService: Boolean = true) {
        lifecycle.stop() // Invalidate actions before teardown can produce callbacks.
        main.removeCallbacks(protectionTimeout)
        releaseResource("control notifications") { controlRequestNotifications.dismissAll() }
        releaseResource("playback gate") { roomSession.setPlaybackAllowed(false) }
        releaseResource("audio focus") { abandonAudioFocus() }
        releaseResource("media session") { mediaSession?.release() }
        mediaSession = null
        mediaSessionToken = null
        setNetworkLocks(false)
        releaseResource("foreground notification") { stopForegroundNotification() }
        if (stopStartedService && !destroyed) stopSelf()
    }

    private inline fun releaseResource(name: String, action: () -> Unit) {
        try { action() } catch (error: Exception) {
            android.util.Log.w("RoomSound", "Could not release $name", error)
        }
    }

    private fun stopForegroundNotification() {
        if (foregroundMode != null) stopForeground(STOP_FOREGROUND_REMOVE)
        foregroundMode = null
        foregroundSessionId = null
        notificationToken = null
    }

    private fun finishCapture(sessionId: String) {
        if (lifecycle.captureId != sessionId) return
        lifecycle.captureFinished(sessionId)
        if (lifecycle.protected && !syncProtection()) roomSession.leaveRoom()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.capture_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.capture_notification_channel_description)
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
