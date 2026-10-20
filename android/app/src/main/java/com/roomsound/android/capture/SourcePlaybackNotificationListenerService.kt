package com.roomsound.android.capture

import android.service.notification.NotificationListenerService

/**
 * Permission bridge for MediaSessionManager. Android only exposes other apps'
 * media sessions to an ordinary app through an enabled notification listener.
 * The service does not read notification text; it exists only so the app can
 * issue a pause command when this phone loses room source control.
 */
class SourcePlaybackNotificationListenerService : NotificationListenerService()
