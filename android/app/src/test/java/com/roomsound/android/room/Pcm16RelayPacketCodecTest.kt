package com.roomsound.android.room

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class Pcm16RelayPacketCodecTest {
    @Test
    fun encodesAndDecodesTheDocumentedLittleEndianHeader() {
        val encoded = Pcm16RelayPacketCodec.encode(
            samples = shortArrayOf(Short.MIN_VALUE, Short.MAX_VALUE),
            sourceEpoch = 0x0102_0304L,
            sequence = 0xA0B0_C0D0L,
        )

        assertArrayEquals(
            byteArrayOf(
                0x52, 0x53, 0x52, 0x31,
                0x01, 0x01,
                0x80.toByte(), 0xBB.toByte(), 0x00, 0x00,
                0x04, 0x03, 0x02, 0x01,
                0xD0.toByte(), 0xC0.toByte(), 0xB0.toByte(), 0xA0.toByte(),
                0x02, 0x00,
                0x00, 0x80.toByte(), 0xFF.toByte(), 0x7F,
            ),
            encoded,
        )

        val decoded = Pcm16RelayPacketCodec.decode(encoded)
        assertEquals(48_000, decoded.sampleRate)
        assertEquals(1, decoded.channels)
        assertEquals(0x0102_0304L, decoded.sourceEpoch)
        assertEquals(0xA0B0_C0D0L, decoded.sequence)
        assertEquals(2, decoded.sampleCount)
        assertArrayEquals(shortArrayOf(Short.MIN_VALUE, Short.MAX_VALUE), decoded.samples)
        assertArrayEquals(encoded.copyOfRange(20, encoded.size), decoded.payload)
    }

    @Test
    fun rejectsMalformedAndOutOfBoundsFrames() {
        assertThrows(IllegalArgumentException::class.java) {
            Pcm16RelayPacketCodec.decode(ByteArray(Pcm16RelayPacketCodec.HEADER_BYTES - 1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            Pcm16RelayPacketCodec.encode(shortArrayOf(1), sourceEpoch = 0x1_0000_0000L, sequence = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            Pcm16RelayPacketCodec.encode(
                samples = ShortArray(Pcm16RelayPacketCodec.MAX_PAYLOAD_BYTES / 2 + 1),
                sourceEpoch = 0,
                sequence = 0,
            )
        }

        val badMagic = Pcm16RelayPacketCodec.encode(shortArrayOf(1), sourceEpoch = 1, sequence = 2)
            .also { it[0] = 0 }
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.decode(badMagic) }

        val badLength = Pcm16RelayPacketCodec.encode(shortArrayOf(1), sourceEpoch = 1, sequence = 2)
            .copyOf()
            .also { it[18] = 2 }
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.decode(badLength) }
    }

    @Test
    fun maxPayloadIsAcceptedButAHigherBoundIsRejected() {
        val samples = ShortArray(Pcm16RelayPacketCodec.MAX_PAYLOAD_BYTES / 2) { it.toShort() }
        val encoded = Pcm16RelayPacketCodec.encode(samples, sourceEpoch = 7, sequence = 8)
        assertEquals(Pcm16RelayPacketCodec.MAX_FRAME_BYTES, encoded.size)
        assertEquals(samples.size, Pcm16RelayPacketCodec.decode(encoded).sampleCount)
        assertTrue(encoded.size <= Pcm16RelayPacketCodec.MAX_FRAME_BYTES)

        val overLimit = ByteBuffer.allocate(Pcm16RelayPacketCodec.MAX_FRAME_BYTES + 2)
            .order(ByteOrder.LITTLE_ENDIAN)
            .array()
        overLimit[0] = 0x52
        overLimit[1] = 0x53
        overLimit[2] = 0x52
        overLimit[3] = 0x31
        overLimit[4] = 1
        overLimit[5] = 1
        overLimit[6] = 0x80.toByte()
        overLimit[7] = 0xBB.toByte()
        overLimit[18] = 0
        overLimit[19] = 0x80.toByte()
        assertThrows(IllegalArgumentException::class.java) { Pcm16RelayPacketCodec.decode(overLimit) }
    }

    @Test
    fun playoutBoundAcceptsCurrentProducerFramesAndRejectsLongBacklogFrames() {
        val browserFrame = Pcm16RelayPacketCodec.encode(
            ShortArray(Pcm16RelayPacketCodec.MAX_PLAYOUT_PAYLOAD_BYTES / 2),
            sourceEpoch = 1,
            sequence = 2,
        )
        assertEquals(
            Pcm16RelayPacketCodec.MAX_PLAYOUT_PAYLOAD_BYTES / 2,
            Pcm16RelayPacketCodec.decode(
                browserFrame,
                maxPayloadBytes = Pcm16RelayPacketCodec.MAX_PLAYOUT_PAYLOAD_BYTES,
            ).sampleCount,
        )

        val oversized = Pcm16RelayPacketCodec.encode(
            ShortArray(Pcm16RelayPacketCodec.MAX_PLAYOUT_PAYLOAD_BYTES / 2 + 1),
            sourceEpoch = 1,
            sequence = 3,
        )
        assertThrows(IllegalArgumentException::class.java) {
            Pcm16RelayPacketCodec.decode(
                oversized,
                maxPayloadBytes = Pcm16RelayPacketCodec.MAX_PLAYOUT_PAYLOAD_BYTES,
            )
        }
    }
}
