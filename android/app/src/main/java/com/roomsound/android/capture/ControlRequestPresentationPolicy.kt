package com.roomsound.android.capture

import android.app.NotificationManager

/**
 * Full-screen notification delivery is an optional presentation upgrade. The
 * request must still be actionable from the normal high-importance
 * notification when Android, the user, or the device policy blocks it.
 */
internal object ControlRequestPresentationPolicy {
    fun shouldUseFullScreenIntent(
        isNewRequest: Boolean,
        notificationsEnabled: Boolean,
        channelImportance: Int,
        fullScreenAccess: Boolean,
    ): Boolean = isNewRequest &&
        notificationsEnabled &&
        channelImportance >= NotificationManager.IMPORTANCE_HIGH &&
        fullScreenAccess
}
