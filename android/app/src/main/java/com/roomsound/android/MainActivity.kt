package com.roomsound.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import com.roomsound.android.capture.CaptureCapabilityReport
import com.roomsound.android.capture.CaptureSnapshot
import com.roomsound.android.capture.CaptureStatus
import com.roomsound.android.capture.PlaybackCaptureCapabilities
import com.roomsound.android.capture.PlaybackCaptureService
import com.roomsound.android.capture.RoomSessionCoordinator
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomState
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

/** Native Android room controls. Media/signaling state is owned by the service. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_MEDIA_PROJECTION = 6102
        private const val REQUEST_RUNTIME_PERMISSIONS = 6103
        private const val STATE_PENDING_CAPTURE_ID = "pending_capture_id"
        private const val STATE_PROJECTION_IN_FLIGHT = "projection_consent_in_flight"
        private const val PREFERENCES_NAME = "roomsound_android"
        private const val GUEST_ID_KEY = "guest_id"
        private const val ENDPOINT_KEY = "room_endpoint"
        private const val DISPLAY_NAME_KEY = "display_name"
        private const val DEFAULT_EMULATOR_ENDPOINT = "ws://10.0.2.2:4173"
    }

    private lateinit var capabilityText: TextView
    private lateinit var statusText: TextView
    private lateinit var frameText: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var endpointInput: EditText
    private lateinit var endpointHintText: TextView
    private lateinit var displayNameInput: EditText
    private lateinit var roomNameInput: EditText
    private lateinit var roomCodeInput: EditText
    private lateinit var roomConnectionText: TextView
    private lateinit var roomStateText: TextView
    private lateinit var roomMembersText: TextView
    private lateinit var roomEventsText: TextView
    private lateinit var transportText: TextView
    private lateinit var approvalContainer: LinearLayout
    private lateinit var moderationContainer: LinearLayout
    private lateinit var chatText: TextView
    private lateinit var chatInput: EditText
    private lateinit var volumeSeekBar: SeekBar
    private lateinit var muteButton: Button
    private lateinit var createRoomButton: Button
    private lateinit var joinRoomButton: Button
    private lateinit var testConnectionButton: Button
    private lateinit var sourceButton: Button
    private lateinit var takeoverButton: Button
    private lateinit var requestAudioButton: Button
    private lateinit var leaveRoomButton: Button
    private lateinit var endRoomButton: Button

    /** The capture transaction owned by the service/coordinator, if any. */
    private var pendingCaptureId: String? = null
    private var pendingCaptureStart = false
    private var pendingRoomSourceStart = false
    private var projectionConsentInFlight = false
    private var captureService: PlaybackCaptureService? = null
    private var serviceBound = false
    private var latestCapability: CaptureCapabilityReport? = null
    private var roomSession: RoomSessionCoordinator? = null
    private var latestRoomState: RoomState? = null
    private var latestSnapshot = CaptureSnapshot(CaptureStatus.IDLE)
    private var muted = false
    private val roomEvents = ArrayDeque<String>()
    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val guestId: String by lazy {
        preferences.getString(GUEST_ID_KEY, null)?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().also {
            preferences.edit().putString(GUEST_ID_KEY, it).apply()
        }
    }

    private val serviceListener: (CaptureSnapshot) -> Unit = { snapshot ->
        runOnUiThread { renderSnapshot(snapshot) }
    }

    private val roomListener = object : RoomSessionCoordinator.Listener {
        override fun onConnectionStateChanged(state: RoomConnectionState) {
            runOnUiThread {
                renderRoomConnection(state)
                if (state == RoomConnectionState.FAILED) {
                    appendRoomEvent("Connection failed. Check the endpoint, port, Wi-Fi, and Windows Firewall.")
                }
            }
        }

        override fun onEvent(event: RoomSoundEvent) {
            runOnUiThread { handleRoomEvent(event) }
        }

        override fun onPublisherStatus(message: String) {
            runOnUiThread {
                if (message.isNotBlank()) appendRoomEvent(message)
                renderTransport()
            }
        }

        override fun onSessionChanged() {
            runOnUiThread {
                renderRoomState(roomSession?.currentRoomState())
                renderTransport()
            }
        }
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val localBinder = binder as? PlaybackCaptureService.LocalBinder ?: return
            captureService = localBinder.service()
            serviceBound = true
            roomSession = captureService?.roomSession()
            roomSession?.addListener(roomListener)
            captureService?.addListener(serviceListener)
            renderSnapshot(captureService?.snapshot() ?: CaptureSnapshot(CaptureStatus.IDLE))
            renderRoomConnection(roomSession?.connectionState() ?: RoomConnectionState.IDLE)
            renderRoomState(roomSession?.currentRoomState())
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            roomSession?.removeListener(roomListener)
            captureService?.removeListener(serviceListener)
            roomSession = null
            captureService = null
            serviceBound = false
            renderSnapshot(CaptureSnapshot(CaptureStatus.STOPPED, message = "Capture service disconnected."))
            renderRoomState(null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Prevent native/WebRTC/AudioRecord errors from force-closing the app without a log.
        val prevHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try { android.util.Log.e("RoomSound", "Uncaught on "+thread.name, throwable) } catch (_: Throwable) {}
            try { prevHandler?.uncaughtException(thread, throwable) } catch (_: Throwable) { try { android.util.Log.e("RoomSound", "prevHandler crashed", throwable) } catch (_: Throwable) {} }
        }
        super.onCreate(savedInstanceState)
        pendingCaptureId = savedInstanceState?.getString(STATE_PENDING_CAPTURE_ID)
        projectionConsentInFlight = savedInstanceState?.getBoolean(STATE_PROJECTION_IN_FLIGHT, false) == true
        setContentView(buildContentView())
        refreshCapability()
        ensureCaptureService()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_PENDING_CAPTURE_ID, pendingCaptureId)
        outState.putBoolean(STATE_PROJECTION_IN_FLIGHT, projectionConsentInFlight)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        roomSession?.removeListener(roomListener)
        captureService?.removeListener(serviceListener)
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        // Do not close the started service: the room and foreground capture are
        // deliberately independent from this Activity's view lifecycle.
        super.onDestroy()
    }

    private fun ensureCaptureService() {
        val intent = Intent(this, PlaybackCaptureService::class.java)
        runCatching { startService(intent) }
            .onFailure { appendRoomEvent("Room service could not start: ${it.message}") }
        if (!serviceBound) bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
    }

    private fun buildContentView(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(24), dp(22), dp(24))
            setBackgroundColor(android.graphics.Color.rgb(7, 11, 22))
        }

        content.addView(TextView(this).apply {
            text = "RoomSound · device-audio room"
            textSize = 24f
            setTextColor(android.graphics.Color.WHITE)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }, matchWrap())
        content.addView(TextView(this).apply {
            text = "Share eligible playback from this phone with one room. RoomSound never selects a microphone source."
            textSize = 14f
            setTextColor(android.graphics.Color.rgb(164, 175, 201))
            setPadding(0, dp(10), 0, dp(20))
        }, matchWrap())

        content.addView(sectionTitle("Room control"), matchWrap())
        endpointInput = inputText("WebSocket endpoint", preferences.getString(ENDPOINT_KEY, defaultRoomEndpoint()))
        content.addView(endpointInput, matchWrap())
        endpointHintText = labelText().apply {
            text = if (BuildConfig.DEBUG) {
                "Debug: emulator ws://10.0.2.2:4173 · phone ws://<laptop LAN IPv4>:4173 · localhost is the phone itself."
            } else {
                "Release builds require a secure wss:// RoomSound endpoint."
            }
            textSize = 11f
            setTextColor(android.graphics.Color.rgb(126, 143, 177))
            setPadding(0, dp(6), 0, 0)
        }
        content.addView(endpointHintText, matchWrap())
        testConnectionButton = button("Test room connection") { testRoomConnection() }
        content.addView(testConnectionButton, marginLayout())

        displayNameInput = inputText("Display name", preferences.getString(DISPLAY_NAME_KEY, "Android guest"))
        content.addView(displayNameInput, marginLayout())
        roomNameInput = inputText("New room name", "Listening room")
        content.addView(roomNameInput, marginLayout())
        createRoomButton = button("Create room") { createRoom() }
        content.addView(createRoomButton, marginLayout())
        roomCodeInput = inputText("Room code to join", null).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        content.addView(roomCodeInput, marginLayout())
        joinRoomButton = button("Join room") { joinRoom() }
        content.addView(joinRoomButton, marginLayout())

        roomConnectionText = labelText().apply {
            text = "Connection: not connected"
            setPadding(0, dp(14), 0, dp(3))
        }
        content.addView(roomConnectionText, matchWrap())
        roomStateText = labelText()
        content.addView(roomStateText, matchWrap())
        roomMembersText = labelText().apply { setPadding(0, dp(8), 0, 0) }
        content.addView(roomMembersText, matchWrap())

        sourceButton = button("Share device audio") { handleSourceAction() }
        content.addView(sourceButton, marginLayout())
        takeoverButton = button("Take back control") { takeoverSource() }
        content.addView(takeoverButton, marginLayout())
        requestAudioButton = button("Request to share device audio") { requestAudioControl() }
        content.addView(requestAudioButton, marginLayout())
        leaveRoomButton = button("Leave room") { leaveRoom() }
        content.addView(leaveRoomButton, marginLayout())
        endRoomButton = button("End room") { endRoom() }
        content.addView(endRoomButton, marginLayout())

        approvalContainer = verticalContainer()
        content.addView(approvalContainer, matchWrap())
        moderationContainer = verticalContainer()
        content.addView(moderationContainer, matchWrap())

        content.addView(sectionTitle("Chat"), matchWrap())
        chatText = labelText().apply { setPadding(0, dp(4), 0, dp(4)) }
        content.addView(chatText, matchWrap())
        val chatRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        chatInput = inputText("Message", null)
        chatRow.addView(chatInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        chatRow.addView(button("Send") { sendChat() }, LinearLayout.LayoutParams(dp(92), LinearLayout.LayoutParams.WRAP_CONTENT))
        content.addView(chatRow, marginLayout())

        content.addView(TextView(this).apply {
            text = "Local listening"
            textSize = 18f
            setTextColor(android.graphics.Color.WHITE)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, dp(18), 0, dp(4))
        }, matchWrap())
        volumeSeekBar = SeekBar(this).apply {
            max = 100
            progress = 100
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) applyPlaybackVolume()
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }
        content.addView(volumeSeekBar, matchWrap())
        muteButton = button("Mute listening") { muted = !muted; updateMuteButton(); applyPlaybackVolume() }
        content.addView(muteButton, marginLayout())

        transportText = labelText().apply { setPadding(0, dp(12), 0, 0) }
        content.addView(transportText, matchWrap())
        roomEventsText = labelText().apply {
            text = "Room events will appear here."
            setPadding(0, dp(8), 0, dp(18))
        }
        content.addView(roomEventsText, matchWrap())

        content.addView(sectionTitle("Playback capture status"), matchWrap())
        capabilityText = labelText()
        content.addView(capabilityText, matchWrap())
        statusText = labelText().apply { setPadding(0, dp(14), 0, dp(3)) }
        content.addView(statusText, matchWrap())
        frameText = labelText()
        content.addView(frameText, matchWrap())
        startButton = button("Share device audio") { beginCapture(forRoomSource = true) }
        content.addView(startButton, marginLayout())
        stopButton = button("Stop capture") { stopCapture() }
        content.addView(stopButton, marginLayout())
        content.addView(TextView(this).apply {
            text = "Android 10+ playback capture requires the system consent dialog and the RECORD_AUDIO permission that Android uses as a playback-capture gate. RoomSound configures AudioRecord for eligible device playback, not the microphone, and the native media backend disables microphone recording. Source apps may opt out and protected content may be unavailable, so silence only reports that no non-zero samples arrived; it does not identify a blocking app."
            textSize = 12f
            setTextColor(android.graphics.Color.rgb(126, 143, 177))
            setPadding(0, dp(20), 0, 0)
        }, matchWrap())

        renderRoomState(null)
        renderTransport()
        updateMuteButton()
        return ScrollView(this).apply { addView(content) }
    }

    private fun createRoom() {
        val session = roomClientForEndpoint() ?: return
        val displayName = displayNameInput.text.toString().trim().ifEmpty { "Android guest" }
        val roomName = roomNameInput.text.toString().trim().ifEmpty { "Listening room" }
        saveRoomInputs(displayName)
        appendRoomEvent("Creating room '$roomName' as $displayName.")
        try {
            session.createRoom(roomName, displayName, guestId)
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "createRoom failed", t)
            appendRoomEvent(t.message ?: "The room could not be created: ${t.javaClass.simpleName}")
        }
    }

    private fun joinRoom() {
        val session = roomClientForEndpoint() ?: return
        val displayName = displayNameInput.text.toString().trim().ifEmpty { "Android guest" }
        val roomCode = roomCodeInput.text.toString().trim().uppercase(Locale.US)
        if (roomCode.isEmpty()) {
            appendRoomEvent("Enter a room code before joining.")
            return
        }
        saveRoomInputs(displayName)
        appendRoomEvent("Joining room $roomCode as $displayName.")
        try {
            session.joinRoom(roomCode, displayName, guestId)
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "joinRoom failed", t)
            appendRoomEvent(t.message ?: "The room could not be joined: ${t.javaClass.simpleName}")
        }
    }

    private fun testRoomConnection() {
        val session = roomClientForEndpoint() ?: return
        if (session.connectionState() == RoomConnectionState.JOINED) {
            appendRoomEvent("Already joined room ${session.currentRoomState()?.room?.code ?: ""}.")
            return
        }
        appendRoomEvent("Testing the RoomSound WebSocket endpoint…")
        session.connect()
    }

    private fun roomClientForEndpoint(): RoomSessionCoordinator? {
        val rawEndpoint = endpointInput.text.toString().trim()
        val endpoint = normalizeRoomEndpoint(rawEndpoint)
        if (endpoint == null) {
            appendRoomEvent(if (BuildConfig.DEBUG) {
                "Enter a host endpoint such as ws://192.168.1.20:4173. Do not use localhost on a phone."
            } else {
                "Release builds require a wss:// endpoint."
            })
            return null
        }
        if (endpointInput.text.toString() != endpoint) endpointInput.setText(endpoint)
        val session = roomSession
        if (session == null || !session.configureEndpoint(endpoint)) {
            appendRoomEvent("The room service is not ready or the endpoint is invalid.")
            return null
        }
        preferences.edit().putString(ENDPOINT_KEY, endpoint).apply()
        return session
    }

    private fun normalizeRoomEndpoint(value: String): String? {
        if (value.isBlank()) return null
        val withScheme = if ("://" in value) value else if (BuildConfig.DEBUG) "ws://$value" else "wss://$value"
        val endpoint = when {
            withScheme.startsWith("http://", ignoreCase = true) && BuildConfig.DEBUG -> "ws://${withScheme.substringAfter("://")}"
            withScheme.startsWith("https://", ignoreCase = true) -> "wss://${withScheme.substringAfter("://")}"
            withScheme.startsWith("ws://", ignoreCase = true) && BuildConfig.DEBUG -> "ws://${withScheme.substringAfter("://")}"
            withScheme.startsWith("wss://", ignoreCase = true) -> "wss://${withScheme.substringAfter("://")}"
            else -> return null
        }
        return endpoint.trimEnd('/').takeIf { it.length > 6 }
    }

    private fun defaultRoomEndpoint(): String {
        val saved = preferences.getString(ENDPOINT_KEY, null)?.trim()
        if (!saved.isNullOrEmpty() && (BuildConfig.DEBUG || saved.startsWith("wss://"))) return saved
        return if (BuildConfig.DEBUG && isProbablyEmulator()) DEFAULT_EMULATOR_ENDPOINT else ""
    }

    private fun isProbablyEmulator(): Boolean = Build.FINGERPRINT.startsWith("generic") ||
        Build.FINGERPRINT.lowercase().contains("emulator") ||
        Build.MODEL.contains("Emulator", ignoreCase = true) ||
        Build.MODEL.contains("Android SDK built for", ignoreCase = true)

    private fun saveRoomInputs(displayName: String) {
        preferences.edit().putString(DISPLAY_NAME_KEY, displayName).apply()
    }

    private fun handleRoomEvent(event: RoomSoundEvent) {
        try {
            when (event) {
                is RoomSoundEvent.Joined -> {
                    latestRoomState = event.state
                    appendRoomEvent("Joined room ${event.state.room.code}.")
                    renderRoomState(event.state)
                }
                is RoomSoundEvent.State -> {
                    latestRoomState = event.state
                    renderRoomState(event.state)
                }
                is RoomSoundEvent.Error -> appendRoomEvent("Server error: ${event.message}")
                is RoomSoundEvent.LocalError -> appendRoomEvent("Not sent: ${event.message}")
                is RoomSoundEvent.Chat -> appendRoomEvent("${event.message.senderName ?: "Room"}: ${event.message.text}")
                is RoomSoundEvent.ControlRequested -> appendRoomEvent(
                    "${event.request.requesterName} requested ${event.request.sourceType.lowercase(Locale.US)}. Review the approval controls below.",
                )
                is RoomSoundEvent.RequestResult -> appendRoomEvent(
                    "Audio request ${event.status.lowercase(Locale.US)}. ${if (event.status == "APPROVED") "Tap Share approved device audio to grant Android system consent." else ""}",
                )
                is RoomSoundEvent.ControlRequestExpired -> appendRoomEvent("Audio request ${event.requestId} expired.")
                is RoomSoundEvent.SourceDisconnected -> appendRoomEvent("The active source disconnected.")
                is RoomSoundEvent.HostDisconnected -> appendRoomEvent("The host disconnected.")
                is RoomSoundEvent.HostPromoted -> appendRoomEvent("A co-host was promoted to host.")
                is RoomSoundEvent.Takeover -> appendRoomEvent("The room source was taken over immediately.")
                is RoomSoundEvent.Removed -> {
                    latestRoomState = null
                    appendRoomEvent(event.message)
                    renderRoomState(null)
                }
                is RoomSoundEvent.RoomEnded -> {
                    latestRoomState = null
                    appendRoomEvent(event.message)
                    renderRoomState(null)
                }
                is RoomSoundEvent.Rtc -> Unit
                is RoomSoundEvent.StaleStateIgnored -> appendRoomEvent(
                    "Ignored stale room state epoch ${event.receivedEpoch}; current epoch is ${event.currentEpoch}.",
                )
                is RoomSoundEvent.Unknown -> appendRoomEvent("Ignored unknown room event '${event.type}'.")
            }
            renderTransport()
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "handleRoomEvent crashed for $event", t)
            appendRoomEvent("Room event handling hit an internal error (${t.javaClass.simpleName}); state refresh may be needed.")
            runCatching { renderTransport() }
        }
    }

    private fun renderRoomConnection(state: RoomConnectionState) {
        try {
            roomConnectionText.text = "Connection: ${state.name.lowercase(Locale.US)}"
            val joined = state == RoomConnectionState.JOINED
            createRoomButton.isEnabled = !joined
            joinRoomButton.isEnabled = !joined
            testConnectionButton.isEnabled = state !in setOf(
            RoomConnectionState.CONNECTING,
            RoomConnectionState.JOINED,
            RoomConnectionState.CLOSING,
        )
        if (!joined && latestRoomState == null) runCatching { renderRoomState(null) }
        } catch (t: Throwable) { android.util.Log.e("RoomSound", "renderRoomConnection failed", t) }
    }

    private fun renderRoomState(state: RoomState?) {
        try {
        latestRoomState = state
        if (state == null) {
            roomStateText.text = "No room state. Create or join a room to continue."
            roomMembersText.text = "Members: —"
            sourceButton.text = "Share device audio"
            sourceButton.isEnabled = false
            takeoverButton.isEnabled = false
            requestAudioButton.text = "Request to share device audio"
            requestAudioButton.isEnabled = false
            leaveRoomButton.isEnabled = false
            endRoomButton.isEnabled = false
            runCatching { approvalContainer.removeAllViews() }
            runCatching { moderationContainer.removeAllViews() }
            chatText.text = "—"
            return
        }

        val room = state.room
        val self = state.self
        val isHost = self != null && self.id == room.hostId
        val isModerator = self != null && (isHost || self.id == room.cohostId)
        val isSelfSource = self != null && self.id == room.activeSourceId
        val captureActive = latestSnapshot.status in setOf(
            CaptureStatus.STARTING,
            CaptureStatus.READY,
            CaptureStatus.CAPTURING,
            CaptureStatus.NO_ACTIVE_PLAYBACK,
        )
        val consentPending = projectionConsentInFlight || pendingCaptureStart
        val sourceMember = state.members.firstOrNull { it.id == room.activeSourceId }
        roomStateText.text = buildString {
            append("Room ${room.code} · ${room.status}\n")
            append("Source: ${sourceMember?.name ?: "none"} · ${room.sourceStatus} · epoch ${room.sourceEpoch}")
            if (room.sourceStatus.equals("STARTING", ignoreCase = true)) append("\nAndroid consent/readiness is still required before this source goes live.")
        }
        roomMembersText.text = buildString {
            append("Members (${state.members.size}): ")
            append(state.members.joinToString { member ->
                "${member.name} (${member.role.lowercase(Locale.US)})${if (member.id == room.activeSourceId) " · sharing" else ""}"
            }.ifEmpty { "—" })
        }

        if (isSelfSource) {
            sourceButton.text = when {
                consentPending -> "Awaiting Android consent…"
                captureActive && room.sourceStatus.equals("STARTING", ignoreCase = true) -> "Preparing device audio…"
                captureActive -> "Stop sharing device audio"
                room.sourceStatus.equals("STARTING", ignoreCase = true) -> "Share approved device audio"
                else -> "Resume device audio"
            }
            sourceButton.isEnabled = !consentPending && (!captureActive || room.sourceStatus.equals("LIVE", ignoreCase = true) ||
                room.sourceStatus.equals("STARTING", ignoreCase = true)
            )
        } else if (isModerator && room.activeSourceId == null) {
            sourceButton.text = when {
                consentPending -> "Awaiting Android consent…"
                captureActive -> "Preparing device audio…"
                else -> "Share device audio"
            }
            sourceButton.isEnabled = !consentPending && !captureActive
        } else {
            sourceButton.text = "Wait for source control"
            sourceButton.isEnabled = false
        }
        val ownPendingRequest = self != null && state.requests.any {
            it.requesterId == self.id && it.status.equals("PENDING", ignoreCase = true)
        }
        requestAudioButton.text = if (ownPendingRequest) "Audio request pending" else "Request to share device audio"
        requestAudioButton.isEnabled = self != null && !isModerator && room.activeSourceId == null && !ownPendingRequest
        takeoverButton.isEnabled = isModerator && room.activeSourceId != null && !isSelfSource
        leaveRoomButton.isEnabled = true
        endRoomButton.isEnabled = isHost
        runCatching { renderApprovalControls(state, isModerator) }
        runCatching { renderModerationControls(state, isHost, isModerator) }
        chatText.text = state.messages.takeLast(12).joinToString("\n") { message ->
            "${message.senderName ?: "Room"}: ${message.text}"
        }.ifEmpty { "No messages yet." }
        } catch (t: Throwable) { android.util.Log.e("RoomSound", "renderRoomState failed", t); appendRoomEvent("Room UI hit an internal error: ${t.message}") }
    }

    private fun renderApprovalControls(state: RoomState, isModerator: Boolean) {
        approvalContainer.removeAllViews()
        if (!isModerator) return
        val pending = state.requests.filter { it.status.equals("PENDING", ignoreCase = true) }
        approvalContainer.addView(sectionLabel("Broadcast requests"))
        if (pending.isEmpty()) {
            approvalContainer.addView(labelText().apply { text = "No pending requests." }, matchWrap())
            return
        }
        pending.forEach { request ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            row.addView(labelText().apply {
                text = "${request.requesterName}: ${request.note.ifBlank { "device audio" }}"
                setPadding(0, dp(5), dp(6), dp(5))
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(button("Approve") { approveRequest(request.id) }, LinearLayout.LayoutParams(dp(100), LinearLayout.LayoutParams.WRAP_CONTENT))
            row.addView(button("Reject") { rejectRequest(request.id) }, LinearLayout.LayoutParams(dp(92), LinearLayout.LayoutParams.WRAP_CONTENT))
            approvalContainer.addView(row, matchWrap())
        }
    }

    private fun renderModerationControls(state: RoomState, isHost: Boolean, isModerator: Boolean) {
        moderationContainer.removeAllViews()
        if (!isModerator) return
        moderationContainer.addView(sectionLabel(if (isHost) "Host controls" else "Co-host controls"))
        if (isHost) {
            val currentCohost = state.members.firstOrNull { it.id == state.room.cohostId }
            if (currentCohost != null) {
                moderationContainer.addView(button("Remove co-host: ${currentCohost.name}") {
                    assignCohost(null)
                }, matchWrap())
            }
            state.members.filter { member ->
                member.id != state.self?.id && member.id != state.room.hostId && member.id != state.room.cohostId
            }.forEach { member ->
                moderationContainer.addView(button("Make ${member.name} co-host") {
                    assignCohost(member.id)
                }, matchWrap())
            }
        }
        state.members.filter { member -> member.id != state.self?.id && member.id != state.room.hostId }.forEach { member ->
            moderationContainer.addView(button("Remove ${member.name}") { removeMember(member.id) }, matchWrap())
        }
    }

    private fun renderTransport() {
        val snapshot = roomSession?.transportSnapshot()
        if (snapshot == null) {
            transportText.text = "Transport: not attached to a room service."
            return
        }
        transportText.text = buildString {
            append("Transport: ")
            append(if (snapshot.mediaBackendConfigured) "native WebRTC publisher configured" else "media backend unavailable")
            append(" · ready=${snapshot.backendReady}")
            append(" · accepted=${snapshot.acceptedFrames}")
            append(" · dropped unauthorized=${snapshot.droppedUnauthorizedFrames}")
            append(" · dropped not-live=${snapshot.droppedNotLiveFrames}")
            append(" · dropped stale=${snapshot.droppedStaleEpochFrames}")
            if (snapshot.authorization?.canPublishFrames == true) append("\nServer reports this phone as LIVE source.")
        }
    }

    private fun handleSourceAction() {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        val self = state.self ?: return
        val isModerator = self.id == state.room.hostId || self.id == state.room.cohostId
        val isSelfSource = self.id == state.room.activeSourceId
        val captureActive = latestSnapshot.status in setOf(
            CaptureStatus.STARTING,
            CaptureStatus.READY,
            CaptureStatus.CAPTURING,
            CaptureStatus.NO_ACTIVE_PLAYBACK,
        )
        if (isSelfSource && captureActive) {
            stopCapture()
        } else if (isSelfSource || (isModerator && state.room.activeSourceId == null)) {
            beginCapture(forRoomSource = true)
        } else {
            appendRoomEvent("Refresh the room state before sharing; this phone is not the active source.")
        }
    }

    private fun requestAudioControl() {
        val session = roomSession ?: return
        val state = session.currentRoomState()
        val self = state?.self
        if (state == null || self == null || self.id == state.room.hostId || self.id == state.room.cohostId || state.room.activeSourceId != null) {
            appendRoomEvent("A request is available only to a participant while no source is active.")
            return
        }
        if (session.requestControl("ANDROID_DEVICE_AUDIO", "I want to share Android playback audio.")) {
            appendRoomEvent("Requested device-audio control from the host.")
        } else appendRoomEvent("The request could not be sent; join a room first.")
    }

    private fun takeoverSource() {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.room.activeSourceId == null || state.self?.id == state.room.activeSourceId) {
            appendRoomEvent("Refresh the room state; takeover is available only to a host or co-host while another source is active.")
            return
        }
        if (session.takeover()) appendRoomEvent("Taking back control now. Android consent is required before this phone goes live.")
    }

    private fun approveRequest(requestId: String) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.requests.none { it.id == requestId && it.status.equals("PENDING", true) }) {
            appendRoomEvent("Refresh the room state; this request is no longer actionable.")
            return
        }
        if (session.approveRequest(requestId)) appendRoomEvent("Approved request. The participant must tap Share and complete Android consent.")
    }

    private fun rejectRequest(requestId: String) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.requests.none { it.id == requestId && it.status.equals("PENDING", true) }) {
            appendRoomEvent("Refresh the room state; this request is no longer actionable.")
            return
        }
        session.rejectRequest(requestId)
    }

    private fun assignCohost(memberId: String?) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (state.self?.id != state.room.hostId) {
            appendRoomEvent("Only the host can assign or remove a co-host.")
            return
        }
        if (memberId != null && state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) {
            appendRoomEvent("Refresh the member list before assigning a co-host.")
            return
        }
        session.assignCohost(memberId)
    }

    private fun removeMember(memberId: String) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) {
            appendRoomEvent("Refresh the room state; that member cannot be removed now.")
            return
        }
        session.removeMember(memberId)
    }

    private fun endRoom() {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (state.self?.id != state.room.hostId) {
            appendRoomEvent("Only the host can end the room.")
            return
        }
        if (session.endRoom()) appendRoomEvent("Ending the room…")
    }

    private fun sendChat() {
        val session = roomSession ?: return
        if (session.currentRoomState() == null) {
            appendRoomEvent("Join a room before sending chat.")
            return
        }
        if (session.sendChat(chatInput.text.toString())) chatInput.setText("")
    }

    private fun leaveRoom() {
        pendingCaptureStart = false
        projectionConsentInFlight = false
        cancelPendingCapture("Left the room before capture consent completed.")
        roomSession?.leaveRoom()
        latestRoomState = null
        renderRoomState(null)
        renderTransport()
        appendRoomEvent("Left the room.")
    }

    private fun isCurrentModerator(state: RoomState): Boolean {
        val selfId = state.self?.id ?: return false
        return selfId == state.room.hostId || selfId == state.room.cohostId
    }

    private fun beginCapture(forRoomSource: Boolean) {
        if (projectionConsentInFlight || pendingCaptureStart) {
            appendRoomEvent("Android capture consent is already in progress.")
            return
        }
        val session = roomSession ?: return
        if (!forRoomSource) {
            appendRoomEvent("Playback capture is available only when this phone is sharing room audio.")
            return
        }
        val captureId = session.beginCapture()
        if (captureId == null) {
            appendRoomEvent("The current room state does not authorize this phone to share.")
            return
        }
        pendingCaptureId = captureId
        val capability = latestCapability ?: PlaybackCaptureCapabilities.inspect(this)
        if (!capability.apiSupported || !capability.mediaProjectionAvailable) {
            cancelPendingCapture(capability.summary)
            renderSnapshot(CaptureSnapshot(CaptureStatus.UNSUPPORTED_API, message = capability.summary))
            return
        }
        val missingPermissions = buildList {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                add(Manifest.permission.RECORD_AUDIO)
            }
        }
        pendingRoomSourceStart = forRoomSource
        if (missingPermissions.isNotEmpty()) {
            pendingCaptureStart = true
            renderSnapshot(CaptureSnapshot(
                CaptureStatus.PERMISSION_REQUIRED,
                message = "Allow Android's playback-capture permission. RoomSound does not use a microphone input.",
            ))
            requestPermissions(missingPermissions.toTypedArray(), REQUEST_RUNTIME_PERMISSIONS)
            return
        }
        launchProjectionConsent()
    }

    private fun launchProjectionConsent() {
        val session = roomSession
        val captureId = pendingCaptureId
        if (session == null || captureId == null || !session.prepareProjection(captureId) ||
            !session.markProjectionDialogOpen(captureId)
        ) {
            failPendingCapture("The room source authorization changed before Android consent could start.")
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        if (manager == null) {
            failPendingCapture("MediaProjection is unavailable.")
            return
        }
        pendingCaptureStart = false
        projectionConsentInFlight = true
        renderSnapshot(CaptureSnapshot(CaptureStatus.PROJECTION_REQUIRED, message = "Approve Android's system playback-capture dialog. No microphone source is selected."))
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_RUNTIME_PERMISSIONS || !pendingCaptureStart) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            launchProjectionConsent()
        } else {
            failPendingCapture("Android audio permission was denied; playback capture cannot start.")
        }
    }

    @Deprecated("Uses the dependency-free platform Activity result API.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_MEDIA_PROJECTION || !projectionConsentInFlight) return
        projectionConsentInFlight = false
        if (resultCode != RESULT_OK || data == null) {
            failPendingCapture("Android system capture consent was canceled.")
            return
        }
        if (roomSession == null || pendingCaptureId == null) {
            failPendingCapture("The room service is unavailable.")
            return
        }
        val sessionId = requireNotNull(pendingCaptureId)
        val serviceIntent = Intent(this, PlaybackCaptureService::class.java).apply {
            action = PlaybackCaptureService.ACTION_START
            putExtra(PlaybackCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(PlaybackCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(PlaybackCaptureService.EXTRA_SESSION_ID, sessionId)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(serviceIntent) else startService(serviceIntent)
            renderSnapshot(CaptureSnapshot(CaptureStatus.STARTING, message = "Starting foreground playback capture; source activation waits for a successful AudioRecord read."))
        } catch (error: Throwable) {
            failPendingCapture("The foreground capture service could not start: ${error.message}")
        } finally {
            pendingRoomSourceStart = false
        }
    }

    private fun failPendingCapture(message: String) {
        pendingCaptureStart = false
        projectionConsentInFlight = false
        pendingRoomSourceStart = false
        cancelPendingCapture(message)
        renderSnapshot(CaptureSnapshot(CaptureStatus.ERROR, message = message))
    }

    private fun cancelPendingCapture(message: String) {
        val session = roomSession ?: return
        val captureId = pendingCaptureId ?: return
        session.cancelCapture(captureId, message)
        pendingCaptureId = null
    }

    private fun stopCapture() {
        pendingCaptureStart = false
        if (projectionConsentInFlight) {
            projectionConsentInFlight = false
            cancelPendingCapture("Capture consent canceled by the user.")
        } else {
            roomSession?.stopCapture()
            pendingCaptureId = null
        }
        pendingRoomSourceStart = false
        renderSnapshot(CaptureSnapshot(CaptureStatus.STOPPED, message = "Stopping device audio capture."))
    }

    private fun refreshCapability() {
        latestCapability = PlaybackCaptureCapabilities.inspect(this)
        val capability = latestCapability ?: return
        capabilityText.text = "Capability: ${capability.summary}"
        renderSnapshot(CaptureSnapshot(if (capability.apiSupported) CaptureStatus.IDLE else CaptureStatus.UNSUPPORTED_API))
    }

    private fun renderSnapshot(snapshot: CaptureSnapshot) {
        latestSnapshot = snapshot
        if (snapshot.status == CaptureStatus.ERROR || snapshot.status == CaptureStatus.STOPPED) {
            pendingCaptureId = null
        }
        statusText.text = buildString {
            append("Status: ${snapshot.status.name}")
            if (snapshot.ready) append(" · ready to publish")
        }
        frameText.text = buildString {
            append("Sample frames read: ${snapshot.framesCaptured} · non-silent sample frames: ${snapshot.nonSilentFrames}")
            if (!snapshot.message.isNullOrBlank()) append("\n${snapshot.message}")
        }
        val active = snapshot.status in setOf(
            CaptureStatus.STARTING,
            CaptureStatus.READY,
            CaptureStatus.CAPTURING,
            CaptureStatus.NO_ACTIVE_PLAYBACK,
        )
        startButton.isEnabled = !active && !projectionConsentInFlight
        stopButton.isEnabled = active || projectionConsentInFlight || pendingCaptureStart
        renderRoomState(roomSession?.currentRoomState() ?: latestRoomState)
        renderTransport()
    }

    private fun applyPlaybackVolume() {
        val level = if (muted) 0.0 else volumeSeekBar.progress / 100.0
        roomSession?.setPlaybackVolume(level)
    }

    private fun updateMuteButton() {
        if (::muteButton.isInitialized) muteButton.text = if (muted) "Unmute listening" else "Mute listening"
    }

    private fun appendRoomEvent(message: String) {
        if (roomEvents.size >= 10) roomEvents.removeFirst()
        roomEvents.addLast(message)
        if (::roomEventsText.isInitialized) roomEventsText.text = roomEvents.joinToString("\n")
    }

    private fun inputText(hint: String, value: String?): EditText = EditText(this).apply {
        setHint(hint)
        setText(value ?: "")
        setSingleLine(true)
        setTextColor(android.graphics.Color.WHITE)
        setHintTextColor(android.graphics.Color.rgb(126, 143, 177))
        textSize = 15f
        setPadding(dp(12), dp(8), dp(12), dp(8))
    }

    private fun button(text: String, action: () -> Unit): Button = Button(this).apply {
        this.text = text
        setOnClickListener { action() }
    }

    private fun sectionTitle(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTextColor(android.graphics.Color.WHITE)
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(18), 0, dp(6))
    }

    private fun sectionLabel(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 15f
        setTextColor(android.graphics.Color.rgb(197, 207, 233))
        setPadding(0, dp(12), 0, dp(4))
    }

    private fun verticalContainer() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

    private fun labelText(): TextView = TextView(this).apply {
        textSize = 14f
        setTextColor(android.graphics.Color.rgb(197, 207, 233))
    }

    private fun matchWrap() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    )

    private fun marginLayout() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
        topMargin = dp(10)
        gravity = Gravity.CENTER_HORIZONTAL
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
