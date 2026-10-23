package com.roomsound.android.transport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class Pcm16ClarityConditionerTest {
    @Test
    fun ordinaryProgramAudioIsUnchanged() {
        val conditioner = Pcm16ClarityConditioner()
        val input = ShortArray(960) { index ->
            (sin(2.0 * PI * 997.0 * index / 48_000.0) * 0.8 * 32767.0).toInt().toShort()
        }
        assertArrayEquals(input, conditioner.process(input, input.size))
    }

    @Test
    fun sustainedBiasIsReducedAfterTheGateOpens() {
        val conditioner = Pcm16ClarityConditioner()
        var last = Short.MAX_VALUE
        repeat(12_000 / 480) {
            last = conditioner.process(ShortArray(480) { 3_932 }, 480).last()
        }
        assertTrue("sustained PCM bias should be reduced", last.toInt() < 2_000)
        assertTrue("conditioning must not invert the source", last.toInt() > -400)
    }
}
