package com.roomsound.android.room

/** Selects the endpoint embedded into an APK, with the debug-emulator fallback. */
object RoomEndpointBootstrap {
    const val EMULATOR_FALLBACK_ENDPOINT = "ws://10.0.2.2:4173"

    /**
     * A non-empty build-time value always wins, including an invalid value so
     * configuration mistakes are reported instead of silently using a fallback.
     */
    fun selectEndpoint(
        configuredEndpoint: String?,
        isDebugBuild: Boolean,
        isEmulator: Boolean,
    ): String? {
        val configured = configuredEndpoint?.trim().orEmpty()
        if (configured.isNotEmpty()) return configured
        return EMULATOR_FALLBACK_ENDPOINT.takeIf { isDebugBuild && isEmulator }
    }
}
