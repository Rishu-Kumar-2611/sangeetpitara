package com.roomsound.android.room

/** Selects the endpoint embedded into an APK, with safe public/local fallbacks. */
object RoomEndpointBootstrap {
    const val EMULATOR_FALLBACK_ENDPOINT = "ws://10.0.2.2:4173"
    const val PUBLIC_FALLBACK_ENDPOINT = "wss://sangeet-pitaraa.onrender.com"

    /**
     * A non-empty build-time value always wins, including an invalid value so
     * configuration mistakes are reported instead of silently using a fallback.
     * The public fallback keeps a downloaded APK usable when a build
     * environment omitted the endpoint property; LAN/staging builds should
     * still pass ROOMSOUND_DEFAULT_ENDPOINT explicitly.
     */
    fun selectEndpoint(
        configuredEndpoint: String?,
        isDebugBuild: Boolean,
        isEmulator: Boolean,
    ): String? {
        val configured = configuredEndpoint?.trim().orEmpty()
        if (configured.isNotEmpty()) return configured
        if (isDebugBuild && isEmulator) return EMULATOR_FALLBACK_ENDPOINT
        return PUBLIC_FALLBACK_ENDPOINT
    }
}
