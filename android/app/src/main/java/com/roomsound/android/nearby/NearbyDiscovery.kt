package com.roomsound.android.nearby

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import java.io.Closeable
import java.util.ArrayDeque

/** Local mDNS only. No cloud directory, LAN scanning or location permission. */
@Suppress("DEPRECATION")
class NearbyDiscovery(context: Context) : Closeable {
    private val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var multicast: WifiManager.MulticastLock? = null
    private var registration: NsdManager.RegistrationListener? = null
    private var discovery: NsdManager.DiscoveryListener? = null
    private val pending = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var generation = 0
    private fun lock() {
        if (multicast == null) multicast = wifi.createMulticastLock("SangeetPitara-nearby").apply { setReferenceCounted(false); acquire() }
    }
    fun advertise(host: NearbyRoomHost, pin: String, failure: (String) -> Unit) {
        close()
        lock()
        val attempt = generation
        val info = NsdServiceInfo().apply {
            serviceName = "SangeetPitara-${host.roomCode}"
            serviceType = TYPE
            port = host.listeningPort
            setAttribute("code", host.roomCode)
            setAttribute("invite", host.invite)
            setAttribute("pin", pin)
            setAttribute("tls", requireNotNull(host.securePort).toString())
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = Unit
            override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) { main.post { if (generation == attempt) { failure("Automatic discovery unavailable. Friends can use the fallback invite."); close() } } }
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) = Unit
        }
        registration = listener
        manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }
    fun find(code: String, result: (Result<String>) -> Unit) {
        require(code.matches(Regex("[A-Z2-9]{6}"))) { "Enter the host's six-character nearby code." }
        close()
        lock()
        val attempt = generation
        fun finish(value: Result<String>) {
            if (generation != attempt) return
            close()
            result(value)
        }
        fun resolveNext() {
            if (resolving || pending.isEmpty() || generation != attempt) return
            resolving = true
            runCatching { manager.resolveService(pending.removeFirst(), object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, error: Int) { main.post { if (generation == attempt) { resolving = false; resolveNext() } } }
                override fun onServiceResolved(info: NsdServiceInfo) { main.post {
                    if (generation != attempt) return@post
                    resolving = false
                    val attrs = info.attributes.mapValues { String(it.value, Charsets.UTF_8) }
                    if (attrs["code"] == code) {
                        val link = "http://${info.host?.hostAddress}:${info.port}/#invite=${attrs["invite"]}&code=$code&tls=${attrs["tls"]}&pin=${attrs["pin"]}"
                        // Treat all LAN advertisements as untrusted input.
                        val parsed = runCatching { NearbyPairing.parse(link); link }
                        if (parsed.isSuccess) { finish(parsed); return@post }
                    }
                    resolveNext()
                } }
            }) }.onFailure { finish(Result.failure(IllegalStateException("Could not resolve this nearby room. Try the fallback invite."))) }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(type: String) = Unit
            override fun onServiceFound(info: NsdServiceInfo) { main.post {
                if (generation == attempt && info.serviceName.startsWith("SangeetPitara-$code") && pending.size < 8) { pending.add(info); resolveNext() }
            } }
            override fun onServiceLost(info: NsdServiceInfo) = Unit
            override fun onDiscoveryStopped(type: String) = Unit
            override fun onStartDiscoveryFailed(type: String, error: Int) { main.post { finish(Result.failure(IllegalStateException("Could not search this Wi-Fi. Use the fallback invite."))) } }
            override fun onStopDiscoveryFailed(type: String, error: Int) = Unit
        }
        discovery = listener
        manager.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        main.postDelayed({ finish(Result.failure(IllegalStateException("Room not found. Connect to the host's hotspot or the same Wi-Fi and retry. If this network blocks discovery, use the fallback invite."))) }, 12_000)
    }
    override fun close() {
        generation++
        discovery?.let { runCatching { manager.stopServiceDiscovery(it) } }; discovery = null
        registration?.let { runCatching { manager.unregisterService(it) } }; registration = null
        multicast?.let { if (it.isHeld) it.release() }; multicast = null
        pending.clear(); resolving = false
    }
    companion object { const val TYPE = "_sangeetpitara._tcp." }
}
