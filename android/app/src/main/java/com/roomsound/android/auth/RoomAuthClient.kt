package com.roomsound.android.auth

import okhttp3.Call
import okhttp3.Callback
import okhttp3.Headers
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

internal const val MAX_ROOM_AUTH_TOKEN_LENGTH = 512

/** Accept only bearer values that are safe to place in an HTTP header. */
internal fun normalizeRoomAuthToken(token: String?): String? {
    val candidate = token?.trim().orEmpty()
    if (candidate.isEmpty() || candidate.length > MAX_ROOM_AUTH_TOKEN_LENGTH) return null
    if (candidate.any { it.code !in 0x21..0x7E }) return null
    return candidate
}

data class RoomAccountUser(
    val id: String,
    val email: String,
    val isAdmin: Boolean,
    val createdAt: String?,
)

data class RoomAuthSession(
    val user: RoomAccountUser,
    val token: String,
) {
    /** Keep accidental debug/toString output from exposing the bearer token. */
    override fun toString(): String = "RoomAuthSession(user=$user)"
}

class RoomAuthException(
    message: String,
    val statusCode: Int = 0,
) : IOException(message)

/** Converts the configured WebSocket origin to the same-origin HTTP API. */
object RoomAuthEndpoint {
    fun httpBase(roomEndpoint: String): String? {
        val uri = runCatching { URI(roomEndpoint.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase()
        if (scheme !in setOf("ws", "wss") || uri.host.isNullOrBlank() ||
            uri.userInfo != null || uri.fragment != null || uri.port !in -1..65535
        ) return null
        val httpScheme = if (scheme == "wss") "https" else "http"
        return runCatching {
            HttpUrl.Builder()
                .scheme(httpScheme)
                .host(uri.host)
                .apply { if (uri.port >= 0) port(uri.port) }
                .build()
                .toString()
                .trimEnd('/')
        }.getOrNull()
    }
}

/**
 * HTTP adapter for the same-origin RoomSound account endpoints.
 *
 * Android cannot use the browser's HttpOnly cookie jar as its session store.
 * The login response's Set-Cookie value (or a future JSON token field) is
 * captured here and then handed to EncryptedSessionStore by the activity.
 */
class RoomAuthClient(
    private val httpClient: OkHttpClient = defaultHttpClient(),
) {
    fun signIn(
        roomEndpoint: String,
        email: String,
        password: String,
        callback: (Result<RoomAuthSession>) -> Unit,
    ): Call {
        val request = requestFor(roomEndpoint, "/api/auth/login")?.let { url ->
            val body = JSONObject().put("email", email).put("password", password)
                .toString().toRequestBody(JSON_MEDIA_TYPE)
            Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .post(body)
                .build()
        } ?: return failedCall("Enter a valid RoomSound WebSocket endpoint.", callback)

        return enqueue(request, { response ->
            val payload = response.payload()
            if (!response.isSuccessful) throw response.error(payload)
            val user = parseUser(payload)
            val token = sequenceOf("token", "sessionToken", "accessToken")
                .mapNotNull { normalizeRoomAuthToken(payload.optString(it)) }
                .firstOrNull()
                ?: sessionTokenFromCookies(response.headers)
                ?: throw RoomAuthException("The server did not return a session.", response.code)
            RoomAuthSession(user, token)
        }, callback)
    }

    fun currentUser(
        roomEndpoint: String,
        token: String,
        callback: (Result<RoomAccountUser?>) -> Unit,
    ): Call {
        val url = requestFor(roomEndpoint, "/api/auth/me")
            ?: return failedCall("Enter a valid RoomSound WebSocket endpoint.", callback)
        val normalizedToken = normalizeRoomAuthToken(token)
            ?: return failedCall("The saved RoomSound session is invalid.", callback)
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Authorization", bearerValue(normalizedToken))
            .get()
            .build()

        return enqueue(request, { response ->
            if (response.code == 401) return@enqueue null
            val payload = response.payload()
            if (!response.isSuccessful) throw response.error(payload)
            parseUser(payload)
        }, callback)
    }

    fun signOut(
        roomEndpoint: String,
        token: String,
        callback: (Result<Unit>) -> Unit,
    ): Call {
        val url = requestFor(roomEndpoint, "/api/auth/logout")
            ?: return failedCall("Enter a valid RoomSound WebSocket endpoint.", callback)
        val normalizedToken = normalizeRoomAuthToken(token)
            ?: return failedCall("The saved RoomSound session is invalid.", callback)
        val request = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("Authorization", bearerValue(normalizedToken))
            .post("".toRequestBody(null))
            .build()

        return enqueue(request, { response ->
            if (response.code == 401) return@enqueue Unit
            if (!response.isSuccessful) throw response.error(response.payload())
            Unit
        }, callback)
    }

    fun cancelAll() {
        httpClient.dispatcher.cancelAll()
    }

    private fun requestFor(roomEndpoint: String, path: String): HttpUrl? {
        val uri = runCatching { URI(roomEndpoint.trim()) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase()
        if (scheme !in setOf("ws", "wss") || uri.host.isNullOrBlank() ||
            uri.userInfo != null || uri.fragment != null || uri.port !in -1..65535
        ) return null
        val httpScheme = if (scheme == "wss") "https" else "http"
        return runCatching {
            HttpUrl.Builder()
                .scheme(httpScheme)
                .host(uri.host)
                .apply { if (uri.port >= 0) port(uri.port) }
                .addPathSegments(path.trimStart('/'))
                .build()
        }.getOrNull()
    }

    private fun <T> enqueue(
        request: Request,
        parse: (Response) -> T,
        callback: (Result<T>) -> Unit,
    ): Call {
        val delegate = httpClient.newCall(request)
        delegate.enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) {
                callback(Result.failure(RoomAuthException("RoomSound account access is unavailable.")))
            }

            override fun onResponse(call: Call, response: Response) {
                val result = runCatching { parse(response) }
                response.close()
                callback(result)
            }
        })
        return delegate
    }

    private fun <T> failedCall(message: String, callback: (Result<T>) -> Unit): Call {
        val call = httpClient.newCall(Request.Builder().url("http://127.0.0.1/").build())
        callback(Result.failure(RoomAuthException(message)))
        call.cancel()
        return call
    }

    private fun Response.payload(): JSONObject =
        JSONObject(body?.string().orEmpty().ifBlank { "{}" })

    private fun Response.error(payload: JSONObject): RoomAuthException {
        val fallback = when (code) {
            400 -> "Enter a valid email and password."
            401 -> "Invalid email or password."
            409 -> "An account with that email already exists."
            429 -> "Too many attempts. Try again later."
            else -> "Account request could not be completed."
        }
        val message = payload.optString("error").trim().takeIf { it.isNotEmpty() } ?: fallback
        return RoomAuthException(message.take(MAX_ERROR_MESSAGE_LENGTH), code)
    }

    private fun parseUser(payload: JSONObject): RoomAccountUser {
        val user = payload.optJSONObject("user") ?: throw RoomAuthException("The server returned an incomplete account.")
        val id = user.optString("id").trim()
        val email = user.optString("email").trim()
        if (id.isEmpty() || email.isEmpty()) throw RoomAuthException("The server returned an incomplete account.")
        return RoomAccountUser(
            id = id,
            email = email,
            isAdmin = user.optBoolean("isAdmin", false),
            createdAt = user.optString("createdAt").trim().takeIf { it.isNotEmpty() },
        )
    }

    private fun sessionTokenFromCookies(headers: Headers): String? = headers.values("Set-Cookie")
        .asSequence()
        .mapNotNull { cookie ->
            val first = cookie.substringBefore(';')
            val separator = first.indexOf('=')
            if (separator <= 0) return@mapNotNull null
            if (first.substring(0, separator).trim() != SESSION_COOKIE_NAME) return@mapNotNull null
            val encoded = first.substring(separator + 1).trim()
            if (encoded.isEmpty()) return@mapNotNull null
            runCatching { URLDecoder.decode(encoded, StandardCharsets.UTF_8.name()) }
                .getOrNull()
                ?.let(::normalizeRoomAuthToken)
        }
        .firstOrNull()

    private fun bearerValue(token: String): String {
        require(token.isNotBlank() && token.length <= MAX_TOKEN_LENGTH) { "Invalid session token." }
        return "Bearer $token"
    }

    private companion object {
        const val SESSION_COOKIE_NAME = "roomsound_session"
        const val MAX_TOKEN_LENGTH = MAX_ROOM_AUTH_TOKEN_LENGTH
        const val MAX_ERROR_MESSAGE_LENGTH = 180
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .callTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
