package com.roomsound.android.room

import org.json.JSONObject
import java.util.Base64

/** The same bounded, ephemeral chat contract as the internet room server. */
object ChatContent {
    const val MAX_VOICE_BYTES = 512 * 1024
    const val MAX_DURATION_MS = 30_000
    fun voice(input: JSONObject): JSONObject {
        val mime = input.optString("mimeType").lowercase().replace(" ", "")
        require(mime in setOf("audio/webm", "audio/webm;codecs=opus", "audio/ogg", "audio/ogg;codecs=opus", "audio/mp4")) { "Unsupported recording format." }
        val data = input.optString("data")
        require(data.length <= ((MAX_VOICE_BYTES + 2) / 3) * 4 && data.length % 4 == 0 && data.matches(Regex("[A-Za-z0-9+/]+={0,2}"))) { "Recording is too large or invalid." }
        val bytes = Base64.getDecoder().decode(data)
        require(bytes.size in 12..MAX_VOICE_BYTES && Base64.getEncoder().encodeToString(bytes) == data) { "Invalid recording data." }
        val duration = input.optDouble("durationMs", Double.NaN)
        require(duration.isFinite() && duration >= 200 && duration <= MAX_DURATION_MS) { "Record between 1 and 30 seconds." }
        val valid = when {
            mime.startsWith("audio/webm") -> bytes.take(4).map { it.toInt() and 255 } == listOf(0x1a, 0x45, 0xdf, 0xa3)
            mime.startsWith("audio/ogg") -> String(bytes, 0, 4, Charsets.US_ASCII) == "OggS"
            else -> String(bytes, 4, 4, Charsets.US_ASCII) == "ftyp"
        }
        require(valid) { "Recording format does not match its content." }
        return JSONObject().put("mimeType", mime).put("durationMs", duration.toLong()).put("data", data)
    }
    fun build(input: JSONObject, history: List<JSONObject>): JSONObject {
        val text = input.optString("text").replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim().take(280)
        val voice = input.optJSONObject("voice")?.let(::voice)
        require(text.isNotEmpty() || voice != null) { "Write a message or record a voice note." }
        val result = JSONObject().put("text", text.ifEmpty { "Voice message" })
        if (voice != null) result.put("voice", voice)
        if (input.has("replyToId")) {
            val target = history.find { it.optString("id") == input.optString("replyToId") && it.optString("kind") == "chat" }
                ?: throw IllegalArgumentException("The original message is no longer in this room history.")
            result.put("replyTo", JSONObject().put("id", target.optString("id")).put("senderName", target.optString("senderName")).put("text", if (target.has("voice")) "Voice message" else target.optString("text").take(160)))
        }
        val clientId = input.optString("clientMessageId")
        if (clientId.matches(Regex("[a-zA-Z0-9-]{1,80}"))) result.put("clientMessageId", clientId)
        return result
    }
    fun snapshot(message: JSONObject, includeVoiceData: Boolean): JSONObject {
        val voice = message.optJSONObject("voice")
        if (includeVoiceData || voice == null || !voice.has("data")) return message
        val result = JSONObject()
        val keys = message.keys()
        while (keys.hasNext()) { val key = keys.next(); if (key != "voice") result.put(key, message.get(key)) }
        result.put("voice", JSONObject().put("mimeType",voice.optString("mimeType")).put("durationMs",voice.optLong("durationMs")).put("referenceOnly",true))
        return result
    }
    fun bound(history: List<JSONObject>): List<JSONObject> {
        var bytes = history.sumOf { it.optJSONObject("voice")?.optString("data")?.length ?: 0 }
        val expired = mutableListOf<JSONObject>()
        for (message in history) {
            if (bytes <= (512 * 1024 / 3) * 4) break
            val voice = message.optJSONObject("voice") ?: continue
            val data = voice.optString("data")
            if (data.isEmpty()) continue
            bytes -= data.length; voice.remove("data"); voice.put("unavailable", true); expired.add(message)
        }
        return expired
    }
}
