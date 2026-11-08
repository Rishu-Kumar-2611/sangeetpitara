package com.roomsound.android.room

import com.roomsound.android.transport.opusPacketSampleCount
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OpusRelayFrameTest {
    private val packet = byteArrayOf(0xFC.toByte(), 0x11, 0x22, 0x33)

    @Test fun opusFramesRoundTripAndPassTheSendGate() {
        val frame = Pcm16RelayPacketCodec.encodeOpus(packet, opusPacketSampleCount(packet), sourceEpoch = 5, sequence = 42)
        assertEquals(Pcm16RelayPacketCodec.VERSION_OPUS, Pcm16RelayPacketCodec.frameVersion(frame))
        assertEquals(5L, Pcm16RelayPacketCodec.peekSourceEpoch(frame))
        val decoded = Pcm16RelayPacketCodec.decodeOpus(frame)
        assertEquals(5L, decoded.sourceEpoch)
        assertEquals(42L, decoded.sequence)
        assertEquals(960, decoded.sampleCount)
        assertArrayEquals(packet, decoded.payload)
    }

    @Test fun malformedOpusFramesAreRejected() {
        val frame = Pcm16RelayPacketCodec.encodeOpus(packet, 960, sourceEpoch = 1, sequence = 1).toByteArray()
        val stereo = frame.copyOf().also { it[5] = 2 }
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.decodeOpus(okio.ByteString.of(*stereo)) }
        val oddCount = frame.copyOf().also { it[18] = 0xC1.toByte(); it[19] = 0x03 } // 961
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.decodeOpus(okio.ByteString.of(*oddCount)) }
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.encodeOpus(ByteArray(5_000), 960, 1, 1) }
    }

    @Test fun tocParsingMatchesTheServer() {
        assertEquals(960, opusPacketSampleCount(byteArrayOf(0x08)))
        assertEquals(960, opusPacketSampleCount(byteArrayOf(0x78)))
        assertEquals(120, opusPacketSampleCount(byteArrayOf(0xE0.toByte())))
        assertEquals(1920, opusPacketSampleCount(byteArrayOf(0xFD.toByte())))
        assertEquals(2880, opusPacketSampleCount(byteArrayOf(0xFF.toByte(), 0x03)))
        assertEquals(0, opusPacketSampleCount(byteArrayOf(0xFF.toByte(), 0x07)))
    }

    @Test fun roomAndServerConfigCarryTheNegotiatedCodec() {
        val room = JSONObject().put("id", "r").put("code", "K7QM4PZT")
        assertEquals("pcm16", parseRoomSummary(room).relayCodec)
        assertEquals("opus", parseRoomSummary(room.put("relayCodec", "opus")).relayCodec)

        val legacy = parseMediaRelayConfig(JSONObject().put("mediaRelay", JSONObject().put("mode", "pcm16")))
        assertFalse(legacy.opus)
        val modern = parseMediaRelayConfig(JSONObject().put("mediaRelay", JSONObject()
            .put("mode", "pcm16").put("codecs", JSONArray(listOf("pcm16", "opus"))).put("opusBitrate", 500_000)))
        assertTrue(modern.opus)
        assertEquals(128_000, modern.opusBitrate)
    }
}
