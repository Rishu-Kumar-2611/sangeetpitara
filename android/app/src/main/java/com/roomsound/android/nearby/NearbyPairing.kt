package com.roomsound.android.nearby

import okhttp3.OkHttpClient
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** A private IPv4 endpoint and its exact certificate, carried in the local invite. */
data class NearbyPairing(val host: String, val port: Int, val invite: String, val code: String, val fingerprint: String) {
    val endpoint get() = "wss://$host:$port/?invite=$invite"
    fun reconnectSecret(master: String): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(master.toByteArray(Charsets.UTF_8),"HmacSHA256"))
        return mac.doFinal("$endpoint:$fingerprint".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
    fun client(): OkHttpClient {
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("Client trust is not configured") }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("Missing nearby certificate")
                leaf.checkValidity()
                if (digest(leaf) != fingerprint) throw CertificateException("Nearby host certificate changed. Ask for a fresh invite.")
            }
        }
        val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory, trust)
            // This private-address connection is authenticated by the invite's
            // exact certificate instead of a public DNS certificate authority.
            .hostnameVerifier { hostname, session -> hostname == host &&
                runCatching { digest(session.peerCertificates.first() as X509Certificate) == fingerprint }.getOrDefault(false) }
            .followRedirects(false).followSslRedirects(false).writeTimeout(30,TimeUnit.SECONDS).build()
    }
    companion object {
        fun digest(cert: X509Certificate): String = MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
        fun parse(raw: String): NearbyPairing {
            val uri = URI(raw.trim())
            require(uri.scheme == "http" && uri.userInfo == null && uri.rawQuery == null && uri.path in listOf("", "/")) { "Paste the complete local invite" }
            val host = requireNotNull(uri.host) { "Missing local address" }
            val octets = host.split('.').map { it.toIntOrNull() ?: -1 }
            require(octets.size == 4 && octets.all { it in 0..255 } &&
                (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && octets[1] in 16..31))) { "Use a private hotspot/Wi-Fi address" }
            val params = uri.rawFragment.orEmpty().split('&').associate { item ->
                val parts = item.split('=',limit=2); URLDecoder.decode(parts[0],"UTF-8") to URLDecoder.decode(parts.getOrElse(1){""},"UTF-8")
            }
            val invite = params["invite"].orEmpty(); val code = params["code"].orEmpty()
            val pin = params["pin"].orEmpty(); val port = params["tls"].orEmpty().toIntOrNull() ?: 0
            require(invite.matches(Regex("[a-f0-9-]{36}")) && code.matches(Regex("[A-Z2-9]{6}")) && pin.matches(Regex("[a-f0-9]{64}")) && port in 1024..65535) { "Ask the host to update the app and copy a fresh invite" }
            return NearbyPairing(host,port,invite,code,pin)
        }
    }
}
