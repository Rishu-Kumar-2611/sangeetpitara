package com.roomsound.android.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomPlaybackLifecycleTest {
    private fun listening() = RoomPlaybackLifecycle().apply {
        assertTrue(prepare("room-attempt-1", 1_000L))
        joined(isStreaming = true)
    }

    @Test
    fun joined_home_unchanged_state_and_reconnect_keep_protection() {
        val policy = listening()
        val token = policy.actionToken
        // Home, rotation and Activity close have no lifecycle teardown event.
        assertTrue(policy.protected)
        policy.joined(isStreaming = true)
        assertTrue(policy.needsLocks)
        policy.disconnected(2_000L)
        assertEquals(RoomPlaybackLifecycle.Phase.RECOVERING, policy.phase)
        assertEquals(RoomPlaybackLifecycle.Mode.PLAYBACK, policy.mode)
        assertTrue(policy.protected)
        assertTrue(policy.needsLocks)
        assertEquals(token, policy.actionToken)
        policy.joined(isStreaming = true)
        assertNull(policy.deadlineMs)
        assertTrue(policy.protected)
    }

    @Test
    fun reconnect_attempts_do_not_extend_the_bounded_recovery_window() {
        val policy = listening()
        policy.disconnected(2_000L)
        val deadline = requireNotNull(policy.deadlineMs)
        policy.disconnected(deadline - 1)
        assertEquals(deadline, policy.deadlineMs)
        assertFalse(policy.isExpired(deadline - 1))
        assertTrue(policy.isExpired(deadline))
        policy.stop() // Service timeout leaves/closes the coordinator before releasing resources.
        assertFalse(policy.needsLocks)
        assertFalse(policy.protected)
    }

    @Test
    fun explicit_leave_ending_removal_or_destruction_invalidates_the_session() {
        // Each terminal coordinator path emits the same onRoomSessionStopped callback.
        val policy = listening()
        policy.captureStarted("capture-1")
        val token = policy.actionToken
        policy.stop()
        assertFalse(policy.protected)
        assertFalse(policy.needsLocks)
        assertNull(policy.mode)
        assertNull(policy.captureId)
        assertFalse(policy.acceptsAction(token))
        policy.captureFinished("capture-1")
        policy.joined(isStreaming = true)
        policy.disconnected(10_000L)
        assertFalse(policy.protected) // Late close/dispose callbacks cannot revive foreground work.
    }

    @Test
    fun capture_to_listener_during_recovery_never_has_an_unprotected_gap() {
        val policy = listening()
        assertTrue(policy.captureStarted("capture-1"))
        assertEquals(RoomPlaybackLifecycle.Mode.CAPTURE, policy.mode)
        policy.disconnected(2_000L)
        policy.captureFinished("capture-1")
        assertEquals(RoomPlaybackLifecycle.Mode.PLAYBACK, policy.mode)
        assertTrue(policy.protected)
        assertTrue(policy.needsLocks)
        assertEquals(RoomPlaybackLifecycle.Phase.RECOVERING, policy.phase)
    }

    @Test
    fun failed_initial_join_releases_preparation_and_ignores_late_join() {
        val policy = RoomPlaybackLifecycle()
        policy.prepare("failed", 0L)
        assertTrue(policy.protected)
        assertTrue(policy.needsLocks)
        policy.initialJoinFailed()
        assertFalse(policy.protected)
        assertFalse(policy.needsLocks)
        assertNull(policy.deadlineMs)
        policy.joined(isStreaming = true)
        assertFalse(policy.protected)
        assertTrue(policy.prepare("retry", 5_000L))
    }

    @Test
    fun stalled_config_or_join_has_a_deadline_even_without_a_socket_callback() {
        val policy = RoomPlaybackLifecycle()
        policy.prepare("attempt", 5_000L)
        policy.disconnected(10_000L)
        assertEquals(RoomPlaybackLifecycle.Phase.PREPARING, policy.phase)
        assertTrue(policy.isExpired(5_000L + RoomPlaybackLifecycle.PREPARATION_TIMEOUT_MS))
    }

    @Test
    fun stale_capture_notification_cannot_stop_a_new_capture_or_leave_it() {
        val policy = listening()
        policy.captureStarted("capture-1")
        val oldToken = policy.actionToken
        policy.captureFinished("capture-1")
        policy.captureStarted("capture-2")
        assertFalse(policy.acceptsCaptureStop(oldToken, "capture-1"))
        assertFalse(policy.acceptsAction(oldToken))
        assertFalse(policy.acceptsCaptureStop(policy.actionToken, null))
        assertFalse(policy.acceptsCaptureStop(null, "capture-2"))
        assertTrue(policy.acceptsCaptureStop(policy.actionToken, "capture-2"))
        policy.captureFinished("capture-1")
        assertEquals("capture-2", policy.captureId)
    }

    @Test
    fun old_listener_media_session_stop_cannot_stop_new_capture() {
        val policy = listening()
        val mediaSessionToken = policy.actionToken
        policy.captureStarted("capture-1")
        assertFalse(policy.acceptsAction(mediaSessionToken))
        policy.captureFinished("capture-1")
        assertFalse(policy.acceptsAction(mediaSessionToken))
        assertTrue(policy.acceptsAction(policy.actionToken))
    }

    @Test
    fun stale_previous_room_action_cannot_leave_a_new_room() {
        val policy = listening()
        val oldToken = policy.actionToken
        policy.stop()
        policy.prepare("room-attempt-2", 10_000L)
        assertNotEquals(oldToken, policy.actionToken)
        assertFalse(policy.acceptsAction(oldToken))
    }

    @Test
    fun idle_joined_room_keeps_notification_but_releases_network_locks() {
        val policy = listening()
        policy.joined(isStreaming = false)
        assertTrue(policy.protected)
        assertFalse(policy.needsLocks)
        policy.captureStarted("capture-1")
        assertTrue(policy.needsLocks)
        policy.captureFinished("capture-1")
        assertFalse(policy.needsLocks)
        policy.joined(isStreaming = true)
        assertTrue(policy.needsLocks)
    }

    @Test
    fun duplicate_preparation_and_capture_cannot_replace_active_actions() {
        val policy = listening()
        val token = policy.actionToken
        assertFalse(policy.prepare("replacement", 10_000L))
        assertEquals(token, policy.actionToken)
        policy.captureStarted("capture-1")
        assertFalse(policy.captureStarted("capture-2"))
        assertEquals("capture-1", policy.captureId)
    }
}
