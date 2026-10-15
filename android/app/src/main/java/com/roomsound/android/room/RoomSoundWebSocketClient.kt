package com.roomsound.android.room

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URI
import java.io.Closeable
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min

enum class RoomConnectionState {
    IDLE,
    CONNECTING,
    OPEN,
    JOINED,
    RECONNECT_WAIT,
    CLOSING,
    CLOSED,
    FAILED,
}

/**
 * OkHttp client for the existing RoomSound JSON WebSocket protocol.
 *
 * The client owns signaling/control only. It deliberately does not send PCM
 * over the WebSocket: the server's `rtc` messages are signaling envelopes and
 * the media plane remains a separate transport seam.
 */
class RoomSoundWebSocketClient(
    endpoint: String,
    private val okHttpClient: OkHttpClient = defaultOkHttpClient(),
    private val autoReconnect: Boolean = true,
) : Closeable {
    interface Listener {
        fun onConnectionStateChanged(state: RoomConnectionState)
        fun onEvent(event: RoomSoundEvent)
    }

    private data class RoomIntent(
        val roomCode: String?,
        val roomName: String?,
        val displayName: String,
        val guestId: String,
    )

    private val endpoint = endpoint.trim()
    private val listeners = CopyOnWriteArraySet<Listener>()
    private val lock = Any()
    private val reconnectExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "RoomSound-WebSocket-Reconnect").apply { isDaemon = true }
    }

    @Volatile
    private var connectionState = RoomConnectionState.IDLE
    private var webSocket: WebSocket? = null
    private var roomState: RoomState? = null
    private var roomIntent: RoomIntent? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    private var stopRequested = false
    private var permanentlyClosed = false

    init {
        require(endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
            "RoomSound WebSocket endpoint must use ws:// or wss://."
        }
    }

    fun addListener(listener: Listener) {
        listeners += listener
        runCatching { listener.onConnectionStateChanged(connectionState()) }
    }

    fun removeListener(listener: Listener) {
        listeners -= listener
    }

    fun connectionState(): RoomConnectionState = synchronized(lock) { connectionState }

    fun currentRoomState(): RoomState? = synchronized(lock) { roomState }

    fun currentSourceAuthorization(): SourceAuthorization? = synchronized(lock) {
        roomState?.sourceAuthorization()
    }

    /** Fetches the HTTP ICE configuration that belongs to this WebSocket endpoint. */
    fun fetchIceServers(): List<RoomIceServer> {
        val uri = runCatching { URI(endpoint) }.getOrNull() ?: return emptyList()
        val scheme = if (uri.scheme.equals("wss", ignoreCase = true)) "https" else "http"
        val host = uri.host ?: return emptyList()
        val configUrl = runCatching {
            URI(scheme, null, host, uri.port, "/config", null, null).toString()
        }.getOrNull() ?: return emptyList()
        val request = runCatching { Request.Builder().url(configUrl).get().build() }.getOrNull() ?: return emptyList()
        return runCatching {
            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use emptyList()
                parseIceServers(JSONObject(response.body?.string().orEmpty()))
            }
        }.getOrDefault(emptyList())
    }

    /** Connect without selecting a room. Usually createRoom or joinRoom is preferred. */
    fun connect() {
        synchronized(lock) {
            check(!permanentlyClosed) { "This RoomSound client has been closed." }
            stopRequested = false
            if (webSocket != null || connectionState == RoomConnectionState.CONNECTING ||
                connectionState == RoomConnectionState.OPEN || connectionState == RoomConnectionState.JOINED
            ) {
                return
            }
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        openSocket()
    }

    fun createRoom(name: String, displayName: String, guestId: String) {
        val cleanName = name.trim().ifEmpty { "Listening room" }
        val intent = RoomIntent(
            roomCode = null,
            roomName = cleanName,
            displayName = cleanDisplayName(displayName),
            guestId = requireIdentity(guestId),
        )
        selectRoom(intent)
    }

    fun joinRoom(code: String, displayName: String, guestId: String) {
        val cleanCode = code.trim().uppercase(Locale.US)
        require(cleanCode.isNotEmpty()) { "Room code must not be empty." }
        val intent = RoomIntent(
            roomCode = cleanCode,
            roomName = null,
            displayName = cleanDisplayName(displayName),
            guestId = requireIdentity(guestId),
        )
        selectRoom(intent)
    }

    fun sendChat(text: String): Boolean {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) return false
        return sendRoomCommand(JSONObject().put("type", "chat").put("text", cleanText))
    }

    fun requestControl(sourceType: String = "DEVICE_AUDIO", note: String = ""): Boolean =
        sendRoomCommand(
            JSONObject()
                .put("type", "request-control")
                .put("sourceType", sourceType.trim().ifEmpty { "DEVICE_AUDIO" })
                .put("note", note.trim()),
        )

    fun cancelRequest(requestId: String): Boolean = sendRoomCommand(
        JSONObject().put("type", "cancel-request").put("requestId", requestId.trim()),
    )

    fun approveRequest(requestId: String): Boolean = sendRoomCommand(
        JSONObject().put("type", "approve-request").put("requestId", requestId.trim()),
    )

    fun rejectRequest(requestId: String): Boolean = sendRoomCommand(
        JSONObject().put("type", "reject-request").put("requestId", requestId.trim()),
    )

    /**
     * Start-source is checked against the last accepted server state before it
     * is sent. The server remains authoritative and will validate it again.
     */
    fun startSource(sourceType: String, sourceLabel: String = "audio"): Boolean {
        val state = currentRoomState()
        val self = state?.self
        val room = state?.room
        val isModerator = self != null && (self.id == room?.hostId || self.id == room?.cohostId)
        val isCurrentSource = self != null && self.id == room?.activeSourceId
        val canAskServer = self != null && room != null &&
            (isCurrentSource || (isModerator && (room.activeSourceId == null || isCurrentSource)))
        if (!canAskServer) {
            emit(RoomSoundEvent.LocalError("The current room state does not authorize this client to start a source."))
            return false
        }
        return sendRoomCommand(
            JSONObject()
                .put("type", "start-source")
                .put("sourceType", sourceType.trim().ifEmpty { "DEVICE_AUDIO" })
                .put("sourceLabel", sourceLabel.trim().ifEmpty { "audio" }),
        )
    }

    fun stopSource(): Boolean {
        val state = currentRoomState()
        val self = state?.self
        val room = state?.room
        val isModerator = self != null && (self.id == room?.hostId || self.id == room?.cohostId)
        val isCurrentSource = self != null && self.id == room?.activeSourceId
        if (self == null || room == null || (!isModerator && !isCurrentSource)) {
            emit(RoomSoundEvent.LocalError("The current room state does not authorize stopping the source."))
            return false
        }
        return sendRoomCommand(JSONObject().put("type", "stop-source"))
    }

    fun takeover(sourceType: String = "DEVICE_AUDIO"): Boolean {
        val state = currentRoomState()
        val self = state?.self
        val room = state?.room
        val isModerator = self != null && room != null && (self.id == room.hostId || self.id == room.cohostId)
        if (!isModerator) {
            emit(RoomSoundEvent.LocalError("Only a host or co-host can take over the source."))
            return false
        }
        return sendRoomCommand(
            JSONObject().put("type", "takeover").put("sourceType", sourceType.trim().ifEmpty { "DEVICE_AUDIO" }),
        )
    }

    fun assignCohost(memberId: String?): Boolean = sendRoomCommand(
        JSONObject().put("type", "assign-cohost").putNullable("memberId", memberId?.trim()?.ifEmpty { null }),
    )

    fun removeMember(memberId: String): Boolean = sendRoomCommand(
        JSONObject().put("type", "remove-member").put("memberId", memberId.trim()),
    )

    fun endRoom(): Boolean = sendRoomCommand(JSONObject().put("type", "end-room"))

    /**
     * Sends an RTC signaling envelope tagged with the room's current source
     * epoch. The optional explicit epoch is used by a media backend that has
     * already captured the epoch for its peer session; the two-argument API
     * remains the normal call site and reads currentRoomState atomically.
     */
    fun sendRtc(targetMemberId: String, signal: JSONObject): Boolean {
        val currentEpoch = synchronized(lock) { roomState?.room?.sourceEpoch }
        return sendRtc(targetMemberId, signal, currentEpoch)
    }

    fun sendRtc(targetMemberId: String, signal: JSONObject, sourceEpoch: Long?): Boolean {
        val target = targetMemberId.trim()
        if (target.isEmpty()) return false
        val message = JSONObject()
            .put("type", "rtc")
            .put("to", target)
            .put("signal", signal)
        if (sourceEpoch != null) message.put("sourceEpoch", sourceEpoch)
        return sendRoomCommand(message)
    }

    /** Leave the room and close this socket without scheduling a reconnect. */
    fun leaveRoom(): Boolean {
        val sent = sendRoomCommand(JSONObject().put("type", "leave-room"))
        synchronized(lock) {
            stopRequested = true
            roomIntent = null
            roomState = null
        }
        webSocketSnapshot()?.let { socket ->
            setConnectionState(RoomConnectionState.CLOSING)
            socket.close(NORMAL_CLOSE, "Left room")
        }
        return sent
    }

    /** Stop the current socket. The client can be used again for createRoom/joinRoom. */
    fun disconnect() {
        synchronized(lock) {
            stopRequested = true
            roomIntent = null
            roomState = null
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        webSocketSnapshot()?.let { socket ->
            setConnectionState(RoomConnectionState.CLOSING)
            socket.close(NORMAL_CLOSE, "Disconnected")
        }
    }

    override fun close() {
        synchronized(lock) {
            permanentlyClosed = true
            stopRequested = true
            roomIntent = null
            roomState = null
            reconnectFuture?.cancel(false)
            reconnectFuture = null
        }
        webSocketSnapshot()?.let { socket ->
            setConnectionState(RoomConnectionState.CLOSING)
            socket.close(NORMAL_CLOSE, "Client closed")
        }
        reconnectExecutor.shutdownNow()
    }

    private fun selectRoom(intent: RoomIntent) {
        synchronized(lock) {
            check(!permanentlyClosed) { "This RoomSound client has been closed." }
            check(roomState == null || connectionState != RoomConnectionState.JOINED) {
                "Leave the current RoomSound room before selecting another room."
            }
            stopRequested = false
            roomIntent = intent
            roomState = null
        }
        if (connectionState() == RoomConnectionState.OPEN) {
            sendPendingRoomIntent()
        } else {
            connect()
        }
    }

    private fun openSocket() {
        val request = try {
            Request.Builder().url(endpoint).build()
        } catch (error: IllegalArgumentException) {
            setConnectionState(RoomConnectionState.FAILED)
            emit(RoomSoundEvent.Error("Invalid RoomSound WebSocket endpoint: ${error.message}"))
            return
        }

        setConnectionState(RoomConnectionState.CONNECTING)
        val socket = okHttpClient.newWebSocket(request, socketListener)
        synchronized(lock) {
            if (permanentlyClosed || stopRequested) {
                socket.close(NORMAL_CLOSE, "Connection canceled")
            } else {
                webSocket = socket
            }
        }
    }

    private val socketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (permanentlyClosed || stopRequested) {
                    webSocket.close(NORMAL_CLOSE, "Connection canceled")
                    return
                }
                this@RoomSoundWebSocketClient.webSocket = webSocket
                reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
                reconnectFuture?.cancel(false)
                reconnectFuture = null
            }
            setConnectionState(RoomConnectionState.OPEN)
            sendPendingRoomIntent()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!isCurrentSocket(webSocket)) return
            handleMessage(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            if (!isCurrentSocket(webSocket)) return
            setConnectionState(RoomConnectionState.CLOSING)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (!clearCurrentSocket(webSocket)) return
            setConnectionState(RoomConnectionState.CLOSED)
            scheduleReconnectIfNeeded()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!clearCurrentSocket(webSocket)) return
            emit(RoomSoundEvent.Error("RoomSound WebSocket failed for $endpoint: ${t.message ?: t.javaClass.simpleName}"))
            setConnectionState(RoomConnectionState.FAILED)
            scheduleReconnectIfNeeded()
        }
    }

    private fun handleMessage(text: String) {
        val message = try {
            JSONObject(text)
        } catch (error: Exception) {
            emit(RoomSoundEvent.Error("RoomSound sent invalid JSON: ${error.message ?: "parse error"}"))
            return
        }

        val type = message.stringOrNull("type")
        if (type == null) {
            emit(RoomSoundEvent.Error("RoomSound sent an event without a type."))
            return
        }

        try {
            when (type) {
                "joined" -> handleRoomState(message, joined = true)
                "state" -> handleRoomState(message, joined = false)
                "error" -> {
                    val serverMessage = message.stringOrNull("message") ?: "RoomSound rejected the request."
                    synchronized(lock) {
                        if (roomState == null) roomIntent = null
                    }
                    emit(RoomSoundEvent.Error(serverMessage))
                }
                "chat" -> emit(RoomSoundEvent.Chat(parseChatMessage(message.objectOrEmpty("message"))))
                "control-requested" -> emit(
                    RoomSoundEvent.ControlRequested(parseRoomRequest(message.objectOrEmpty("request"))),
                )
                "request-result" -> emit(
                    RoomSoundEvent.RequestResult(
                        status = message.stringOrNull("status") ?: "UNKNOWN",
                        request = message.optJSONObject("request")?.let { parseRoomRequest(it) },
                    ),
                )
                "control-request-expired" -> emit(
                    RoomSoundEvent.ControlRequestExpired(message.stringOrNull("requestId") ?: ""),
                )
                "source-disconnected" -> emit(RoomSoundEvent.SourceDisconnected(message.stringOrNull("memberId")))
                "host-disconnected" -> emit(RoomSoundEvent.HostDisconnected(message.stringOrNull("memberId")))
                "host-promoted" -> emit(RoomSoundEvent.HostPromoted(message.stringOrNull("memberId")))
                "takeover" -> emit(RoomSoundEvent.Takeover(message.stringOrNull("memberId")))
                "removed" -> {
                    synchronized(lock) {
                        roomIntent = null
                        roomState = null
                    }
                    emit(RoomSoundEvent.Removed(message.stringOrNull("message") ?: "You were removed from the room."))
                }
                "room-ended" -> {
                    synchronized(lock) {
                        roomIntent = null
                        roomState = null
                    }
                    emit(RoomSoundEvent.RoomEnded(message.stringOrNull("message") ?: "The room ended."))
                }
                "rtc" -> emit(
                    RoomSoundEvent.Rtc(
                        from = message.stringOrNull("from"),
                        signal = message.objectOrEmpty("signal"),
                        sourceEpoch = message.longOrNull("sourceEpoch"),
                    ),
                )
                else -> emit(RoomSoundEvent.Unknown(type, message))
            }
        } catch (error: Exception) {
            emit(RoomSoundEvent.Error("Invalid RoomSound '$type' event: ${error.message ?: "bad payload"}"))
        }
    }

    private fun handleRoomState(message: JSONObject, joined: Boolean) {
        val nextState = parseRoomState(message.objectOrEmpty("state"))
        var staleEvent: RoomSoundEvent.StaleStateIgnored? = null
        var accepted = false
        synchronized(lock) {
            val previous = roomState
            accepted = previous == null || previous.room.id != nextState.room.id ||
                nextState.room.sourceEpoch >= previous.room.sourceEpoch
            if (accepted) {
                roomState = nextState
                if (joined || roomIntent != null) {
                    val intent = roomIntent
                    if (intent != null) roomIntent = intent.copy(roomCode = nextState.room.code)
                }
            } else {
                val current = requireNotNull(previous)
                staleEvent = RoomSoundEvent.StaleStateIgnored(
                    roomId = nextState.room.id,
                    receivedEpoch = nextState.room.sourceEpoch,
                    currentEpoch = current.room.sourceEpoch,
                )
            }
        }
        if (!accepted) {
            emit(staleEvent ?: return)
            return
        }
        setConnectionState(RoomConnectionState.JOINED)
        emit(if (joined) RoomSoundEvent.Joined(nextState) else RoomSoundEvent.State(nextState))
    }

    private fun sendPendingRoomIntent() {
        val socket = webSocketSnapshot() ?: return
        val intent = synchronized(lock) { roomIntent } ?: return
        val message = if (intent.roomCode == null) {
            JSONObject()
                .put("type", "create-room")
                .put("name", intent.roomName ?: "Listening room")
                .put("displayName", intent.displayName)
                .put("guestId", intent.guestId)
        } else {
            JSONObject()
                .put("type", "join-room")
                .put("code", intent.roomCode)
                .put("displayName", intent.displayName)
                .put("guestId", intent.guestId)
        }
        if (!socket.send(message.toString())) {
            emit(RoomSoundEvent.Error("RoomSound could not send the room selection request."))
        }
    }

    private fun sendRoomCommand(message: JSONObject): Boolean {
        val socket = synchronized(lock) {
            if (connectionState != RoomConnectionState.JOINED || roomState == null) null else webSocket
        } ?: return false
        return socket.send(message.toString())
    }

    private fun scheduleReconnectIfNeeded() {
        val shouldSchedule = synchronized(lock) {
            autoReconnect && !permanentlyClosed && !stopRequested && roomIntent != null &&
                reconnectFuture == null && webSocket == null
        }
        if (!shouldSchedule) return

        val delay = synchronized(lock) {
            val value = reconnectDelayMs
            reconnectDelayMs = min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
            value
        }
        setConnectionState(RoomConnectionState.RECONNECT_WAIT)
        synchronized(lock) {
            if (reconnectFuture == null) {
                reconnectFuture = reconnectExecutor.schedule({
                    synchronized(lock) { reconnectFuture = null }
                    if (!isStopped()) openSocket()
                }, delay, TimeUnit.MILLISECONDS)
            }
        }
    }

    private fun isStopped(): Boolean = synchronized(lock) { permanentlyClosed || stopRequested }

    private fun isCurrentSocket(candidate: WebSocket): Boolean = synchronized(lock) { webSocket === candidate }

    private fun clearCurrentSocket(candidate: WebSocket): Boolean = synchronized(lock) {
        if (webSocket !== candidate) return false
        webSocket = null
        true
    }

    private fun webSocketSnapshot(): WebSocket? = synchronized(lock) { webSocket }

    private fun setConnectionState(next: RoomConnectionState) {
        val changed = synchronized(lock) {
            if (connectionState == next) false else {
                connectionState = next
                true
            }
        }
        if (changed) {
            listeners.forEach { listener ->
                runCatching { listener.onConnectionStateChanged(next) }
            }
        }
    }

    private fun emit(event: RoomSoundEvent) {
        listeners.forEach { listener ->
            runCatching { listener.onEvent(event) }
        }
    }

    private fun cleanDisplayName(value: String): String = value.trim().ifEmpty { "Guest" }.take(40)

    private fun requireIdentity(value: String): String = value.trim().also {
        require(it.isNotEmpty()) { "guestId must not be empty." }
    }.take(80)

    private fun JSONObject.putNullable(key: String, value: String?): JSONObject {
        if (value == null) put(key, JSONObject.NULL) else put(key, value)
        return this
    }

    private fun JSONObject.longOrNull(key: String): Long? {
        if (!has(key) || isNull(key)) return null
        return optLong(key, Long.MIN_VALUE).takeUnless { it == Long.MIN_VALUE }
    }

    companion object {
        private const val NORMAL_CLOSE = 1000
        private const val INITIAL_RECONNECT_DELAY_MS = 1_000L
        private const val MAX_RECONNECT_DELAY_MS = 30_000L

        private fun defaultOkHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}
