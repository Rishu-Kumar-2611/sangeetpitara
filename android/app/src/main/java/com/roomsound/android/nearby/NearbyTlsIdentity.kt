package com.roomsound.android.nearby

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocketFactory
import javax.security.auth.x500.X500Principal

/** The private signing key stays in Android Keystore, never in an invitation. */
class NearbyTlsIdentity {
    val factory: SSLServerSocketFactory
    val fingerprint: String
    val certificatePem: String
    init {
        val alias = "sangeetpitara-nearby-tls-v1"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getCertificate(alias) as? X509Certificate
        if (existing == null || existing.notAfter.time < System.currentTimeMillis() + 86_400_000L) {
            if (store.containsAlias(alias)) store.deleteEntry(alias)
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA,"AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setKeySize(2048).setDigests(KeyProperties.DIGEST_SHA256,KeyProperties.DIGEST_SHA384,KeyProperties.DIGEST_SHA512)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1,KeyProperties.SIGNATURE_PADDING_RSA_PSS)
                    .setCertificateSubject(X500Principal("CN=SangeetPitara Nearby"))
                    .setCertificateSerialNumber(BigInteger.valueOf(System.currentTimeMillis()))
                    .setCertificateNotBefore(Date(System.currentTimeMillis()-86_400_000L))
                    .setCertificateNotAfter(Date(System.currentTimeMillis()+315_360_000_000L)).build())
                generateKeyPair()
            }
        }
        fingerprint = NearbyPairing.digest(store.getCertificate(alias) as X509Certificate)
        certificatePem = "-----BEGIN CERTIFICATE-----\n" + java.util.Base64.getMimeEncoder(64,byteArrayOf(10)).encodeToString(store.getCertificate(alias).encoded) + "\n-----END CERTIFICATE-----\n"
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store,null) }
        factory = SSLContext.getInstance("TLS").apply { init(managers.keyManagers,null,null) }.serverSocketFactory
    }
}
