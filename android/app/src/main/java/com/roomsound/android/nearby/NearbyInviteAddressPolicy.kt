package com.roomsound.android.nearby

/** Prefer hotspot/Wi-Fi addresses; never offer cellular or VPN-only interfaces. */
object NearbyInviteAddressPolicy {
    fun usable(interfaceName: String): Boolean {
        val name = interfaceName.lowercase()
        return listOf("rmnet", "v4-rmnet", "ccmni", "pdp", "wwan", "tun", "ipsec", "seth", "clat").none(name::startsWith)
    }
    fun priority(interfaceName: String): Int {
        val name = interfaceName.lowercase()
        return when {
            name.startsWith("ap") || name.startsWith("softap") || name.startsWith("swlan") -> 0
            name.contains("wlan") || name.startsWith("wifi") -> 1
            name.startsWith("eth") -> 2
            else -> 3
        }
    }
}
