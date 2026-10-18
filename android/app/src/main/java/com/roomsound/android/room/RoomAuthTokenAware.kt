package com.roomsound.android.room

/**
 * Authentication hand-off between the service-owned coordinator and the
 * signaling client.
 *
 * The coordinator never reads or logs the token after handing it to the
 * client. Implementations should apply the value to new WebSocket/HTTP
 * requests as an Authorization bearer token. A null value removes the token
 * for subsequent requests.
 */
interface RoomAuthTokenAware {
    fun setBearerToken(token: String?)
}
