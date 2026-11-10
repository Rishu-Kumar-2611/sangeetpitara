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
    // Private app storage survives service/process recreation. The capability
    // is separate from the public guest identifier and never enters room state.
    private val reconnectSecret: String by lazy {
        val preferences = appContext.getSharedPreferences("roomsound-room-identity", Context.MODE_PRIVATE)
        preferences.getString("reconnect-secret", null)
            ?.takeIf { Regex("[A-Za-z0-9_-]{32,80}").matches(it) }
            ?: UUID.randomUUID().toString().also {
                check(preferences.edit().putString("reconnect-secret", it).commit()) {
                    "Could not save secure room identity. Please retry."
                }
            }
    }
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<Listener>()
    private val audioDiagnostics = com.roomsound.android.transport.AudioDiagnosticHistory()
    private val diagnosticSampler = object : Runnable {
        override fun run() {
            if (closed) return
            sampleAudioDiagnostics()
            main.postDelayed(this, 1000)
        }
    }
    init { main.post(diagnosticSampler) }
    fun exportAudioDiagnostics(version: String): String {
        sampleAudioDiagnostics()
        return audioDiagnostics.export(version)
    }
    private fun sampleAudioDiagnostics() {
        val room = currentRoomState()
        val snapshot = transportSnapshot()
        val playback = snapshot?.playbackHealth
        val sender = room?.self?.id != null && room.room.activeSourceId == room.self?.id
        audioDiagnostics.record(mapOf(
            "epoch" to room?.room?.sourceEpoch,
            "acceptedCaptureFrames" to snapshot?.acceptedFrames,
            "rejectedCaptureFrames" to snapshot?.let { it.droppedUnauthorizedFrames + it.droppedNotLiveFrames + it.droppedStaleEpochFrames + it.droppedUnavailableFrames },
            "receivedPackets" to snapshot?.receivedRelayFrames,
            "underruns" to if (sender) null else playback?.underruns,
            "bufferMs" to if (sender) null else playback?.bufferMs,
            "targetMs" to if (sender) null else playback?.targetMs,
            "packetAgeMs" to if (sender) null else playback?.packetAgeMs,
            "jitterMs" to if (sender) null else playback?.jitterMs,
            "missingPackets" to if (sender) null else playback?.missingPackets,
            "rms" to if (sender) null else playback?.levelRms,
            "peak" to if (sender) null else playback?.levelPeak,
            "appVolume" to effectivePlaybackVolume(),
            "playbackAllowed" to if (playbackAllowed) 1 else 0,
            "listeningPaused" to if (listeningPaused) 1 else 0,
            "mediaVolumePercent" to mediaVolumePercent(),
        ), if (room?.room?.activeSourceId == null) "idle" else if (sender) "sender" else "listener",
            if (connectionState() == RoomConnectionState.JOINED) "connected" else "offline",
            when (playback?.running) { true -> "running"; false -> "suspended"; null -> "unavailable" },
            if (pairedHttpClient != null || nearbyHost != null) "nearby" else "internet")
    }

    private var nearbyHost: com.roomsound.android.nearby.NearbyRoomHost? = null
    @Volatile private var nearbyIdentity: com.roomsound.android.nearby.NearbyTlsIdentity? = null
    /** Key generation may take seconds on older hardware; call on a worker. */
    fun prepareNearbyIdentity() = synchronized(this) {
        nearbyIdentity ?: com.roomsound.android.nearby.NearbyTlsIdentity().also { nearbyIdentity = it }
    }
    fun startNearbyHost(): String {
        check(canSelectRoom()) { "Leave the current room first." }
        nearbyHost?.close()
        val identity = prepareNearbyIdentity()
        val host = com.roomsound.android.nearby.NearbyRoomHost({ appContext.assets.open("nearby/index.html") }, tlsFactory = identity.factory, certificatePem = identity.certificatePem).also { it.startHosting(); nearbyHost = it }
        return host.ownerEndpoint
    }
    fun nearbyInvites(): List<String> {
        val host = nearbyHost ?: return emptyList()
        if (endpoint != RoomEndpointValidator.normalize(host.ownerEndpoint)) return emptyList()
        val code = currentRoomState()?.room?.code ?: return emptyList()
        return java.net.NetworkInterface.getNetworkInterfaces().toList()
            .filter { com.roomsound.android.nearby.NearbyInviteAddressPolicy.usable(it.name) }
            .sortedBy { com.roomsound.android.nearby.NearbyInviteAddressPolicy.priority(it.name) }
            .flatMap { it.inetAddresses.toList() }
            .filter { it is java.net.Inet4Address && it.isSiteLocalAddress && !it.isLoopbackAddress }
            .map { "http://${it.hostAddress}:${host.listeningPort}/#invite=${host.invite}&code=$code&tls=${host.securePort}&pin=${nearbyIdentity!!.fingerprint}" }
    }
    private var endpoint: String? = null
    private var client: RoomSoundWebSocketClient? = null
    private var pairedHttpClient: okhttp3.OkHttpClient? = null
    private var clientListener: RoomSoundWebSocketClient.Listener? = null
    private var publisher: Pcm16FramePublisher? = null
    private var relayPlayer: Pcm16RelayPlayer? = null
    private var transport: RoomAudioTransport? = null
    private var mediaRelayConfig = RoomMediaRelayConfig.DEFAULT
    private var voiceMessages = false
    private var messageReplies = false
    private var chatReactions: List<String> = emptyList()
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
    private var listeningPaused = false
    // A chat voice message is playing on this phone: the room music pauses until it ends.
    private var voiceNotePlaying = false
    private var voiceNoteRecording = false
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

    /** Empty until /config arrives, and on servers that do not support reactions. */
    fun supportsVoiceMessages(): Boolean = voiceMessages
    fun supportsMessageReplies(): Boolean = messageReplies
    fun currentChatReactions(): List<String> = chatReactions
    fun pendingCapture(): PendingCapture? = attempt?.let { PendingCapture(it.id, it.phase) }
    fun isTakeoverPending(): Boolean = takeover != null
    fun isRoomSelectionPending(): Boolean = roomSelectionPending
    fun canSelectRoom(): Boolean = !closed && !roomSelectionPending && joinedState() == null
    fun playbackVolume(): Double = volume
    fun hasMediaBackend(): Boolean = transport?.hasMediaBackend() == true
    fun transportSnapshot(): RoomAudioTransportSnapshot? = transport?.snapshot()

    fun joinNearby(rawInvite: String, displayName: String, guestId: String): Boolean {
        if (!canSelectRoom()) return false
        val pairing = com.roomsound.android.nearby.NearbyPairing.parse(rawInvite)
        if (!configureEndpoint(pairing.endpoint, pairing.client(), pairing.reconnectSecret(reconnectSecret))) return false
        joinRoom(pairing.code, displayName, guestId)
        return true
    }

    fun configureEndpoint(rawEndpoint: String, localClient: okhttp3.OkHttpClient? = null, localReconnectSecret: String? = null): Boolean {
        if (closed) return false
        val next = RoomEndpointValidator.normalize(rawEndpoint) ?: return false
        if (endpoint == next && client != null && localClient == null) return true
        if (client?.currentRoomState() != null || roomSelectionPending || attempt != null) {
            status("Leave the current room before changing its endpoint.")
            return false
        }
        disposeRoom(notifyStopped = false)
        pairedHttpClient = localClient
        val nextClient = if(localClient == null) RoomSoundWebSocketClient(next, reconnectSecret = reconnectSecret)
            else RoomSoundWebSocketClient(next, okHttpClient = localClient, reconnectSecret = requireNotNull(localReconnectSecret))
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
            chatReactions = fetchedConfig.chatReactions
            voiceMessages = fetchedConfig.voiceMessages
            messageReplies = fetchedConfig.messageReplies
            val relayEnabled = fetchedConfig.mediaRelay.enabled
            if (relayEnabled) {
                require(fetchedConfig.mediaRelay.isPcm16Enabled) {
                    "Unsupported relay config: ${fetchedConfig.mediaRelay.mode}/" +
                        "${fetchedConfig.mediaRelay.sampleRate} Hz/${fetchedConfig.mediaRelay.channels} ch."
                }
                nextRelayPlayer = Pcm16RelayPlayer(
                    maxQueuedFrames = Pcm16RelayPlayer.PRODUCTION_MAX_QUEUED_FRAMES,
                    maxQueuedBytes = Pcm16RelayPlayer.PRODUCTION_MAX_QUEUED_BYTES,
                    catchUpQueuedBytes = Pcm16RelayPlayer.PRODUCTION_CATCH_UP_QUEUED_BYTES,
                    catchUpLandingBytes = Pcm16RelayPlayer.PRODUCTION_CATCH_UP_LANDING_BYTES,
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
            val effectiveVolume = effectivePlaybackVolume()
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
        if (roomSelectionPending || joinedState() != null) {
            status("Leave the current room before selecting another room.")
            return
        }
        if (active.connectionState() != RoomConnectionState.IDLE && active.connectionState() != RoomConnectionState.CLOSED) {
            active.disconnect()
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

    fun sendChat(text: String, replyToId: String? = null, voice: com.roomsound.android.room.RoomVoiceNote? = null, clientMessageId: String? = null): Boolean {
        if (joinedState() == null || (text.isBlank() && voice == null) || (voice != null && !voiceMessages) || (replyToId != null && !messageReplies)) return false
        return client?.sendChat(text.trim().take(280), replyToId, voice, clientMessageId) == true
    }

    fun sendReaction(messageId: String, emoji: String): Boolean {
        if (joinedState() == null || emoji !in chatReactions) return false
        return client?.sendReaction(messageId, emoji) == true
    }

    fun requestControl(sourceType: String, note: String): Boolean {
        val state = joinedState() ?: return false
        val self = state.self ?: return false
        if (sourceType != DEVICE_AUDIO || isModerator(state) || self.id == state.room.activeSourceId || requestPending ||
            state.requests.any { it.requesterId == self.id && it.status == "PENDING" }
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

    fun grantSource(memberId: String): Boolean {
        val state = joinedState() ?: return false
        if (!isModerator(state) || state.members.none { it.id == memberId && it.online && it.id != state.self?.id }) return false
        return client?.grantSource(memberId, DEVICE_AUDIO) == true
    }

    fun assignCohost(memberId: String?): Boolean {
        val state = joinedState() ?: return false
        if (state.self?.id != state.room.hostId) return false
        if (memberId != null && state.members.none { it.id == memberId && it.online && it.id != state.self?.id && it.id != state.room.hostId }) return false
        if (memberId == null && state.room.cohostId == null) return false
        return client?.assignCohost(memberId) == true
    }

    fun removeMember(memberId: String, ban: Boolean = false): Boolean {
        val state = joinedState() ?: return false
        if (!isModerator(state) || state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) return false
        return client?.removeMember(memberId, ban) == true
    }

    fun setRoomLock(locked: Boolean): Boolean {
        val state = joinedState() ?: return false
        if (!isModerator(state) || state.room.locked == locked) return false
        return client?.setRoomLock(locked) == true
    }

    fun rotateRoomCode(): Boolean {
        val state = joinedState() ?: return false
        if (!isModerator(state)) return false
        return client?.rotateRoomCode() == true
    }

    fun endRoom(): Boolean {
        val state = joinedState() ?: client?.currentRoomState()
        if (state != null && state.self?.id != state.room.hostId) return false
        if (endPending) return false
        val sent = client?.endRoom() == true
        endPending = true
        notifyRoomSessionStopped()
        abortAttempt("The host is ending the room.", releaseOwnSlot = false)
        if (!sent) {
            disposeRoom(notifyStopped = false)
        } else {
            val activeClient = client
            main.postDelayed({
                if (endPending && client === activeClient) {
                    disposeRoom(notifyStopped = false)
                    changed()
                }
            }, 1_200L)
        }
        changed()
        return true
    }

    /** Creates a fresh transaction only from the current joined room state. */
    fun beginCapture(): String? {
        if (attempt != null || takeover != null || endPending || !hasMediaBackend()) return null
        val state = joinedState() ?: return null
        val self = state.self ?: return null
        val ownSlot = DeviceCaptureGrantPolicy.ownsSlot(self.id,state.room.activeSourceId,state.room.activeSourceType,state.room.sourceStatus)
        if (!ownSlot && !isModerator(state)) return null
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

    fun isListeningPaused(): Boolean = listeningPaused

    /** True when the room may play on this phone (audio focus held, not paused by the user or a call). */
    fun isPlaybackAllowed(): Boolean = playbackAllowed

    /** The phone's own media volume as 0..100, or null if Android does not report it. */
    fun mediaVolumePercent(): Int? = runCatching {
        val audio = appContext.getSystemService(android.media.AudioManager::class.java) ?: return null
        val max = audio.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC)
        if (max <= 0) null else audio.getStreamVolume(android.media.AudioManager.STREAM_MUSIC) * 100 / max
    }.getOrNull()

    /**
     * Pause or resume room audio on this device only. The room keeps playing
     * for everyone else; resuming jumps back to the live stream.
     */
    fun setListeningPaused(paused: Boolean): Boolean {
        val state = joinedState() ?: return false
        if (paused && state.self?.id == state.room.activeSourceId) return false
        if (listeningPaused == paused) return true
        val wasSuspended = isListeningSuspended()
        listeningPaused = paused
        applyPlaybackVolume()
        updateListeningSuspension(wasSuspended)
        changed()
        return true
    }

    fun setVoiceNotePlaying(playing: Boolean) {
        if (voiceNotePlaying == playing) return
        voiceNotePlaying = playing
        applyPlaybackVolume()
    }

    fun setVoiceNoteRecording(recording: Boolean) {
        if (voiceNoteRecording == recording) return
        val wasSuspended = isListeningSuspended()
        voiceNoteRecording = recording
        applyPlaybackVolume()
        updateListeningSuspension(wasSuspended)
    }

    private fun isListeningSuspended(): Boolean = listeningPaused || voiceNoteRecording

    private fun updateListeningSuspension(wasSuspended: Boolean) {
        val suspended = isListeningSuspended()
        if (suspended == wasSuspended) return
        client?.setListeningPaused(suspended)
        transport?.restartRelayPlayback()
    }

    private fun effectivePlaybackVolume(): Double =
        if (playbackAllowed && !isListeningSuspended() && !voiceNotePlaying) volume else 0.0

    private fun applyPlaybackVolume() {
        val effectiveVolume = effectivePlaybackVolume()
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
        // Capture status updates continue while Wi-Fi/mobile is reconnecting.
        // Keep the Android consent session, but mediaBinding stays revoked until
        // a fresh authorized room state arrives. Stop/error above still wins.
        if (joinedState() == null && !closed && !endPending && client != null) return true
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
            awaitLiveConfirmation(pending)
            changed()
        }
        return true
    }

    private fun awaitLiveConfirmation(pending: Attempt) {
        main.postDelayed({
            if (attempt === pending && pending.phase == ConsentPhase.AWAITING_LIVE) {
                if (joinedState() == null) awaitLiveConfirmation(pending)
                else {
                    adoptExpectedLiveSlot(pending)
                    if (pending.phase == ConsentPhase.AWAITING_LIVE) abortAttempt("Source activation was not confirmed.", true)
                }
            }
        }, ACK_TIMEOUT_MS)
    }

    private fun handleConnection(state: RoomConnectionState) {
        if (state != RoomConnectionState.JOINED) {
            val keepLiveCaptureAcrossReconnect = !closed && !endPending && client != null &&
                attempt?.phase in setOf(
                    ConsentPhase.INITIALIZING,
                    ConsentPhase.AWAITING_LIVE,
                    ConsentPhase.LIVE,
                )
            if (!keepLiveCaptureAcrossReconnect) {
                abortAttempt("Room signaling is unavailable. Share again after reconnecting.", false)
            }
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
            android.util.Log.e("RoomSound", "Room event failed: ${event.javaClass.simpleName} (${t.javaClass.simpleName})")
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
            if (pending.phase in setOf(ConsentPhase.LIVE, ConsentPhase.AWAITING_LIVE) && state.room.id == pending.roomId && state.self?.id == pending.memberId) {
                val active = client
                val audio = transport
                if (state.room.activeSourceId == pending.memberId && state.room.sourceStatus == "LIVE") {
                    val slot = Slot(state.room.id, pending.memberId, state.room.sourceEpoch)
                    pending.slot = slot
                    if (active != null && audio != null) mediaBinding = MediaBinding(pending.id, slot, active, audio)
                } else if (state.room.activeSourceId == null && state.room.sourceStatus == "NONE" && active != null) {
                    pending.expectedLiveEpoch = state.room.sourceEpoch + 1
                    pending.phase = ConsentPhase.AWAITING_LIVE
                    if (active.startSource(DEVICE_AUDIO, "Android device audio")) awaitLiveConfirmation(pending)
                }
            }
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
        if (pending.phase == ConsentPhase.AWAITING_LIVE && state.room.activeSourceId == null &&
            state.room.sourceStatus == "NONE" && pending.expectedLiveEpoch == state.room.sourceEpoch + 1
        ) return true // Await server authorization; media remains disabled until LIVE.
        val slot = pending.slot
        return if (slot != null) matches(slot, state) && state.room.sourceStatus in setOf("STARTING", "LIVE")
        else isModerator(state) && (state.room.activeSourceId == null || state.room.sourceEpoch == pending.baselineEpoch)
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
        pairedHttpClient?.let { it.connectionPool.evictAll(); it.dispatcher.executorService.shutdown() }
        pairedHttpClient = null
        publisher = null
        relayPlayer = null
        transport = null
        client = null
        endpoint = null
        listeningPaused = false
        mediaRelayConfig = RoomMediaRelayConfig.DEFAULT
        chatReactions = emptyList()
        voiceMessages = false
        messageReplies = false
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
        nearbyHost?.close()
        nearbyHost = null
        disposeRoom()
        listeners.clear()
        main.removeCallbacksAndMessages(null)
    }

    companion object {
        const val DEVICE_AUDIO = "ANDROID_DEVICE_AUDIO"
        private const val ACK_TIMEOUT_MS = 8_000L
    }
}
