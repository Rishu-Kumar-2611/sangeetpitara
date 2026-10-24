package com.roomsound.android.update

import java.net.HttpURLConnection
import java.net.URL

/** A newer GitHub Release than the installed app, with its installable APK. */
data class AvailableUpdate(val tag: String, val apkUrl: String)

/** Pure version logic, kept free of Android and network APIs for JVM tests. */
internal object ReleaseVersion {
    private val pattern = Regex("""^v?(\d+)\.(\d+)\.(\d+)$""")
    private val tagName = Regex(""""tag_name"\s*:\s*"([^"\\]+)"""")

    fun parse(value: String): List<Int>? =
        pattern.matchEntire(value.trim())?.groupValues?.drop(1)?.map { it.toIntOrNull() ?: return null }

    /** True only when both versions parse and [candidate] is strictly newer. */
    fun isNewer(candidate: String, installed: String): Boolean {
        val next = parse(candidate) ?: return false
        val current = parse(installed) ?: return false
        for (index in 0..2) if (next[index] != current[index]) return next[index] > current[index]
        return false
    }

    /** Reads `tag_name` from a GitHub `releases/latest` response. */
    fun latestTag(json: String): String? = tagName.find(json)?.groupValues?.get(1)
}

/**
 * Asks GitHub for the latest published release. `releases/latest` already
 * excludes drafts and pre-releases. Every failure (offline, rate limit, a
 * repository without releases) is silent: the notice is optional.
 */
class ReleaseUpdateChecker(
    private val repository: String,
    private val installedVersion: String,
    private val fetch: (String) -> String? = ::httpGet,
) {
    fun check(): AvailableUpdate? {
        val json = runCatching { fetch("https://api.github.com/repos/$repository/releases/latest") }.getOrNull()
            ?: return null
        val tag = ReleaseVersion.latestTag(json) ?: return null
        if (!ReleaseVersion.isNewer(tag, installedVersion)) return null
        return AvailableUpdate(tag, "https://github.com/$repository/releases/latest/download/$APK_NAME")
    }

    companion object {
        /** Fixed asset name published by .github/workflows/release.yml. */
        const val APK_NAME = "SangeetPitara.apk"
        private const val TIMEOUT_MS = 5_000
        private const val MAX_RESPONSE_BYTES = 256 * 1024

        private fun httpGet(url: String): String? {
            val connection = URL(url).openConnection() as HttpURLConnection
            return try {
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                connection.setRequestProperty("Accept", "application/vnd.github+json")
                connection.setRequestProperty("User-Agent", "SangeetPitara-Android")
                if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
                connection.inputStream.use { input ->
                    // InputStream.readNBytes needs API 33; minSdk is 29.
                    val buffer = ByteArray(MAX_RESPONSE_BYTES)
                    var length = 0
                    while (length < buffer.size) {
                        val read = input.read(buffer, length, buffer.size - length)
                        if (read < 0) break
                        length += read
                    }
                    String(buffer, 0, length, Charsets.UTF_8)
                }
            } finally {
                connection.disconnect()
            }
        }
    }
}
