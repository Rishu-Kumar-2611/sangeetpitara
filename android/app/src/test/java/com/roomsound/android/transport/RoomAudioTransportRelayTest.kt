package com.roomsound.android.transport

import com.roomsound.android.room.Pcm16RelayPacketCodec
import com.roomsound.android.room.RoomEndpointValidator
import com.roomsound.android.room.RoomMember
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomSoundWebSocketClient
import com.roomsound.android.room.RoomState
import com.roomsound.android.room.RoomSummary
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomAudioTransportRelayTest {
    @Test
    fun senderFramesRespectAuthorizationLiveStateAndEpochChanges() {
        val client = RoomSoundWebSocketClient(RoomEndpointValidator.normalize("ws://localhost")!!)
        val publisher = RecordingPublisher()
        val transport = RoomAudioTransport(client, publisher)
        try {
            transport.onEvent(RoomSoundEvent.State(state(selfId = "listener", activeSourceId = "source", epoch = 7)))
            transport.onFrame(shortArrayOf(1, 2), 2, 48_000, 1)
            assertEquals(0, publisher.published.size)

            transport.onEvent(RoomSoundEvent.State(state(selfId = "source", activeSourceId = "source", epoch = 7, status = "STARTING")))
            transport.onFrame(shortArrayOf(1, 2), 2, 48_000, 1)
            assertEquals(0, publisher.published.size)

            transport.onEvent(RoomSoundEvent.State(state(selfId = "source", activeSourceId = "source", epoch = 7)))
            transport.onFrame(shortArrayOf(1, 2), 2, 48_000, 1)
            assertEquals(1, publisher.published.size)
            assertEquals(7L, publisher.published.single().sourceEpoch)

            // A lower epoch cannot roll the transport back to an old lease.
            transport.onEvent(RoomSoundEvent.State(state(selfId = "source", activeSourceId = "source", epoch = 6)))
            transport.onFrame(shortArrayOf(3, 4), 2, 48_000, 1)
            assertEquals(2, publisher.published.size)
            assertEquals(7L, publisher.published.last().sourceEpoch)

            transport.onEvent(RoomSoundEvent.State(state(selfId = "source", activeSourceId = "other", epoch = 8)))
            transport.onFrame(shortArrayOf(5, 6), 2, 48_000, 1)
            assertEquals(2, publisher.published.size)
            assertEquals(2L, transport.snapshot().droppedUnauthorizedFrames)
        } finally {
            transport.close()
            client.close()
        }
    }

    @Test
    fun relayFramesPlayOnlyForDifferentLiveSourceAndMatchingEpoch() {
        val client = RoomSoundWebSocketClient(RoomEndpointValidator.normalize("ws://localhost")!!)
        val player = RecordingPlayer()
        val transport = RoomAudioTransport(client, RecordingPublisher(), player)
        try {
            transport.onEvent(RoomSoundEvent.State(state(selfId = "listener", activeSourceId = "source", epoch = 7)))
            val frame = Pcm16RelayPacketCodec.encode(shortArrayOf(-10, 10), sourceEpoch = 7, sequence = 1)
            transport.onBinaryFrame(ByteString.of(*frame))
            assertEquals(1, player.played.size)

            val stale = Pcm16RelayPacketCodec.encode(shortArrayOf(1), sourceEpoch = 6, sequence = 2)
            transport.onBinaryFrame(ByteString.of(*stale))
            assertEquals(1, player.played.size)

            transport.onEvent(RoomSoundEvent.State(state(selfId = "listener", activeSourceId = "listener", epoch = 8)))
            val selfFrame = Pcm16RelayPacketCodec.encode(shortArrayOf(2), sourceEpoch = 8, sequence = 3)
            transport.onBinaryFrame(ByteString.of(*selfFrame))
            assertEquals(1, player.played.size)

            transport.onBinaryFrame(ByteString.of(0, 1, 2))
            val snapshot = transport.snapshot()
            assertEquals(1L, snapshot.receivedRelayFrames)
            assertEquals(1L, snapshot.droppedRelayStaleEpochFrames)
            assertEquals(1L, snapshot.droppedRelayUnauthorizedFrames)
            assertEquals(1L, snapshot.droppedRelayMalformedFrames)
            assertTrue(player.startedEpochs.contains(7L))
        } finally {
            transport.close()
            client.close()
        }
    }

    private fun state(
        selfId: String,
        activeSourceId: String?,
        epoch: Long,
        status: String = "LIVE",
    ): RoomState {
        val self = RoomMember(selfId, selfId, selfId, "PARTICIPANT", true, selfId == activeSourceId, 0)
        return RoomState(
            room = RoomSummary(
                id = "room",
                code = "ROOM",
                name = "Room",
                status = "ACTIVE",
                hostId = "host",
                cohostId = null,
                activeSourceId = activeSourceId,
                activeSourceType = "ANDROID_DEVICE_AUDIO",
                sourceStatus = status,
                sourceEpoch = epoch,
                resumeSourceId = null,
                createdAt = 0,
            ),
            self = self,
            members = listOf(self),
            requests = emptyList(),
            messages = emptyList(),
        )
    }

    private class RecordingPublisher : Pcm16FramePublisher {
        val published = mutableListOf<Pcm16Frame>()
        override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean = true
        override fun publish(frame: Pcm16Frame): Pcm16PublishResult {
            published += frame
            return Pcm16PublishResult.PUBLISHED
        }
        override fun stop(sourceEpoch: Long) = Unit
    }

    private class RecordingPlayer : Pcm16RelayPlayerSink {
        val startedEpochs = mutableListOf<Long>()
        val played = mutableListOf<com.roomsound.android.room.Pcm16RelayPacket>()
        private var epoch: Long? = null
        override fun start(format: Pcm16AudioFormat, sourceEpoch: Long): Boolean {
            startedEpochs += sourceEpoch
            epoch = sourceEpoch
            return true
        }
        override fun stop(sourceEpoch: Long?) { if (sourceEpoch == null || sourceEpoch == epoch) epoch = null }
        override fun play(packet: com.roomsound.android.room.Pcm16RelayPacket): Boolean {
            if (epoch != packet.sourceEpoch) return false
            played += packet
            return true
        }
        override fun currentEpoch(): Long? = epoch
        override fun setVolume(volume: Double) = Unit
        override fun close() = Unit
    }
}
