package com.roomsound.android.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.roomsound.android.transport.OpusRelayDecoder
import com.roomsound.android.transport.OpusRelayEncoder
import com.roomsound.android.transport.OpusSupport
import com.roomsound.android.transport.opusPacketSampleCount
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Debug builds only: lets a developer check the device's Opus codecs with
 * `adb shell am broadcast -n <package>/com.roomsound.android.debug.OpusSelfTestReceiver`.
 * Results are written to logcat under the tag OpusSelfTest.
 */
class OpusSelfTestReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        Thread {
            try {
                Log.i(TAG, "capabilities=${OpusSupport.capabilities()}")
                val encoder = OpusRelayEncoder.create(96_000)
                val decoder = OpusRelayDecoder.create()
                if (encoder == null || decoder == null) {
                    Log.i(TAG, "encoder=${encoder != null} decoder=${decoder != null}")
                    return@Thread
                }
                encoder.use { enc ->
                    decoder.use { dec ->
                        val packets = mutableListOf<ByteArray>()
                        // Two seconds of a 440 Hz tone in 10 ms blocks, like playback capture.
                        val block = ShortArray(480)
                        for (index in 0 until 200) {
                            for (i in block.indices) {
                                val t = (index * block.size + i).toDouble() / OpusSupport.SAMPLE_RATE
                                block[i] = (sin(2 * PI * 440.0 * t) * 12_000).toInt().toShort()
                            }
                            packets += enc.encode(block, block.size)
                        }
                        packets += enc.drain(50_000)
                        var decoded = 0
                        var sum = 0.0
                        packets.forEachIndexed { index, packet ->
                            val pcm = dec.decode(packet, index * 20_000L)
                            decoded += pcm.size
                            for (sample in pcm) sum += sample.toDouble() * sample
                        }
                        val bytes = packets.sumOf { it.size }
                        Log.i(TAG, "packets=${packets.size} bytes=$bytes avgBytes=${if (packets.isEmpty()) 0 else bytes / packets.size} " +
                            "samplesPerPacket=${packets.firstOrNull()?.let(::opusPacketSampleCount)} decodedSamples=$decoded " +
                            "rms=${if (decoded == 0) 0.0 else sqrt(sum / decoded)}")
                    }
                }
            } catch (error: Throwable) {
                Log.e(TAG, "self-test failed", error)
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private const val TAG = "OpusSelfTest"
    }
}
