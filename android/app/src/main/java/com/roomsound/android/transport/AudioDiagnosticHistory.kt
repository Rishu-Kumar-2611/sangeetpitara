package com.roomsound.android.transport

/** Local numeric telemetry only. Never accepts free-form strings or identities. */
class AudioDiagnosticHistory(private val clock: () -> Long = System::currentTimeMillis) {
    private val allowed = setOf("sentPackets", "receivedPackets", "missingPackets", "underruns", "bufferMs", "targetMs", "jitterMs", "packetAgeMs", "queueMs", "epoch")
    private val samples = ArrayDeque<Map<String, Any>>()
    private val events = ArrayDeque<Map<String, Any>>()
    private var previous: Map<String, Any>? = null
    private var lastSample = Long.MIN_VALUE

    @Synchronized
    fun record(values: Map<String, Number?>, direction: String, connection: String, output: String, mode: String) {
        val now = clock()
        val sample = linkedMapOf<String, Any>("at" to now)
        for ((key, value) in values) {
            val number = value?.toDouble() ?: continue
            if (key in allowed && number.isFinite() && number >= 0) sample[key] = number.coerceAtMost(1e12)
        }
        sample["direction"] = direction.takeIf { it in setOf("sender", "listener", "idle") } ?: "idle"
        sample["connection"] = connection.takeIf { it in setOf("connected", "connecting", "offline") } ?: "offline"
        sample["output"] = output.takeIf { it in setOf("running", "suspended", "closed", "unavailable") } ?: "unavailable"
        sample["mode"] = if (mode == "nearby") "nearby" else "internet"
        val old = previous
        fun event(type: String) {
            events.addLast(mapOf("at" to now, "type" to type))
            while (events.size > 120) events.removeFirst()
        }
        if (old == null) event("started") else {
            if (old["connection"] != sample["connection"]) event("connection_changed")
            if (old["epoch"] != sample["epoch"] || old["direction"] != sample["direction"]) event("source_changed")
            if (old["output"] != sample["output"]) event("output_changed")
            for ((key, type) in listOf("underruns" to "underrun", "missingPackets" to "sequence_gap")) {
                if ((sample[key] as? Double ?: 0.0) > (old[key] as? Double ?: 0.0)) event(type)
            }
        }
        previous = sample
        if (lastSample == Long.MIN_VALUE || now - lastSample >= 1000 || now < lastSample) {
            samples.addLast(sample)
            lastSample = now
            while (samples.size > 300) samples.removeFirst()
        }
    }

    @Synchronized
    fun export(version: String): String {
        fun json(record: Map<String, Any>) = record.entries.joinToString(",", "{", "}") { (key, value) ->
            "\"$key\":" + if (value is Number) value.toString() else "\"$value\""
        }
        val safeVersion = version.takeIf { it.length <= 24 && it.matches(Regex("\\d+\\.\\d+\\.\\d+")) } ?: "development"
        return "{\"schemaVersion\":1,\"platform\":\"android\",\"version\":\"$safeVersion\",\"generatedAt\":\"${java.time.Instant.ofEpochMilli(clock())}\",\"privacy\":\"Local numeric measurements only; no audio, identities, chat, invites, IPs or credentials.\",\"limitations\":\"End-to-end delay and acoustic fidelity are not measured.\",\"samples\":${samples.joinToString(",", "[", "]", transform = ::json)},\"events\":${events.joinToString(",", "[", "]", transform = ::json)}}"
    }
}
