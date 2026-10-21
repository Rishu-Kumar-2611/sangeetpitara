package com.roomsound.android.capture

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomEndpointValidator
import com.roomsound.android.room.RoomMediaRelayConfig
import com.roomsound.android.room.RoomServerConfig
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomSoundWebSocketClient
import com.roomsound.android.room.RoomState
import com.roomsound.android.transport.RoomAudioTransport
import com.roomsound.android.transport.RoomAudioTransportSnapshot
import com.roomsound.android.transport.Pcm16FramePublisher
import com.roomsound.android.transport.Pcm16RelayPlayer
import com.roomsound.android.transport.Pcm16RelayPublisher
import com.roomsound.android.transport.WebRtcPcmPublisher
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

enum class ConsentPhase { AUDIO_PERMISSION, SYSTEM_CONSENT, SYSTEM_DIALOG_OPEN, INITIALIZING, AWAITING_LIVE, LIVE }

data class PendingCapture(val id: String, val phase: ConsentPhase)

/** Service-owned signaling, consent transaction, source lease, and native media. */
class RoomSessionCoordinator(
    context: Context,
    private val stopLocalCapture: (String, String, Boolean) -> Unit,
) : Closeable {
    interface Listener {
        fun onConnectionStateChanged(state: RoomConnectionState)
        fun onEvent(event: RoomSoundEvent)
        fun onPublisherStatus(message: String)
        fun onSessionChanged() = Unit
        /** Intentional teardown/failure, unlike a recoverable socket disconnect. */
        fun onRoomSessionStopped() = Unit
    }

    private data class Slot(val roomId: String, val memberId: String, val epoch: Long)
    private data class Attempt(
        val id: String,
        val roomId: String,
        val memberId: String,
        val baselineEpoch: Long,
        var slot: Slot?,
        var phase: ConsentPhase = ConsentPhase.AUDIO_PERMISSION,
        var expectedLiveEpoch: Long? = null,
    )
    private data class Takeover(val roomId: String, val memberId: String, val baselineEpoch: Long, var canceled: Boolean = false)
    private data class MediaBinding(
        val captureId: String,
        val slot: Slot,
        val client: RoomSoundWebSocketClient,
        val transport: RoomAudioTransport,
    )

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<Listener>()
    private var endpoint: String? = null
    private var client: RoomSoundWebSocketClient? = null
    private var clientListener: RoomSoundWebSocketClient.Listener? = null
    private var publisher: Pcm16FramePublisher? = null
    private var relayPlayer: Pcm16RelayPlayer? = null
    private var transport: RoomAudioTransport? = null
    private var mediaRelayConfig = RoomMediaRelayConfig.DEFAULT
    private var mediaConfigured = false
    private var pendingRoomAction: ((RoomSoundWebSocketClient) -> Unit)? = null
    private var connectPending = false
    private var attempt: Attempt? = null
    private var takeover: Takeover? = null
    private val consumedConsents = mutableSetOf<String>()
    private val releasedSlots = mutableSetOf<Slot>()
    private var roomSelectionPending = false
    private var requestPending = false
    private var endPending = false
    private var volume = 1.0
    private var playbackAllowed = false
    private var closed = false
    @Volatile private var mediaBinding: MediaBinding? = null

    fun addListener(listener: Listener) {
        listeners += listener
        listener.onConnectionStateChanged(connectionState())
        listener.onSessionChanged()
    }

    fun removeListener(listener: Listener) { listeners -= listener }
    fun connectionState(): RoomConnectionState = client?.connectionState() ?: RoomConnectionState.IDLE
    fun currentRoomState(): RoomState? = joinedState()
    fun currentEndpoint(): String? = endpoint
    fun currentMediaRelayConfig(): RoomMediaRelayConfig = mediaRelayConfig
    fun pendingCapture(): PendingCapture? = attempt?.let { PendingCapture(it.id, it.phase) }
    fun isTakeoverPending(): Boolean = takeover != null
    fun isRoomSelectionPending(): Boolean = roomSelectionPending
    fun canSelectRoom(): Boolean = !closed && !roomSelectionPending && client?.currentRoomState() == null
    fun playbackVolume(): Double = volume
    fun hasMediaBackend(): Boolean = transport?.hasMediaBackend() == true
    fun transportSnapshot(): RoomAudioTransportSnapshot? = transport?.snapshot()

    fun configureEndpoint(rawEndpoint: String): Boolean {
        if (closed) return false
        val next = RoomEndpointValidator.normalize(rawEndpoint) ?: return false
        if (endpoint == next && client != null) return true
        if (client?.currentRoomState() != null || roomSelectionPending || attempt != null) {
            status("Leave the current room before changing its endpoint.")
            return false
        }
        disposeRoom(notifyStopped = false)
        val nextClient = RoomSoundWebSocketClient(next)
        client = nextClient
        endpoint = next
        val listener = object : RoomSoundWebSocketClient.Listener {
            override fun onConnectionStateChanged(state: RoomConnectionState) {
                // Revoke frame forwarding immediately on the socket thread.
                if (state != RoomConnectionState.JOINED && mediaBinding?.client === nextClient) mediaBinding = null
                main.post {
                    if (!closed && client === nextClient) handleConnection(nextClient.connectionState())
                }
            }
            override fun onEvent(event: RoomSoundEvent) {
                val observedEpoch = nextClient.currentRoomState()?.room?.sourceEpoch
                main.post {
                    if (!closed && client === nextClient) handleEvent(event, observedEpoch)
                }
            }
        }
        clientListener = listener
        nextClient.addListener(listener)
        // UI entry points may immediately queue create/join. They are held
        // until config and the selected media backend are ready, so no offer
        // or binary frame can arrive before its listener has been installed.
        nextClient.fetchServerConfigAsync { fetchedConfig ->
            main.post {
                if (!closed && client === nextClient) configureMedia(nextClient, fetchedConfig)
            }
        }
        changed()
        return true
    }

    private fun configureMedia(nextClient: RoomSoundWebSocketClient, fetchedConfig: RoomServerConfig) {
        var nextPublisher: Pcm16FramePublisher? = null
        var nextRelayPlayer: Pcm16RelayPlayer? = null
        try {
            // The server's fail-safe default is the no-TURN PCM16 relay. Only
            // an explicit enabled=false config selects direct WebRTC; an
            // unknown enabled relay shape must not silently re-enable TURN.
            mediaRelayConfig = fetchedConfig.mediaRelay
            val relayEnabled = fetchedConfig.mediaRelay.enabled
            if (relayEnabled) {
                require(fetchedConfig.mediaRelay.isPcm16Enabled) {
                    "Unsupported relay config: ${fetchedConfig.mediaRelay.mode}/" +
                        "${fetchedConfig.mediaRelay.sampleRate} Hz/${fetchedConfig.mediaRelay.channels} ch."
                }
                nextRelayPlayer = Pcm16RelayPlayer(
                    onStatus = { message ->
                        main.post { if (!closed && client === nextClient) status(message) }
                    },
                )
                nextPublisher = Pcm16RelayPublisher(nextClient)
            } else {
                nextPublisher = WebRtcPcmPublisher(
                    context = appContext,
                    roomClient = nextClient,
                    onStatus = { message ->
                        main.post { if (!closed && client === nextClient) status(message) }
                    },
                    onDiagnosticsChanged = {
                        main.post { if (!closed && client === nextClient) changed() }
                    },
                )
            }
            val createdPublisher = requireNotNull(nextPublisher)
            publisher = createdPublisher
            relayPlayer = nextRelayPlayer
            val effectiveVolume = if (playbackAllowed) volume else 0.0
            if (createdPublisher is WebRtcPcmPublisher) createdPublisher.setPlaybackVolume(effectiveVolume)
            nextRelayPlayer?.setVolume(effectiveVolume)
            transport = RoomAudioTransport(nextClient, createdPublisher, nextRelayPlayer)
        } catch (error: Throwable) {
            runCatching { nextPublisher?.close() }
            runCatching { nextRelayPlayer?.close() }
            disposeRoom()
            val why = error.message ?: error.javaClass.simpleName
            status("Native audio could not initialize: $why")
            android.util.Log.e("RoomSound", "configureEndpoint init failed", error)
            changed()
            return
        }
        mediaConfigured = true
        val action = pendingRoomAction
        pendingRoomAction = null
        if (action != null) {
            dispatchRoomAction(nextClient, action)
        } else if (connectPending) {
            nextClient.connect()
        }
        connectPending = false
        changed()
    }

    fun createRoom(name: String, displayName: String, guestId: String) {
        selectRoom { it.createRoom(name, displayName, guestId) }
    }
    fun joinRoom(code: String, displayName: String, guestId: String) {
        selectRoom { it.joinRoom(code, displayName, guestId) }
    }
    private fun selectRoom(action: (RoomSoundWebSocketClient) -> Unit) {
        val active = client ?: return
        if (roomSelectionPending || active.currentRoomState() != null) {
            status("Leave the current room before selecting another room.")
            return
        }
        roomSelectionPending = true
        if (!mediaConfigured) {
            pendingRoomAction = action
            changed()
            return
        }
        dispatchRoomAction(active, action)
    }

    private fun dispatchRoomAction(active: RoomSoundWebSocketClient, action: (RoomSoundWebSocketClient) -> Unit) {
        try { action(active) } catch (error: Throwable) {
            roomSelectionPending = false
            disposeRoom()
            val msg = error.message ?: error.javaClass.simpleName
            status("Room request failed before WebSocket send: $msg")
            android.util.Log.e("RoomSound", "selectRoom failed", error)
            changed()
            return
        }
        changed()
    }
    fun connect() {
        if (roomSelectionPending) return
        if (mediaConfigured) client?.connect() else connectPending = true
    }

    fun sendChat(text: String): Boolean {
        if (joinedState() == null || text.isBlank()) return false
        return client?.sendChat(text.trim().take(280)) == true
    }

    fun requestControl(sourceType: String, note: String): Boolean {
        val state = joinedState() ?: return false
        val self = state.self ?: return false
        if (sourceType != DEVICE_AUDIO || isModerator(state) || self.id == state.room.activeSourceId || requestPending ||
            state.requests.any { it.requesterId == self.id && it.status == "PENDING" } ||
            (state.room.activeSourceId != null && state.room.activeSourceId !in setOf(state.room.hostId, state.room.cohostId))
        ) return false
        val sent = client?.requestControl(DEVICE_AUDIO, note) == true
        if (sent) {
            requestPending = true
            val origin = client
            main.postDelayed({ if (client === origin) { requestPending = false; changed() } }, ACK_TIMEOUT_MS)
        }
        changed()
        return sent
    }

    fun cancelRequest(requestId: String): Boolean {
        val state = joinedState() ?: return false
        if (state.requests.none { it.id == requestId && it.requesterId == state.self?.id && it.status == "PENDING" }) return false
        return client?.cancelRequest(requestId) == true
    }

    fun approveRequest(requestId: String): Boolean = decideRequest(requestId, true)
    fun rejectRequest(requestId: String): Boolean = decideRequest(requestId, false)
    private fun decideRequest(requestId: String, approve: Boolean): Boolean {
        val state = joinedState() ?: return false
        val request = state.requests.firstOrNull { it.id == requestId && it.status == "PENDING" } ?: return false
        if (!isModerator(state) || request.requesterId == state.self?.id) return false
        if (approve && state.members.none { it.id == request.requesterId && it.online }) return false
        return if (approve) client?.approveRequest(requestId) == true else client?.rejectRequest(requestId) == true
    }

    fun assignCohost(memberId: String?): Boolean {
        val state = joinedState() ?: return false
        if (state.self?.id != state.room.hostId) return false
        if (memberId != null && state.members.none { it.id == memberId && it.online && it.id != state.self?.id && it.id != state.room.hostId }) return false
        if (memberId == null && state.room.cohostId == null) return false
        return client?.assignCohost(memberId) == true
    }

    fun removeMember(memberId: String): Boolean {
        val state = joinedState() ?: return false
        if (!isModerator(state) || state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) return false
        return client?.removeMember(memberId) == true
    }

    fun endRoom(): Boolean {
        val state = joinedState() ?: return false
        if (state.self?.id != state.room.hostId || endPending) return false
        val sent = client?.endRoom() == true
        if (sent) {
            endPending = true
            notifyRoomSessionStopped()
            abortAttempt("The host is ending the room.", releaseOwnSlot = false)
            changed()
        }
        return sent
    }

    /** Creates a fresh transaction only from the current joined room state. */
    fun beginCapture(): String? {
        if (attempt != null || takeover != null || endPending || !hasMediaBackend()) return null
        val state = joinedState() ?: return null
        val self = state.self ?: return null
        val ownSlot = self.id == state.room.activeSourceId && state.room.activeSourceType == DEVICE_AUDIO &&
            state.room.sourceStatus in setOf("STARTING", "LIVE")
        if (!ownSlot && !(isModerator(state) && state.room.activeSourceId == null)) return null
        val id = UUID.randomUUID().toString()
        attempt = Attempt(
            id = id,
            roomId = state.room.id,
            memberId = self.id,
            baselineEpoch = state.room.sourceEpoch,
            slot = if (ownSlot) Slot(state.room.id, self.id, state.room.sourceEpoch) else null,
        )
        main.postDelayed({
            val pending = attempt
            if (pending?.id == id && pending.phase in setOf(
                    ConsentPhase.AUDIO_PERMISSION, ConsentPhase.SYSTEM_CONSENT, ConsentPhase.SYSTEM_DIALOG_OPEN,
                )
            ) abortAttempt("Capture consent timed out. Tap Share again for new consent.", true)
        }, 120_000L)
        changed()
        return id
    }

    fun prepareProjection(id: String): Boolean {
        val pending = attempt?.takeIf { it.id == id } ?: return false
        if (pending.phase != ConsentPhase.AUDIO_PERMISSION || !canContinue(pending)) return false
        pending.phase = ConsentPhase.SYSTEM_CONSENT
        changed()
        return true
    }

    fun markProjectionDialogOpen(id: String): Boolean {
        val pending = attempt?.takeIf { it.id == id } ?: return false
        if (pending.phase != ConsentPhase.SYSTEM_CONSENT || !canContinue(pending)) return false
        pending.phase = ConsentPhase.SYSTEM_DIALOG_OPEN
        changed()
        return true
    }

    /** Only the service consumes tokens. Duplicate/late Intent delivery is rejected. */
    fun consumeConsent(id: String): Boolean {
        val pending = attempt?.takeIf { it.id == id } ?: return false
        if (pending.phase != ConsentPhase.SYSTEM_DIALOG_OPEN || !canContinue(pending) || !consumedConsents.add(id)) return false
        pending.phase = ConsentPhase.INITIALIZING
        main.postDelayed({
            if (attempt?.id == id && attempt?.phase == ConsentPhase.INITIALIZING) {
                abortAttempt("Playback capture did not return a successful read. Please share again.", true)
            }
        }, ACK_TIMEOUT_MS * 2)
        changed()
        return true
    }

    fun cancelCapture(id: String, message: String) {
        if (attempt?.id == id) abortAttempt(message, true)
    }

    fun stopCapture(message: String = "Device audio sharing stopped.") {
        if (attempt != null) abortAttempt(message, true)
        val pendingTakeover = takeover
        if (pendingTakeover != null) {
            pendingTakeover.canceled = true
            reconcileRoomState()
        } else {
            // Allows an approved STARTING slot to be declined before consent.
            ownSlot(joinedState())?.let(::releaseSlot)
        }
        changed()
    }

    /** Immediate signaling revocation; system consent is a later explicit Share action. */
    fun takeover(): Boolean {
        val state = joinedState() ?: return false
        val selfId = state.self?.id ?: return false
        if (!isModerator(state) || state.room.activeSourceId == null || selfId == state.room.activeSourceId || takeover != null) return false
        abortAttempt("Taking back source control.", releaseOwnSlot = false)
        val pending = Takeover(state.room.id, selfId, state.room.sourceEpoch)
        takeover = pending
        if (client?.takeover(DEVICE_AUDIO) != true) { takeover = null; return false }
        main.postDelayed({
            if (takeover === pending) {
                pending.canceled = true
                status("Takeover has not been confirmed. A delayed STARTING slot will be released; wait for room state.")
                changed()
            }
        }, ACK_TIMEOUT_MS)
        changed()
        return true
    }

    fun setPlaybackVolume(value: Double) {
        volume = value.coerceIn(0.0, 1.0)
        applyPlaybackVolume()
    }

    /** Focus gates the output without changing the user's volume/mute setting. */
    fun setPlaybackAllowed(allowed: Boolean) {
        playbackAllowed = allowed
        applyPlaybackVolume()
    }

    private fun applyPlaybackVolume() {
        val effectiveVolume = if (playbackAllowed) volume else 0.0
        (publisher as? WebRtcPcmPublisher)?.setPlaybackVolume(effectiveVolume)
        relayPlayer?.setVolume(effectiveVolume)
    }

    fun leaveRoom() {
        notifyRoomSessionStopped()
        abortAttempt("Left the room.", true)
        client?.leaveRoom()
        disposeRoom()
        changed()
    }

    /** A capture run gets a fixed sink; only that same run + lease may forward. */
    fun pcmSink(captureId: String): Pcm16Sink = Pcm16Sink { samples, count, rate, channels ->
        val binding = mediaBinding
        if (binding != null && binding.captureId == captureId && binding.client.connectionState() == RoomConnectionState.JOINED) {
            val state = binding.client.currentRoomState()
            if (state != null && matches(binding.slot, state) &&
                state.room.sourceStatus.equals("LIVE", ignoreCase = true)
            ) {
                binding.transport.onFrame(samples, count, rate, channels)
            }
        }
    }

    /** Must be dispatched on the service's main thread, after the native read. */
    fun onCaptureSnapshot(snapshot: CaptureSnapshot): Boolean {
        val pending = attempt?.takeIf { it.id == snapshot.sessionId } ?: return false
        if (snapshot.status in setOf(CaptureStatus.STOPPED, CaptureStatus.ERROR)) {
            abortAttempt(snapshot.message ?: "Android playback capture stopped.", true)
            return true
        }
        if (!canContinue(pending)) {
            abortAttempt("Room source authorization changed during capture.", false)
            return false
        }
        if (snapshot.ready && pending.phase == ConsentPhase.INITIALIZING) {
            val active = client ?: return false
            val state = joinedState() ?: return false
            pending.expectedLiveEpoch = state.room.sourceEpoch + 1
            pending.phase = ConsentPhase.AWAITING_LIVE
            if (!active.startSource(DEVICE_AUDIO, "Android device audio")) {
                abortAttempt("AudioRecord is ready, but start-source could not be sent.", true)
                return false
            }
            main.postDelayed({
                if (attempt === pending && pending.phase == ConsentPhase.AWAITING_LIVE) {
                    // Handles an accepted start whose state arrived at the timeout boundary.
                    adoptExpectedLiveSlot(pending)
                    if (pending.phase == ConsentPhase.AWAITING_LIVE) abortAttempt("Source activation was not confirmed.", true)
                }
            }, ACK_TIMEOUT_MS)
            changed()
        }
        return true
    }

    private fun handleConnection(state: RoomConnectionState) {
        if (state != RoomConnectionState.JOINED) {
            abortAttempt("Room signaling is unavailable. Share again after reconnecting.", false)
            takeover = null
            requestPending = false
        }
        listeners.forEach { it.onConnectionStateChanged(state) }
        changed()
    }

    private fun handleEvent(event: RoomSoundEvent, observedEpoch: Long?) {
        try {
            when (event) {
                is RoomSoundEvent.Joined, is RoomSoundEvent.State -> {
                    roomSelectionPending = false
                    requestPending = false
                    reconcileRoomState()
                }
                is RoomSoundEvent.Error, is RoomSoundEvent.LocalError -> {
                    roomSelectionPending = false
                    requestPending = false
                    if (attempt?.phase == ConsentPhase.AWAITING_LIVE) abortAttempt("The server did not authorize device-audio publication.", true)
                    takeover?.canceled = true
                    reconcileRoomState()
                    if (endPending) endPending = false
                }
                is RoomSoundEvent.Removed, is RoomSoundEvent.RoomEnded -> {
                    notifyRoomSessionStopped()
                    abortAttempt("The room ended or this phone was removed.", false)
                    disposeRoom()
                }
                is RoomSoundEvent.SourceDisconnected, is RoomSoundEvent.Takeover -> {
                    val pending = attempt
                    val currentEpoch = joinedState()?.room?.sourceEpoch
                    if (pending != null && observedEpoch == currentEpoch) reconcileRoomState()
                }
                else -> Unit
            }
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "handleEvent failed for $event", t)
            status("Room event handling hit an error: ${t.message}")
        }
        runCatching { listeners.forEach { it.onEvent(event) } }
        runCatching { changed() }
    }

    private fun reconcileRoomState() {
        val state = joinedState() ?: return
        val pendingTakeover = takeover
        if (pendingTakeover != null) {
            if (state.room.id != pendingTakeover.roomId || state.self?.id != pendingTakeover.memberId) {
                takeover = null
            } else if (state.room.sourceEpoch > pendingTakeover.baselineEpoch) {
                if (state.room.sourceEpoch == pendingTakeover.baselineEpoch + 1 &&
                    state.room.activeSourceId == pendingTakeover.memberId && state.room.sourceStatus == "STARTING" &&
                    state.room.activeSourceType == DEVICE_AUDIO
                ) {
                    if (pendingTakeover.canceled) releaseSlot(Slot(state.room.id, pendingTakeover.memberId, state.room.sourceEpoch))
                    else status("Control taken back. Tap Share device audio and approve Android consent.")
                }
                takeover = null
            }
        }
        val pending = attempt
        if (pending != null) {
            adoptExpectedLiveSlot(pending)
            val stillAuthorized = canContinue(pending)
            if (!stillAuthorized) {
                val pauseExternalPlayback = SourceHandoffPolicy.shouldPauseExternalPlayback(pending.phase, stillAuthorized)
                abortAttempt(
                    "This phone lost its room source slot. Device capture stopped.",
                    releaseOwnSlot = false,
                    pauseExternalPlayback = pauseExternalPlayback,
                )
            }
        } else {
            // The server may resume an old host as LIVE even though native
            // capture was stopped during handoff. Do not present that as audio.
            val own = ownSlot(state)
            if (own != null && state.room.sourceStatus == "LIVE") {
                releaseSlot(own)
                status("The room resumed this phone, but Android capture is stopped. Share again for new consent.")
            }
        }
    }

    private fun canContinue(pending: Attempt): Boolean {
        val state = joinedState() ?: return false
        if (state.room.id != pending.roomId || state.self?.id != pending.memberId || endPending) return false
        if (pending.phase == ConsentPhase.AWAITING_LIVE &&
            state.room.sourceEpoch == pending.expectedLiveEpoch && state.room.activeSourceId == pending.memberId &&
            state.room.activeSourceType == DEVICE_AUDIO && state.room.sourceStatus == "LIVE"
        ) return true
        val slot = pending.slot
        return if (slot != null) matches(slot, state) && state.room.sourceStatus in setOf("STARTING", "LIVE")
        else isModerator(state) && state.room.activeSourceId == null && state.room.sourceEpoch == pending.baselineEpoch
    }

    private fun adoptExpectedLiveSlot(pending: Attempt) {
        if (pending.phase != ConsentPhase.AWAITING_LIVE) return
        val state = joinedState() ?: return
        val expected = pending.expectedLiveEpoch ?: return
        if (state.room.id == pending.roomId && state.self?.id == pending.memberId &&
            state.room.activeSourceId == pending.memberId && state.room.sourceEpoch == expected &&
            state.room.activeSourceType == DEVICE_AUDIO && state.room.sourceStatus == "LIVE"
        ) {
            val slot = Slot(pending.roomId, pending.memberId, expected)
            pending.slot = slot
            pending.phase = ConsentPhase.LIVE
            val active = client
            val audio = transport
            if (active != null && audio != null) mediaBinding = MediaBinding(pending.id, slot, active, audio)
        }
    }

    private fun abortAttempt(
        message: String,
        releaseOwnSlot: Boolean,
        pauseExternalPlayback: Boolean = false,
    ) {
        val pending = attempt ?: return
        if (releaseOwnSlot) adoptExpectedLiveSlot(pending)
        attempt = null
        mediaBinding = null
        if (releaseOwnSlot) pending.slot?.let(::releaseSlot)
        stopLocalCapture(pending.id, message, pauseExternalPlayback)
        status(message)
        changed()
    }

    private fun releaseSlot(slot: Slot) {
        val state = joinedState() ?: return
        // Host/co-host stop-source can stop *any* source. Never use it unless
        // this exact room/member/epoch is still ours at the moment of sending.
        if (!matches(slot, state) || state.room.sourceStatus == "NONE" || slot in releasedSlots) return
        if (client?.stopSource() == true) releasedSlots += slot
    }

    private fun ownSlot(state: RoomState?): Slot? {
        val selfId = state?.self?.id ?: return null
        if (state.room.activeSourceId != selfId || state.room.sourceStatus == "NONE") return null
        return Slot(state.room.id, selfId, state.room.sourceEpoch)
    }

    private fun matches(slot: Slot, state: RoomState): Boolean =
        state.room.id == slot.roomId && state.self?.id == slot.memberId &&
            state.room.activeSourceId == slot.memberId && state.room.sourceEpoch == slot.epoch

    private fun joinedState(): RoomState? {
        val active = client ?: return null
        if (active.connectionState() != RoomConnectionState.JOINED) return null
        return active.currentRoomState()?.takeIf { it.room.status == "ACTIVE" && it.self != null }
    }

    private fun isModerator(state: RoomState): Boolean {
        val selfId = state.self?.id ?: return false
        return selfId == state.room.hostId || selfId == state.room.cohostId
    }

    private fun disposeRoom(notifyStopped: Boolean = true) {
        if (notifyStopped) notifyRoomSessionStopped()
        mediaBinding = null
        clientListener?.let { client?.removeListener(it) }
        clientListener = null
        transport?.close()
        client?.close()
        publisher = null
        relayPlayer = null
        transport = null
        client = null
        endpoint = null
        mediaRelayConfig = RoomMediaRelayConfig.DEFAULT
        mediaConfigured = false
        pendingRoomAction = null
        connectPending = false
        takeover = null
        roomSelectionPending = false
        requestPending = false
        endPending = false
        releasedSlots.clear()
    }

    private fun status(message: String) { listeners.forEach { it.onPublisherStatus(message) } }
    private fun changed() { listeners.forEach { it.onSessionChanged() } }
    private fun notifyRoomSessionStopped() { listeners.forEach { it.onRoomSessionStopped() } }

    override fun close() {
        if (closed) return
        notifyRoomSessionStopped()
        abortAttempt("The room service stopped.", true)
        closed = true
        disposeRoom()
        listeners.clear()
        main.removeCallbacksAndMessages(null)
    }

    companion object {
        const val DEVICE_AUDIO = "ANDROID_DEVICE_AUDIO"
        private const val ACK_TIMEOUT_MS = 8_000L
    }
}
