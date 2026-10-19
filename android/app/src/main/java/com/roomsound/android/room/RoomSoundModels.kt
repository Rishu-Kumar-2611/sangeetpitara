package com.roomsound.android.room

import org.json.JSONArray
import org.json.JSONObject

/**
 * The state shape used by the RoomSound WebSocket server.
 *
 * These models intentionally keep the server's string values (roles, source
 * status, and event types) instead of guessing at a second protocol. That
 * makes the Android client tolerant of server additions while still giving
 * the transport a single, explicit source-authorization calculation.
 */
data class RoomSummary(
    val id: String,
    val code: String,
    val name: String,
    val status: String,
    val hostId: String?,
    val cohostId: String?,
    val activeSourceId: String?,
    val activeSourceType: String?,
    val sourceStatus: String,
    val sourceEpoch: Long,
    val resumeSourceId: String?,
    val createdAt: Long,
)

data class RoomMember(
    val id: String,
    val guestId: String,
    val name: String,
    val role: String,
    val online: Boolean,
    val isSource: Boolean,
    val joinedAt: Long,
)

data class RoomRequest(
    val id: String,
    val requesterId: String,
    val requesterName: String,
    val sourceType: String,
    val note: String,
    val status: String,
    val createdAt: Long,
    val expiresAt: Long,
)

data class RoomChatMessage(
    val id: String,
    val kind: String,
    val senderId: String?,
    val senderName: String?,
    val text: String,
    val createdAt: Long,
)

data class RoomState(
    val room: RoomSummary,
    val self: RoomMember?,
    val members: List<RoomMember>,
    val requests: List<RoomRequest>,
    val messages: List<RoomChatMessage>,
) {
    fun sourceAuthorization(): SourceAuthorization = SourceAuthorization(
        selfMemberId = self?.id,
        activeSourceId = room.activeSourceId,
        sourceStatus = room.sourceStatus,
        sourceEpoch = room.sourceEpoch,
    )
}

data class RoomIceServer(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

/**
 * The server-selected media plane. The defaults intentionally select the
 * bounded PCM16 relay so an Android client remains safe when an older server
 * omits the optional object from /config.
 */
data class RoomMediaRelayConfig(
    val enabled: Boolean = true,
    val mode: String = MODE_PCM16,
    val sampleRate: Int = PCM16_SAMPLE_RATE,
    val channels: Int = PCM16_CHANNELS,
) {
    val isPcm16Enabled: Boolean
        get() = enabled && mode.equals(MODE_PCM16, ignoreCase = true) &&
            sampleRate == PCM16_SAMPLE_RATE && channels == PCM16_CHANNELS

    companion object {
        const val MODE_PCM16 = "pcm16"
        const val PCM16_SAMPLE_RATE = 48_000
        const val PCM16_CHANNELS = 1
        val DEFAULT = RoomMediaRelayConfig()
    }
}

/** The complete response returned by the RoomSound server's /config endpoint. */
data class RoomServerConfig(
    val iceServers: List<RoomIceServer> = emptyList(),
    val mediaRelay: RoomMediaRelayConfig = RoomMediaRelayConfig.DEFAULT,
) {
    companion object {
        val DEFAULT = RoomServerConfig()
    }
}

/**
 * A snapshot of the server's source lease as seen by this client.
 *
 * `sourceEpoch` changes every time the server changes the active source. A
 * media publisher must bind to the current epoch and must not keep publishing
 * after the epoch or source member changes.
 */
data class SourceAuthorization(
    val selfMemberId: String?,
    val activeSourceId: String?,
    val sourceStatus: String,
    val sourceEpoch: Long,
) {
    val isSelfActiveSource: Boolean
        get() = !selfMemberId.isNullOrBlank() && selfMemberId == activeSourceId

    /** The source has a server lease, but may still be negotiating. */
    val isAuthorized: Boolean
        get() = isSelfActiveSource && !sourceStatus.equals("NONE", ignoreCase = true)

    /** Frames are accepted only after the server reports the source as LIVE. */
    val canPublishFrames: Boolean
        get() = isSelfActiveSource && sourceStatus.equals("LIVE", ignoreCase = true)

    /** Relay playout is allowed only for a different live source in this epoch. */
    val canReceiveRelayFrames: Boolean
        get() = !selfMemberId.isNullOrBlank() && !activeSourceId.isNullOrBlank() && !isSelfActiveSource &&
            sourceStatus.equals("LIVE", ignoreCase = true)
}

sealed interface RoomSoundEvent {
    data class Joined(val state: RoomState) : RoomSoundEvent
    data class State(val state: RoomState) : RoomSoundEvent
    data class Error(val message: String) : RoomSoundEvent
    data class LocalError(val message: String) : RoomSoundEvent
    data class Chat(val message: RoomChatMessage) : RoomSoundEvent
    data class ControlRequested(val request: RoomRequest) : RoomSoundEvent
    data class RequestResult(val status: String, val request: RoomRequest?) : RoomSoundEvent
    data class ControlRequestExpired(val requestId: String) : RoomSoundEvent
    data class SourceDisconnected(val memberId: String?) : RoomSoundEvent
    data class HostDisconnected(val memberId: String?) : RoomSoundEvent
    data class HostPromoted(val memberId: String?) : RoomSoundEvent
    data class Takeover(val memberId: String?) : RoomSoundEvent
    data class Removed(val message: String) : RoomSoundEvent
    data class RoomEnded(val message: String) : RoomSoundEvent
    data class Rtc(
        val from: String?,
        val signal: JSONObject,
        /** Optional for compatibility with older web clients and servers. */
        val sourceEpoch: Long? = null,
    ) : RoomSoundEvent
    data class StaleStateIgnored(
        val roomId: String,
        val receivedEpoch: Long,
        val currentEpoch: Long,
    ) : RoomSoundEvent
    data class Unknown(val type: String, val payload: JSONObject) : RoomSoundEvent
}

internal fun JSONObject.stringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).trim().takeIf { it.isNotEmpty() }
}

internal fun JSONObject.requiredString(key: String): String {
    return stringOrNull(key) ?: throw IllegalArgumentException("Missing non-empty JSON field '$key'.")
}

internal fun JSONObject.objectOrEmpty(key: String): JSONObject = optJSONObject(key) ?: JSONObject()

internal fun JSONObject.arrayOrEmpty(key: String): JSONArray = optJSONArray(key) ?: JSONArray()

internal fun parseRoomSummary(json: JSONObject): RoomSummary = RoomSummary(
    id = json.requiredString("id"),
    code = json.requiredString("code"),
    name = json.stringOrNull("name") ?: "",
    status = json.stringOrNull("status") ?: "UNKNOWN",
    hostId = json.stringOrNull("hostId"),
    cohostId = json.stringOrNull("cohostId"),
    activeSourceId = json.stringOrNull("activeSourceId"),
    activeSourceType = json.stringOrNull("activeSourceType"),
    sourceStatus = json.stringOrNull("sourceStatus") ?: "NONE",
    sourceEpoch = json.optLong("sourceEpoch", 0L),
    resumeSourceId = json.stringOrNull("resumeSourceId"),
    createdAt = json.optLong("createdAt", 0L),
)

internal fun parseRoomMember(json: JSONObject): RoomMember = RoomMember(
    id = json.requiredString("id"),
    guestId = json.stringOrNull("guestId") ?: "",
    name = json.stringOrNull("name") ?: "Guest",
    role = json.stringOrNull("role") ?: "PARTICIPANT",
    online = json.optBoolean("online", false),
    isSource = json.optBoolean("isSource", false),
    joinedAt = json.optLong("joinedAt", 0L),
)

internal fun parseRoomRequest(json: JSONObject): RoomRequest = RoomRequest(
    id = json.requiredString("id"),
    requesterId = json.requiredString("requesterId"),
    requesterName = json.stringOrNull("requesterName") ?: "Guest",
    sourceType = json.stringOrNull("sourceType") ?: "DEVICE_AUDIO",
    note = json.stringOrNull("note") ?: "",
    status = json.stringOrNull("status") ?: "UNKNOWN",
    createdAt = json.optLong("createdAt", 0L),
    expiresAt = json.optLong("expiresAt", 0L),
)

internal fun parseChatMessage(json: JSONObject): RoomChatMessage = RoomChatMessage(
    id = json.requiredString("id"),
    kind = json.stringOrNull("kind") ?: "chat",
    senderId = json.stringOrNull("senderId"),
    senderName = json.stringOrNull("senderName"),
    text = json.stringOrNull("text") ?: "",
    createdAt = json.optLong("createdAt", 0L),
)

internal fun parseRoomState(json: JSONObject): RoomState {
    val membersJson = json.arrayOrEmpty("members")
    val requestsJson = json.arrayOrEmpty("requests")
    val messagesJson = json.arrayOrEmpty("messages")

    return RoomState(
        room = parseRoomSummary(json.objectOrEmpty("room")),
        self = json.optJSONObject("self")?.let(::parseRoomMember),
        members = buildList {
            for (index in 0 until membersJson.length()) {
                val member = membersJson.optJSONObject(index) ?: continue
                runCatching { parseRoomMember(member) }.getOrNull()?.let { add(it) }
            }
        },
        requests = buildList {
            for (index in 0 until requestsJson.length()) {
                val request = requestsJson.optJSONObject(index) ?: continue
                runCatching { parseRoomRequest(request) }.getOrNull()?.let { add(it) }
            }
        },
        messages = buildList {
            for (index in 0 until messagesJson.length()) {
                val message = messagesJson.optJSONObject(index) ?: continue
                runCatching { parseChatMessage(message) }.getOrNull()?.let { add(it) }
            }
        },
    )
}

internal fun parseIceServers(json: JSONObject): List<RoomIceServer> = buildList {
    val servers = json.arrayOrEmpty("iceServers")
    for (index in 0 until servers.length()) {
        val server = servers.optJSONObject(index) ?: continue
        val urls = when (val rawUrls = server.opt("urls")) {
            is String -> listOf(rawUrls)
            is JSONArray -> buildList {
                for (urlIndex in 0 until rawUrls.length()) {
                    rawUrls.optString(urlIndex).trim().takeIf { it.isNotEmpty() }?.let(::add)
                }
            }
            else -> emptyList()
        }
        if (urls.isEmpty()) continue
        add(
            RoomIceServer(
                urls = urls,
                username = server.stringOrNull("username"),
                credential = server.stringOrNull("credential"),
            ),
        )
    }
}

internal fun parseMediaRelayConfig(json: JSONObject): RoomMediaRelayConfig {
    val relay = json.optJSONObject("mediaRelay") ?: return RoomMediaRelayConfig.DEFAULT
    return RoomMediaRelayConfig(
        // Missing enabled must stay fail-safe: relay is enabled unless the
        // server explicitly opts into direct WebRTC with false.
        enabled = relay.optBoolean("enabled", true),
        mode = relay.stringOrNull("mode") ?: RoomMediaRelayConfig.MODE_PCM16,
        sampleRate = relay.optInt("sampleRate", RoomMediaRelayConfig.PCM16_SAMPLE_RATE),
        channels = relay.optInt("channels", RoomMediaRelayConfig.PCM16_CHANNELS),
    )
}

internal fun parseRoomServerConfig(json: JSONObject): RoomServerConfig = RoomServerConfig(
    iceServers = parseIceServers(json),
    mediaRelay = parseMediaRelayConfig(json),
)
