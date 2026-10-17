package com.roomsound.android.transport

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomSoundWebSocketClient
import com.roomsound.android.room.RoomState
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.audio.AudioProcessingOptions
import org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Native WebRTC media backend for Android playback PCM.
 *
 * The ADM is deliberately recordingless: Android playback PCM is copied into
 * each ADM input callback, so the microphone is never opened and no
 * AudioManager mode or audio focus is changed. The same ADM owns native
 * AudioTrack playout for receive-only peers.
 */
public class WebRtcPcmPublisher(
    context: Context,
    private val roomClient: RoomSoundWebSocketClient,
    private val onStatus: (String) -> Unit = {},
) : Pcm16FramePublisher {
    private enum class PeerRole {
        SENDER,
        RECEIVER,
    }

    private class PeerSession(
        val memberId: String,
        val role: PeerRole,
        val sourceEpoch: Long,
        val token: Long,
    ) {
        var peerConnection: PeerConnection? = null
        var remoteDescriptionSet = false
        var localDescriptionSet = false
        var closed = false
        val pendingRemoteCandidates = ArrayDeque<IceCandidate>()
        val pendingLocalCandidates = ArrayDeque<IceCandidate>()
        val remoteAudioTracks = mutableListOf<AudioTrack>()
    }

    private val applicationContext = context.applicationContext
    private val stateLock = Any()
    private val pcmQueue = Pcm16FrameQueue()
    private val signalingExecutor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "RoomSound-WebRTC-Signaling").apply { isDaemon = true }
    }

    private var closed = false
    private var latestRoomState: RoomState? = null
    private var sourceStarted = false
    private var activeSourceEpoch: Long? = null
    private var backendReady = false
    private var backendError: String? = null
    private var iceServersLoaded = false
    private var iceServers: List<PeerConnection.IceServer> = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
    )
    private var peerToken = 0L
    private var playbackVolume = 1.0

    private var audioDeviceModule: JavaAudioDeviceModule? = null
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var audioSource: AudioSource? = null
    private var audioTrack: AudioTrack? = null
    private val peers = mutableMapOf<String, PeerSession>()

    private val roomListener = object : RoomSoundWebSocketClient.Listener {
        override fun onConnectionStateChanged(state: RoomConnectionState) {
            if (state == RoomConnectionState.JOINED) {
                roomClient.currentRoomState()?.let(::acceptRoomState)
                postToSignaling { reconcilePeers() }
                return
            }

            synchronized(stateLock) {
                if (closed) return
                latestRoomState = null
                sourceStarted = false
                activeSourceEpoch = null
                pcmQueue.revoke()
            }
            postToSignaling { disposeAllPeers() }
        }

        override fun onEvent(event: RoomSoundEvent) {
            when (event) {
                is RoomSoundEvent.Joined -> acceptRoomState(event.state)
                is RoomSoundEvent.State -> acceptRoomState(event.state)
                is RoomSoundEvent.Rtc -> postToSignaling { handleRtc(event) }
                is RoomSoundEvent.SourceDisconnected -> {
                    val shouldDispose = synchronized(stateLock) {
                        val activeId = latestRoomState?.room?.activeSourceId
                        event.memberId == null || event.memberId == activeId
                    }
                    if (shouldDispose) {
                        synchronized(stateLock) {
                            if (!closed) {
                                sourceStarted = false
                                activeSourceEpoch = null
                                pcmQueue.revoke()
                            }
                        }
                        postToSignaling { disposeAllPeers() }
                    }
                }
                is RoomSoundEvent.Removed,
                is RoomSoundEvent.RoomEnded,
                -> {
                    synchronized(stateLock) {
                        if (!closed) {
                            latestRoomState = null
                            sourceStarted = false
                            activeSourceEpoch = null
                            pcmQueue.revoke()
                        }
                    }
                    postToSignaling { disposeAllPeers() }
                }
                else -> Unit
            }
        }
    }

    init {
        latestRoomState = roomClient.currentRoomState()
        roomClient.addListener(roomListener)
        initializeMediaBackend()
        roomClient.currentRoomState()?.let(::acceptRoomState)
    }

    /**
     * Sets the local playout gain for every native remote audio track. This is
     * deliberately per-track and does not change the phone's global volume.
     */
    public fun setPlaybackVolume(volume: Double) {
        if (!volume.isFinite() || volume !in 0.0..1.0) {
            android.util.Log.e("RoomSound", "setPlaybackVolume rejected invalid volume: "+volume.toString())
            return
        }
        synchronized(stateLock) {
            if (closed) return
            playbackVolume = volume
        }
        postToSignaling {
            peers.values.forEach { session ->
                session.remoteAudioTracks.toList().forEach { track ->
                    runCatching { track.setVolume(volume) }
                }
            }
        }
    }

    /**
     * Diagnostic counters describe PCM enqueued/injected into WebRTC. They do
     * not claim that queued samples were confirmed delivered over the network.
     */
    override fun diagnostics(): String {
        val (started, epoch, ready, error, roomEpoch) = synchronized(stateLock) {
            Tuple5(
                sourceStarted,
                activeSourceEpoch,
                backendReady,
                backendError,
                latestRoomState?.room?.sourceEpoch,
            )
        }
        return buildString {
            append("backend=")
            append(if (ready) "ready" else "unavailable")
            if (error != null) append(" error=").append(error)
            append(" sourceStarted=").append(started)
            append(" activeEpoch=").append(epoch ?: "none")
            append(" roomEpoch=").append(roomEpoch ?: "none")
            append(" queuedSamples=").append(pcmQueue.queuedSamples())
            append(" enqueuedSamples=").append(pcmQueue.enqueuedSamples())
            append(" injectedSamples=").append(pcmQueue.drainedSamples())
            append(" droppedSamples=").append(pcmQueue.droppedSamples())
            append(" underrunSamples=").append(pcmQueue.underrunSamples())
            append(" admCallbacks=").append(pcmQueue.callbackCount())
            append(" peers=").append(peers.size)
        }
    }

    override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean {
        if (format != Pcm16AudioFormat(CAPTURE_SAMPLE_RATE, CAPTURE_CHANNELS)) {
            reportStatus("WebRTC publisher rejected format ${format.sampleRate} Hz/${format.channels} ch.")
            return false
        }

        val state = roomClient.currentRoomState()
        val authorized = state?.let {
            it.room.sourceEpoch == sourceEpoch && it.sourceAuthorization().canPublishFrames
        } == true
        val previousEpoch: Long?
        synchronized(stateLock) {
            if (closed || !backendReady || !authorized) return false
            if (sourceStarted && activeSourceEpoch == sourceEpoch) return true
            previousEpoch = activeSourceEpoch
            sourceStarted = true
            activeSourceEpoch = sourceEpoch
            pcmQueue.bind(sourceEpoch)
        }

        if (previousEpoch != null && previousEpoch != sourceEpoch) {
            postToSignaling { disposePeersForEpoch(previousEpoch) }
        }
        postToSignaling { reconcilePeers() }
        reportStatus("Native WebRTC PCM source bound to epoch $sourceEpoch.")
        return true
    }

    override fun isAvailable(): Boolean = synchronized(stateLock) { !closed && backendReady }

    override fun publish(frame: Pcm16Frame): Pcm16PublishResult {
        return try {
            synchronized(stateLock) {
                if (closed || !sourceStarted || activeSourceEpoch == null) {
                    return Pcm16PublishResult.DROPPED_UNAUTHORIZED
                }
                if (activeSourceEpoch != frame.sourceEpoch) {
                    return Pcm16PublishResult.DROPPED_STALE_EPOCH
                }
                pcmQueue.offer(frame)
            }
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "WebRtc publish failed", t)
            Pcm16PublishResult.BACKEND_UNAVAILABLE
        }
    }

    override fun stop(sourceEpoch: Long) {
        val stopped: Boolean
        synchronized(stateLock) {
            if (activeSourceEpoch != sourceEpoch) return
            sourceStarted = false
            activeSourceEpoch = null
            pcmQueue.revoke(sourceEpoch)
            stopped = true
        }
        if (stopped) {
            postToSignaling { disposePeersForEpoch(sourceEpoch) }
            reportStatus("Native WebRTC PCM source revoked for epoch $sourceEpoch.")
        }
    }

    override fun close() {
        synchronized(stateLock) {
            if (closed) return
            closed = true
            sourceStarted = false
            activeSourceEpoch = null
            latestRoomState = null
            pcmQueue.revoke()
        }
        roomClient.removeListener(roomListener)
        runCatching {
            signalingExecutor.execute {
                disposeAllPeers()
                releaseMediaBackend()
            }
        }
        signalingExecutor.shutdown()
    }

    private fun initializeMediaBackend() {
        var createdAdm: JavaAudioDeviceModule? = null
        var createdFactory: PeerConnectionFactory? = null
        var createdSource: AudioSource? = null
        var createdTrack: AudioTrack? = null
        try {
            initializeWebRtcOnce(applicationContext)
            createdAdm = JavaAudioDeviceModule.builder(applicationContext)
                .setSampleRate(CAPTURE_SAMPLE_RATE)
                .setUseStereoInput(false)
                .setUseStereoOutput(false)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                // Prefer the broadly supported AudioTrack path while bringing
                // up custom PCM injection. Low-latency mode is device-specific
                // and can fail without a useful Java exception.
                .setUseLowLatency(false)
                .setEnableVolumeLogger(false)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build(),
                )
                .setAudioTrackErrorCallback(object : JavaAudioDeviceModule.AudioTrackErrorCallback {
                    override fun onWebRtcAudioTrackInitError(error: String) {
                        reportStatus("Native audio output init failed: $error")
                    }

                    override fun onWebRtcAudioTrackStartError(
                        errorCode: JavaAudioDeviceModule.AudioTrackStartErrorCode,
                        errorMessage: String,
                    ) {
                        reportStatus("Native audio output start failed ($errorCode): $errorMessage")
                    }

                    override fun onWebRtcAudioTrackError(error: String) {
                        reportStatus("Native audio output failed: $error")
                    }
                })
                .setAudioTrackStateCallback(object : JavaAudioDeviceModule.AudioTrackStateCallback {
                    override fun onWebRtcAudioTrackStart() {
                        reportStatus("Native audio output started.")
                    }

                    override fun onWebRtcAudioTrackStop() {
                        reportStatus("Native audio output stopped.")
                    }
                })
                .setAudioRecordErrorCallback(object : JavaAudioDeviceModule.AudioRecordErrorCallback {
                    override fun onWebRtcAudioRecordInitError(error: String) {
                        reportStatus("Unexpected native recording init: $error")
                    }

                    override fun onWebRtcAudioRecordStartError(
                        errorCode: JavaAudioDeviceModule.AudioRecordStartErrorCode,
                        errorMessage: String,
                    ) {
                        reportStatus("Unexpected native recording start ($errorCode): $errorMessage")
                    }

                    override fun onWebRtcAudioRecordError(error: String) {
                        reportStatus("Unexpected native recording error: $error")
                    }
                })
                .setAudioBufferCallback(JavaAudioDeviceModule.AudioBufferCallback { buffer, _, _, _, _, timestampNs ->
                    try {
                        pcmQueue.fillAudioBuffer(buffer)
                    } catch (t: Throwable) {
                        android.util.Log.e("RoomSound", "ADM fillAudioBuffer failed", t)
                        try { buffer.clear(); while (buffer.hasRemaining()) buffer.put(0); buffer.clear() } catch (_: Throwable) {}
                    }
                    // The fork forwards this value as native capture timing;
                    // zero is not a documented "timestamp unavailable" value.
                    if (timestampNs > 0L) timestampNs else System.nanoTime()
                })
                .createAudioDeviceModule()

            // This must happen before the ADM is handed to the native factory.
            // It selects WebRtcAudioRecord's recordingless callback path and
            // prevents Android microphone initialization entirely.
            createdAdm.setAudioRecordEnabled(false)

            createdFactory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(createdAdm)
                .createPeerConnectionFactory()
            val rawConstraints = MediaConstraints()
            createdSource = createdFactory.createAudioSource(rawConstraints)
            createdTrack = createdFactory.createAudioTrack("roomsound-playback", createdSource)
            runCatching { createdTrack.setAudioProcessingOptions(AudioProcessingOptions.raw()) }

            synchronized(stateLock) {
                if (closed) return
                audioDeviceModule = createdAdm
                peerConnectionFactory = createdFactory
                audioSource = createdSource
                audioTrack = createdTrack
                backendReady = true
                backendError = null
            }
            // Ownership moved to this instance.
            createdAdm = null
            createdFactory = null
            createdSource = null
            createdTrack = null
            reportStatus("Native WebRTC media backend ready (recordingless ADM, Opus factory).")
        } catch (error: Throwable) {
            val message = error.message ?: error.javaClass.simpleName
            synchronized(stateLock) {
                backendReady = false
                backendError = message
            }
            runCatching { createdTrack?.dispose() }
            runCatching { createdSource?.dispose() }
            runCatching { createdFactory?.dispose() }
            runCatching { createdAdm?.release() }
            reportStatus("Native WebRTC media backend unavailable: $message")
        }
    }

    private fun releaseMediaBackend() {
        val track: AudioTrack?
        val source: AudioSource?
        val factory: PeerConnectionFactory?
        val adm: JavaAudioDeviceModule?
        synchronized(stateLock) {
            track = audioTrack
            source = audioSource
            factory = peerConnectionFactory
            adm = audioDeviceModule
            audioTrack = null
            audioSource = null
            peerConnectionFactory = null
            audioDeviceModule = null
            backendReady = false
        }
        runCatching { track?.dispose() }
        runCatching { source?.dispose() }
        runCatching { factory?.dispose() }
        runCatching { adm?.release() }
    }

    private fun acceptRoomState(state: RoomState) {
        var revokedEpoch: Long? = null
        synchronized(stateLock) {
            if (closed) return
            val previous = latestRoomState
            if (previous != null && previous.room.id == state.room.id &&
                state.room.sourceEpoch < previous.room.sourceEpoch
            ) {
                return
            }
            latestRoomState = state
            val epoch = activeSourceEpoch
            val authorization = state.sourceAuthorization()
            if (sourceStarted && epoch != null &&
                (state.room.sourceEpoch != epoch || !authorization.canPublishFrames)
            ) {
                sourceStarted = false
                activeSourceEpoch = null
                pcmQueue.revoke(epoch)
                revokedEpoch = epoch
            }
        }
        if (revokedEpoch != null) {
            reportStatus("Room state revoked native PCM epoch $revokedEpoch.")
        }
        postToSignaling { reconcilePeers() }
    }

    private fun reconcilePeers() {
        val state = synchronized(stateLock) { latestRoomState } ?: run {
            disposeAllPeers()
            return
        }
        val factoryAvailable = synchronized(stateLock) { backendReady && peerConnectionFactory != null }
        if (!factoryAvailable) return
        loadIceServersIfNeeded()

        val authorization = state.sourceAuthorization()
        val epoch = state.room.sourceEpoch
        val shouldSend = synchronized(stateLock) {
            sourceStarted && activeSourceEpoch == epoch && authorization.canPublishFrames
        }
        val desiredSenderIds = if (shouldSend) {
            state.members.asSequence()
                .filter { it.online && it.id != state.self?.id }
                .map { it.id }
                .toSet()
        } else {
            emptySet()
        }

        peers.values.toList().forEach { session ->
            val keep = when (session.role) {
                PeerRole.SENDER -> shouldSend && session.sourceEpoch == epoch &&
                    session.memberId in desiredSenderIds
                PeerRole.RECEIVER -> !authorization.isSelfActiveSource &&
                    state.room.activeSourceId == session.memberId &&
                    session.sourceEpoch == epoch && !state.room.sourceStatus.equals("NONE", true)
            }
            if (!keep) disposePeer(session)
        }

        if (shouldSend) {
            desiredSenderIds.forEach { memberId ->
                if (peers[memberId] == null) createSenderPeer(memberId, epoch)
            }
        }
    }

    private fun handleRtc(event: RoomSoundEvent.Rtc) {
        val from = event.from?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val state = synchronized(stateLock) { latestRoomState } ?: return
        if (event.sourceEpoch != null && event.sourceEpoch != state.room.sourceEpoch) return

        val signalType = event.signal.optString("type", "").lowercase(Locale.US)
        when (signalType) {
            "offer" -> handleOffer(from, event.signal.objectOrEmpty("description"), state)
            "answer" -> handleAnswer(from, event.signal.objectOrEmpty("description"), state)
            "candidate" -> handleCandidate(from, event.signal.objectOrEmpty("candidate"), state)
        }
    }

    private fun handleOffer(from: String, descriptionJson: JSONObject, state: RoomState) {
        // An Android listener accepts offers only from the server-authorized
        // active source. In particular, a random room member cannot make the
        // native phone open a receive path.
        if (state.sourceAuthorization().isSelfActiveSource) return
        if (state.room.activeSourceId != from || state.room.sourceStatus.equals("NONE", true)) return
        val description = parseDescription(descriptionJson, SessionDescription.Type.OFFER) ?: return
        val epoch = state.room.sourceEpoch
        val existing = peers[from]
        if (existing != null) {
            // ICE candidates can arrive before the browser's offer. Reuse the
            // receiver that queued them; disposing it here would silently
            // discard the only candidates that can make the peer connect.
            if (existing.role == PeerRole.RECEIVER && !existing.remoteDescriptionSet && existing.sourceEpoch == epoch) {
                setRemoteDescriptionAndMaybeAnswer(existing, description)
                return
            }
            // One offer is expected per source/listener epoch. Do not let a
            // delayed duplicate replace a live peer and revive stale media.
            if (existing.role == PeerRole.RECEIVER && existing.remoteDescriptionSet) return
            disposePeer(existing)
        }
        val session = createReceiverPeer(from, epoch) ?: return
        setRemoteDescriptionAndMaybeAnswer(session, description)
    }

    private fun handleAnswer(from: String, descriptionJson: JSONObject, state: RoomState) {
        val session = peers[from] ?: return
        if (session.role != PeerRole.SENDER || session.sourceEpoch != state.room.sourceEpoch) return
        if (session.remoteDescriptionSet) return
        val description = parseDescription(descriptionJson, SessionDescription.Type.ANSWER) ?: return
        setRemoteDescriptionAndMaybeAnswer(session, description)
    }

    private fun handleCandidate(from: String, candidateJson: JSONObject, state: RoomState) {
        if (state.room.sourceStatus.equals("NONE", true)) return
        var session = peers[from]
        if (session == null && !state.sourceAuthorization().isSelfActiveSource &&
            state.room.activeSourceId == from
        ) {
            session = createReceiverPeer(from, state.room.sourceEpoch)
        }
        session ?: return
        if (session.sourceEpoch != state.room.sourceEpoch) return
        val candidate = parseCandidate(candidateJson) ?: return
        if (!session.remoteDescriptionSet) {
            if (session.pendingRemoteCandidates.size >= MAX_PENDING_ICE_CANDIDATES) {
                session.pendingRemoteCandidates.removeFirst()
            }
            session.pendingRemoteCandidates.addLast(candidate)
            return
        }
        runCatching { session.peerConnection?.addIceCandidate(candidate) }
    }

    private fun createSenderPeer(memberId: String, sourceEpoch: Long): PeerSession? {
        val factory = peerConnectionFactory ?: return null
        val sourceTrack = audioTrack ?: return null
        val session = PeerSession(memberId, PeerRole.SENDER, sourceEpoch, ++peerToken)
        peers[memberId] = session
        val observer = PeerObserver(session)
        val connection = runCatching {
            factory.createPeerConnection(rtcConfiguration(sourceEpoch), observer)
        }.getOrNull()
        if (connection == null) {
            peers.remove(memberId)
            reportStatus("Could not create native sender peer for $memberId.")
            return null
        }
        session.peerConnection = connection
        try {
            val transceiver = connection.addTransceiver(
                sourceTrack,
                RtpTransceiver.RtpTransceiverInit(
                    RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                ),
            )
            preferOpus(transceiver)
            connection.createOffer(createOfferObserver(session), MediaConstraints())
        } catch (error: Throwable) {
            disposePeer(session)
            reportStatus("Could not negotiate native sender peer for $memberId: ${error.message}")
        }
        return session
    }

    private fun createReceiverPeer(memberId: String, sourceEpoch: Long): PeerSession? {
        val factory = peerConnectionFactory ?: return null
        val session = PeerSession(memberId, PeerRole.RECEIVER, sourceEpoch, ++peerToken)
        peers[memberId] = session
        val observer = PeerObserver(session)
        val connection = runCatching {
            factory.createPeerConnection(rtcConfiguration(sourceEpoch), observer)
        }.getOrNull()
        if (connection == null) {
            peers.remove(memberId)
            reportStatus("Could not create native receiver peer for $memberId.")
            return null
        }
        session.peerConnection = connection
        // No local track or transceiver is added to a receiver peer. The
        // remote offer creates the receive-only audio m-section, so the answer
        // cannot accidentally publish this phone's microphone.
        runCatching { connection.setAudioRecording(false) }
        runCatching { connection.setAudioPlayout(true) }
        return session
    }

    private fun createOfferObserver(session: PeerSession): SdpObserver = object : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) {
            postToSignaling {
                if (!isCurrentSession(session)) return@postToSignaling
                setLocalDescriptionAndSend(session, description)
            }
        }

        override fun onSetSuccess() = Unit

        override fun onCreateFailure(error: String) {
            postToSignaling {
                if (isCurrentSession(session)) {
                    disposePeer(session)
                    reportStatus("Native sender offer failed for ${session.memberId}: $error")
                }
            }
        }

        override fun onSetFailure(error: String) = Unit
    }

    private fun setLocalDescriptionAndSend(session: PeerSession, description: SessionDescription) {
        val connection = session.peerConnection ?: return
        connection.setLocalDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit

            override fun onSetSuccess() {
                postToSignaling {
                    if (!isCurrentSession(session)) return@postToSignaling
                    session.localDescriptionSet = true
                    sendSignal(session, descriptionSignal(description))
                    flushLocalCandidates(session)
                }
            }

            override fun onCreateFailure(error: String) = Unit

            override fun onSetFailure(error: String) {
                postToSignaling {
                    if (isCurrentSession(session)) {
                        disposePeer(session)
                        reportStatus("Native local description failed for ${session.memberId}: $error")
                    }
                }
            }
        }, description)
    }

    private fun setRemoteDescriptionAndMaybeAnswer(
        session: PeerSession,
        description: SessionDescription,
    ) {
        val connection = session.peerConnection ?: return
        connection.setRemoteDescription(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) = Unit

            override fun onSetSuccess() {
                postToSignaling {
                    if (!isCurrentSession(session)) return@postToSignaling
                    session.remoteDescriptionSet = true
                    flushRemoteCandidates(session)
                    if (session.role == PeerRole.RECEIVER) createAnswer(session)
                }
            }

            override fun onCreateFailure(error: String) = Unit

            override fun onSetFailure(error: String) {
                postToSignaling {
                    if (isCurrentSession(session)) {
                        disposePeer(session)
                        reportStatus("Native remote description failed for ${session.memberId}: $error")
                    }
                }
            }
        }, description)
    }

    private fun createAnswer(session: PeerSession) {
        val connection = session.peerConnection ?: return
        try {
            connection.createAnswer(object : SdpObserver {
                override fun onCreateSuccess(description: SessionDescription) {
                    postToSignaling {
                        if (isCurrentSession(session)) setLocalDescriptionAndSend(session, description)
                    }
                }

                override fun onSetSuccess() = Unit

                override fun onCreateFailure(error: String) {
                    postToSignaling {
                        if (isCurrentSession(session)) {
                            disposePeer(session)
                            reportStatus("Native receiver answer failed for ${session.memberId}: $error")
                        }
                    }
                }

                override fun onSetFailure(error: String) = Unit
            }, MediaConstraints())
        } catch (error: Throwable) {
            disposePeer(session)
            reportStatus("Could not create native receiver answer for ${session.memberId}: ${error.message}")
        }
    }

    private fun flushRemoteCandidates(session: PeerSession) {
        val connection = session.peerConnection ?: return
        while (session.pendingRemoteCandidates.isNotEmpty()) {
            val candidate = session.pendingRemoteCandidates.removeFirst()
            runCatching { connection.addIceCandidate(candidate) }
        }
    }

    private fun flushLocalCandidates(session: PeerSession) {
        while (session.pendingLocalCandidates.isNotEmpty()) {
            sendCandidate(session, session.pendingLocalCandidates.removeFirst())
        }
    }

    private fun sendSignal(session: PeerSession, signal: JSONObject) {
        if (!isCurrentSession(session) || !isSessionEpochUsable(session)) return
        roomClient.sendRtc(session.memberId, signal, session.sourceEpoch)
    }

    private fun sendCandidate(session: PeerSession, candidate: IceCandidate) {
        sendSignal(session, candidateSignal(candidate))
    }

    private fun handleLocalCandidate(session: PeerSession, candidate: IceCandidate) {
        if (!isCurrentSession(session)) return
        if (!session.localDescriptionSet) {
            if (session.pendingLocalCandidates.size >= MAX_PENDING_ICE_CANDIDATES) {
                session.pendingLocalCandidates.removeFirst()
            }
            session.pendingLocalCandidates.addLast(candidate)
        } else {
            sendCandidate(session, candidate)
        }
    }

    private fun handleRemoteTrack(session: PeerSession, track: MediaStreamTrack?) {
        val audio = track as? AudioTrack ?: return
        if (!session.remoteAudioTracks.contains(audio)) session.remoteAudioTracks += audio
        runCatching { audio.setEnabled(true) }
        runCatching { audio.setVolume(playbackVolume) }
    }

    private fun disposePeersForEpoch(sourceEpoch: Long?) {
        peers.values.toList()
            .filter { sourceEpoch == null || it.sourceEpoch == sourceEpoch }
            .forEach(::disposePeer)
    }

    private fun disposeAllPeers() {
        peers.values.toList().forEach(::disposePeer)
    }

    private fun disposePeer(session: PeerSession) {
        if (session.closed) return
        if (peers[session.memberId] === session) peers.remove(session.memberId)
        session.closed = true
        session.pendingRemoteCandidates.clear()
        session.pendingLocalCandidates.clear()
        session.remoteAudioTracks.clear()
        runCatching { session.peerConnection?.dispose() }
        session.peerConnection = null
    }

    private fun isCurrentSession(session: PeerSession): Boolean =
        !closed && !session.closed && peers[session.memberId] === session

    private fun isSessionEpochUsable(session: PeerSession): Boolean {
        val state = synchronized(stateLock) { latestRoomState } ?: return false
        if (state.room.sourceEpoch != session.sourceEpoch) return false
        return when (session.role) {
            PeerRole.SENDER -> synchronized(stateLock) {
                sourceStarted && activeSourceEpoch == session.sourceEpoch &&
                    state.sourceAuthorization().canPublishFrames
            }
            PeerRole.RECEIVER -> !state.sourceAuthorization().isSelfActiveSource &&
                state.room.activeSourceId == session.memberId &&
                !state.room.sourceStatus.equals("NONE", true)
        }
    }

    private fun preferOpus(transceiver: RtpTransceiver) {
        val factory = peerConnectionFactory ?: return
        val codecs = runCatching {
            factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO)
                .codecs
                .filter { it.name.equals("opus", ignoreCase = true) }
        }.getOrDefault(emptyList())
        if (codecs.isNotEmpty()) runCatching { transceiver.setCodecPreferences(codecs) }
    }

    private fun rtcConfiguration(sourceEpoch: Long): PeerConnection.RTCConfiguration =
        PeerConnection.RTCConfiguration(
            synchronized(stateLock) { iceServers },
        ).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

    private fun loadIceServersIfNeeded() {
        synchronized(stateLock) {
            if (iceServersLoaded || closed) return
            iceServersLoaded = true
        }
        val configured = try { roomClient.fetchIceServers() } catch (t: Throwable) { android.util.Log.e("RoomSound", "fetchIceServers failed", t); emptyList() }
        if (configured.isEmpty()) return
        val converted = configured.mapNotNull { server ->
            runCatching {
                PeerConnection.IceServer.builder(server.urls).apply {
                    server.username?.let(::setUsername)
                    server.credential?.let(::setPassword)
                }.createIceServer()
            }.getOrNull()
        }
        if (converted.isNotEmpty()) synchronized(stateLock) {
            if (!closed) iceServers = converted
        }
    }

    private fun parseDescription(
        json: JSONObject,
        expectedType: SessionDescription.Type,
    ): SessionDescription? {
        val type = json.optString("type", "").lowercase(Locale.US)
        val sdp = json.optString("sdp", "")
        if (type != expectedType.canonicalForm() || sdp.isBlank()) return null
        return runCatching { SessionDescription(expectedType, sdp) }.getOrNull()
    }

    private fun parseCandidate(json: JSONObject): IceCandidate? {
        val candidate = json.optString("candidate", "").takeIf { it.isNotBlank() } ?: return null
        val index = json.optInt("sdpMLineIndex", -1)
        if (index < 0) return null
        val mid = if (json.has("sdpMid") && !json.isNull("sdpMid")) {
            json.optString("sdpMid", "").takeIf { it.isNotBlank() }
        } else {
            null
        }
        return IceCandidate(mid, index, candidate)
    }

    private fun descriptionSignal(description: SessionDescription): JSONObject = JSONObject()
        .put("type", description.type.canonicalForm())
        .put(
            "description",
            JSONObject()
                .put("type", description.type.canonicalForm())
                .put("sdp", description.description),
        )

    private fun candidateSignal(candidate: IceCandidate): JSONObject {
        val json = JSONObject()
            .put("type", "candidate")
            .put(
                "candidate",
                JSONObject()
                    .put("candidate", candidate.sdp)
                    .put("sdpMLineIndex", candidate.sdpMLineIndex),
            )
        if (candidate.sdpMid == null) {
            json.getJSONObject("candidate").put("sdpMid", JSONObject.NULL)
        } else {
            json.getJSONObject("candidate").put("sdpMid", candidate.sdpMid)
        }
        return json
    }

    private fun postToSignaling(block: () -> Unit) {
        if (signalingExecutor.isShutdown) return
        runCatching {
            signalingExecutor.execute {
                runCatching(block).onFailure { reportStatus("WebRTC signaling error: ${it.message}") }
            }
        }
    }

    private fun reportStatus(message: String) {
        runCatching { onStatus(message) }
    }

    private inner class PeerObserver(
        private val session: PeerSession,
    ) : PeerConnection.Observer {
        override fun onSignalingChange(newState: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState) {
            if (newState == PeerConnection.IceConnectionState.FAILED ||
                newState == PeerConnection.IceConnectionState.CLOSED
            ) {
                postToSignaling {
                    if (isCurrentSession(session)) disposePeer(session)
                }
            }
        }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState) = Unit

        override fun onIceCandidate(candidate: IceCandidate) {
            postToSignaling { handleLocalCandidate(session, candidate) }
        }

        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit

        override fun onAddStream(stream: MediaStream) {
            postToSignaling {
                if (isCurrentSession(session)) stream.audioTracks.forEach { handleRemoteTrack(session, it) }
            }
        }

        override fun onRemoveStream(stream: MediaStream) = Unit

        override fun onDataChannel(dataChannel: DataChannel) = Unit

        override fun onRenegotiationNeeded() = Unit

        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<MediaStream>) {
            postToSignaling {
                if (isCurrentSession(session)) handleRemoteTrack(session, receiver.track())
            }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            postToSignaling {
                if (isCurrentSession(session)) handleRemoteTrack(session, transceiver.receiver.track())
            }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            if (newState == PeerConnection.PeerConnectionState.FAILED ||
                newState == PeerConnection.PeerConnectionState.CLOSED
            ) {
                postToSignaling {
                    if (isCurrentSession(session)) disposePeer(session)
                }
            }
        }
    }

    private data class Tuple5(
        val first: Boolean,
        val second: Long?,
        val third: Boolean,
        val fourth: String?,
        val fifth: Long?,
    )

    companion object {
        const val CAPTURE_SAMPLE_RATE = 48_000
        const val CAPTURE_CHANNELS = 1
        private const val MAX_PENDING_ICE_CANDIDATES = 64
        private val WEBRTC_INIT_LOCK = Any()
        private var webRtcInitialized = false

        private fun initializeWebRtcOnce(context: Context) {
            synchronized(WEBRTC_INIT_LOCK) {
                if (webRtcInitialized) return
                try {
                    PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(context)
                            .createInitializationOptions(),
                    )
                    webRtcInitialized = true
                } catch (error: Throwable) {
                    // Do not permanently poison the process if library loading
                    // failed transiently before a factory was created.
                    webRtcInitialized = false
                    throw error
                }
            }
        }
    }
}

private fun JSONObject.objectOrEmpty(key: String): JSONObject = optJSONObject(key) ?: JSONObject()
