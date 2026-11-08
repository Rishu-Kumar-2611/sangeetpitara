package com.roomsound.android.room

import java.net.URI
import java.util.Locale

/**
 * Online invite links have the form https://<site>/join/<CODE>. Android opens
 * them in the app once the site's /.well-known/assetlinks.json is verified;
 * without the app installed, the site redirects browsers to its join form.
 */
object InviteLinks {
    private val codePattern = Regex("^[A-Z0-9]{4,16}$")

    /** The room code from an invite link for [expectedHost], or null for anything else. */
    fun roomCode(link: String?, expectedHost: String?): String? {
        if (link.isNullOrBlank() || expectedHost.isNullOrBlank()) return null
        val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return null
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        if (!uri.host.equals(expectedHost.substringBefore(':'), ignoreCase = true)) return null
        val segments = uri.path.orEmpty().trim('/').split('/')
        if (segments.size != 2 || segments[0] != "join") return null
        val code = segments[1].replace("-", "").uppercase(Locale.US)
        return code.takeIf { codePattern.matches(it) }
    }

    /** The shareable link for [code] on a public (wss://) room server, or null for local rooms. */
    fun forRoom(endpoint: String?, code: String?): String? {
        val host = publicHost(endpoint) ?: return null
        val normalized = code?.replace("-", "")?.trim()?.uppercase(Locale.US) ?: return null
        if (!codePattern.matches(normalized)) return null
        return "https://$host/join/$normalized"
    }

    /** The website host behind a wss:// room endpoint, or null for ws:// and malformed endpoints. */
    fun publicHost(endpoint: String?): String? {
        val uri = runCatching { URI(endpoint?.trim().orEmpty()) }.getOrNull() ?: return null
        if (!uri.scheme.equals("wss", ignoreCase = true)) return null
        val host = uri.host?.lowercase(Locale.US) ?: return null
        return if (uri.port == -1 || uri.port == 443) host else "$host:${uri.port}"
    }
}
