package com.roomsound.android.capture

/** A web moderator may grant generic playback; Android upgrades it on start. */
internal object DeviceCaptureGrantPolicy {
    fun ownsSlot(selfId: String?, sourceId: String?, sourceType: String?, status: String): Boolean =
        selfId != null && selfId == sourceId &&
            sourceType in setOf("DEVICE_AUDIO", "ANDROID_DEVICE_AUDIO") &&
            status in setOf("STARTING", "LIVE")
}
