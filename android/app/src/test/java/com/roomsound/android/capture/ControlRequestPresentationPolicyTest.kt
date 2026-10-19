package com.roomsound.android.capture

import android.app.NotificationManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlRequestPresentationPolicyTest {
    @Test
    fun `new high importance request uses full screen when access is allowed`() {
        assertTrue(
            ControlRequestPresentationPolicy.shouldUseFullScreenIntent(
                isNewRequest = true,
                notificationsEnabled = true,
                channelImportance = NotificationManager.IMPORTANCE_HIGH,
                fullScreenAccess = true,
            ),
        )
    }

    @Test
    fun `state refresh does not interrupt the user again`() {
        assertFalse(
            ControlRequestPresentationPolicy.shouldUseFullScreenIntent(
                isNewRequest = false,
                notificationsEnabled = true,
                channelImportance = NotificationManager.IMPORTANCE_HIGH,
                fullScreenAccess = true,
            ),
        )
    }

    @Test
    fun `blocked full screen falls back to the normal notification`() {
        assertFalse(
            ControlRequestPresentationPolicy.shouldUseFullScreenIntent(
                isNewRequest = true,
                notificationsEnabled = true,
                channelImportance = NotificationManager.IMPORTANCE_HIGH,
                fullScreenAccess = false,
            ),
        )
        assertFalse(
            ControlRequestPresentationPolicy.shouldUseFullScreenIntent(
                isNewRequest = true,
                notificationsEnabled = true,
                channelImportance = NotificationManager.IMPORTANCE_DEFAULT,
                fullScreenAccess = true,
            ),
        )
    }
}
