package com.roomsound.android.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.roomsound.android.MainActivity
import com.roomsound.android.R
import com.roomsound.android.room.RoomRequest

/**
 * Notifications for room-control requests are owned by the started service,
 * rather than by the Activity. The request id is the only room value carried
 * by an action PendingIntent; room codes, endpoints, notes, and credentials
 * never enter notification or Intent data.
 */
internal class RoomControlRequestNotifications(context: Context) {
    companion object {
        const val ACTION_APPROVE_REQUEST = "com.roomsound.android.capture.APPROVE_REQUEST"
        const val ACTION_REJECT_REQUEST = "com.roomsound.android.capture.REJECT_REQUEST"
        const val EXTRA_REQUEST_ID = "com.roomsound.android.capture.REQUEST_ID"

        private const val CHANNEL_ID = "roomsound_control_requests"
        private const val NOTIFICATION_ID = 4201
        private const val CONTENT_PENDING_INTENT_REQUEST_CODE = 4202
    }

    private val appContext = context.applicationContext
    private val notificationManager = appContext.getSystemService(NotificationManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val activeRequestIds = mutableSetOf<String>()
    private val expiryCallbacks = mutableMapOf<String, Runnable>()

    init {
        createNotificationChannel()
    }

    fun show(request: RoomRequest) {
        val requestId = request.id.trim().takeIf { it.isNotEmpty() } ?: return
        if (!request.status.equals("PENDING", ignoreCase = true)) {
            dismiss(requestId)
            return
        }

        val now = System.currentTimeMillis()
        val expiresAt = request.expiresAt.takeIf { it > 0L }
        val timeout = expiresAt?.let { it - now }
        if (timeout != null && timeout <= 0L) {
            dismiss(requestId)
            return
        }

        cancelExpiry(requestId)
        activeRequestIds += requestId

        val builder = Notification.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_diya)
            .setContentTitle("${request.requesterName} wants to share audio")
            .setContentText(appContext.getString(R.string.control_request_notification_text))
            .setContentIntent(contentPendingIntent())
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_EVENT)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(
                Notification.Action.Builder(
                    null,
                    appContext.getString(R.string.approve_control_request),
                    actionPendingIntent(requestId, ACTION_APPROVE_REQUEST, "approve"),
                ).build(),
            )
            .addAction(
                Notification.Action.Builder(
                    null,
                    appContext.getString(R.string.reject_control_request),
                    actionPendingIntent(requestId, ACTION_REJECT_REQUEST, "reject"),
                ).build(),
            )

        if (timeout != null) builder.setTimeoutAfter(timeout)

        runCatching {
            notificationManager.notify(notificationTag(requestId), NOTIFICATION_ID, builder.build())
        }.onFailure { error ->
            // Android 13+ may reject the post until the Activity obtains the
            // runtime notification permission. The room controls remain usable.
            android.util.Log.w("RoomSound", "Control request notification unavailable", error)
        }

        if (timeout != null) {
            val expiry = Runnable { dismiss(requestId) }
            expiryCallbacks[requestId] = expiry
            main.postDelayed(expiry, timeout)
        }
    }

    fun dismiss(requestId: String) {
        val normalizedId = requestId.trim().takeIf { it.isNotEmpty() } ?: return
        cancelExpiry(normalizedId)
        activeRequestIds -= normalizedId
        runCatching { notificationManager.cancel(notificationTag(normalizedId), NOTIFICATION_ID) }
    }

    fun dismissExcept(requestIds: Set<String>) {
        activeRequestIds
            .filter { it !in requestIds }
            .forEach(::dismiss)
    }

    fun dismissAll() {
        activeRequestIds.toList().forEach(::dismiss)
    }

    fun close() {
        dismissAll()
        main.removeCallbacksAndMessages(null)
        expiryCallbacks.clear()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            appContext.getString(R.string.control_request_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = appContext.getString(R.string.control_request_channel_description)
            setLockscreenVisibility(Notification.VISIBILITY_PRIVATE)
            enableVibration(true)
        }
        notificationManager.createNotificationChannel(channel)
    }

    private fun contentPendingIntent(): PendingIntent {
        val intent = Intent(appContext, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        return PendingIntent.getActivity(
            appContext,
            CONTENT_PENDING_INTENT_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionPendingIntent(requestId: String, action: String, path: String): PendingIntent {
        val intent = Intent(appContext, PlaybackCaptureService::class.java).apply {
            this.action = action
            putExtra(EXTRA_REQUEST_ID, requestId)
            // The opaque request id makes approve/reject PendingIntents unique;
            // it does not contain room credentials or a room code.
            data = Uri.parse("roomsound://control-request/${Uri.encode(requestId)}/$path")
        }
        val actionOffset = if (action == ACTION_APPROVE_REQUEST) 0 else 1_000_000
        val requestCode = actionOffset + ((requestId.hashCode() and 0x3fffffff) % 1_000_000)
        return PendingIntent.getService(
            appContext,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun notificationTag(requestId: String): String = "roomsound.control-request.$requestId"

    private fun cancelExpiry(requestId: String) {
        expiryCallbacks.remove(requestId)?.let(main::removeCallbacks)
    }
}
