package com.roomsound.android.nearby
import org.junit.Assert.*
import org.junit.Test
class NearbyInviteAddressPolicyTest {
    @Test fun ignoresCellularAndVpnButKeepsLocalAdapters() {
        listOf("rmnet_data0","v4-rmnet_data0","ccmni0","pdp_ip0","wwan0","tun0","ipsec0","seth_lte0").forEach { assertFalse(it,NearbyInviteAddressPolicy.usable(it)) }
        listOf("ap0","swlan0","wlan0","wlan1","softap0","eth0").forEach { assertTrue(it,NearbyInviteAddressPolicy.usable(it)) }
    }
    @Test fun hotspotAddressAppearsBeforeRouterAddress() {
        val names=listOf("eth0","wlan0","ap0").sortedBy(NearbyInviteAddressPolicy::priority)
        assertEquals(listOf("ap0","wlan0","eth0"),names)
    }
}
