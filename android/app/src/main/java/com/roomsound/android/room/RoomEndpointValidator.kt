package com.roomsound.android.room

import java.net.URI

/** The two endpoint experiences shown by the Android client. */
enum class RoomEndpointKind {
    LAN,
    PUBLIC,
}

/**
 * A validated endpoint as entered by the user and the WebSocket URL used by
 * the native client. HTTP(S) is accepted as a convenient server-origin input
 * and is converted to the corresponding WebSocket scheme.
 */
data class RoomEndpointInfo(
    val webSocketUrl: String,
    val inputScheme: String,
    val kind: RoomEndpointKind,
)

/** Shared endpoint parsing for the Activity, coordinator, and WebSocket client. */
object RoomEndpointValidator {
    private val acceptedSchemes = setOf("ws", "wss", "http", "https")

    const val INVALID_ENDPOINT_MESSAGE =
        "Enter a LAN endpoint as ws:// or http:// with the computer's LAN address, " +
            "or a public endpoint as wss:// or https:// with a TLS server."

    fun parse(rawEndpoint: String): RoomEndpointInfo? {
        val input = rawEndpoint.trim()
        if (input.isEmpty() || input.any(Char::isWhitespace)) return null
        val uri = runCatching { URI(input) }.getOrNull() ?: return null
        val inputScheme = uri.scheme?.lowercase() ?: return null
        if (inputScheme !in acceptedSchemes || uri.host.isNullOrBlank() ||
            uri.userInfo != null || uri.fragment != null || uri.port !in -1..65535
        ) return null

        val authority = uri.rawAuthority?.takeIf { it.isNotBlank() } ?: return null
        val path = uri.rawPath.orEmpty().trimEnd('/')
        val query = uri.rawQuery?.let { "?$it" }.orEmpty()
        val webSocketScheme = when (inputScheme) {
            "ws", "http" -> "ws"
            "wss", "https" -> "wss"
            else -> return null
        }
        val webSocketUrl = buildString {
            append(webSocketScheme)
            append("://")
            append(authority)
            append(path)
            append(query)
        }.takeIf { it.length > webSocketScheme.length + 3 } ?: return null

        return RoomEndpointInfo(
            webSocketUrl = webSocketUrl,
            inputScheme = inputScheme,
            kind = if (inputScheme == "wss" || inputScheme == "https") {
                RoomEndpointKind.PUBLIC
            } else {
                RoomEndpointKind.LAN
            },
        )
    }

    fun normalize(rawEndpoint: String): String? = parse(rawEndpoint)?.webSocketUrl

    fun guidance(rawEndpoint: String): String = parse(rawEndpoint)?.let(::guidance) ?: INVALID_ENDPOINT_MESSAGE

    fun guidance(endpoint: RoomEndpointInfo): String = when (endpoint.kind) {
        RoomEndpointKind.LAN ->
            "LAN endpoint: ws:// or http:// becomes ws://. Use the computer's LAN IP on the same Wi-Fi."
        RoomEndpointKind.PUBLIC ->
            "Public endpoint: wss:// or https:// becomes wss://. Use a TLS-enabled public server."
    }
}
