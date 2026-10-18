package com.roomsound.android.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small Keystore-backed store for the RoomSound bearer session.
 *
 * The Android Keystore owns the AES key. SharedPreferences only contains the
 * random GCM IV and ciphertext; the raw session token is never persisted as a
 * preference value. This class deliberately exposes no diagnostic data that
 * could include the token.
 */
class EncryptedSessionStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun readToken(): String? {
        val encodedCiphertext = preferences.getString(CIPHERTEXT_KEY, null) ?: return null
        val encodedIv = preferences.getString(IV_KEY, null) ?: return null
        return runCatching {
            val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
            val ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP)
            if (iv.isEmpty() || ciphertext.isEmpty()) return@runCatching null
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            normalizeRoomAuthToken(cipher.doFinal(ciphertext).toString(StandardCharsets.UTF_8))
                ?: throw IllegalStateException("Invalid encrypted RoomSound session.")
        }.getOrElse {
            // A stale/corrupt ciphertext must not prevent a future sign-in.
            clear()
            null
        }
    }

    @Synchronized
    fun saveToken(token: String) {
        val normalizedToken = normalizeRoomAuthToken(token)
            ?: throw IllegalArgumentException("Invalid session token.")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(normalizedToken.toByteArray(StandardCharsets.UTF_8))
        val iv = cipher.iv
        check(preferences.edit()
            .putString(IV_KEY, Base64.encodeToString(iv, Base64.NO_WRAP))
            .putString(CIPHERTEXT_KEY, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .commit()
        ) { "Could not persist the RoomSound session." }
    }

    @Synchronized
    fun clear() {
        preferences.edit().remove(IV_KEY).remove(CIPHERTEXT_KEY).commit()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "roomsound.auth.session.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val PREFERENCES_NAME = "roomsound_auth_session"
        const val IV_KEY = "session_iv"
        const val CIPHERTEXT_KEY = "session_ciphertext"
    }
}
