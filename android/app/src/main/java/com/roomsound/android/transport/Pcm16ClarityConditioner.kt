package com.roomsound.android.transport

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Conservative source-side cleanup for the PCM16 relay only.
 *
 * A slow gated bias tracker removes sustained DC/infrasonic offset, which can
 * consume PCM headroom and make quiet speech sound veiled. By tracking zero
 * crossings (monopolar sample runs), oscillatory musical sub-bass never opens
 * the non-linear gate or triggers ramp modulation.
 */
internal class Pcm16ClarityConditioner {
    private var bias = 0.0
    private var processedSamples = 0
    private var monopolarSamples = 0
    private var lastPolarity = 0
    private var enabled = false
    private var correctionGain = 0.0

    fun reset() {
        bias = 0.0
        processedSamples = 0
        monopolarSamples = 0
        lastPolarity = 0
        enabled = false
        correctionGain = 0.0
    }

    fun process(samples: ShortArray, sampleCount: Int): ShortArray {
        require(sampleCount in 1..samples.size)
        val conditioned = samples.copyOf(sampleCount)
        repeat(sampleCount) { index ->
            val sample = samples[index].toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()) / 32768.0
            val polarity = when {
                sample > ZERO_EPSILON -> 1
                sample < -ZERO_EPSILON -> -1
                else -> 0
            }
            if (polarity != 0 && lastPolarity != 0 && polarity != lastPolarity) {
                monopolarSamples = 0
            } else if (polarity != 0) {
                monopolarSamples += 1
            }
            if (polarity != 0) {
                lastPolarity = polarity
            }

            bias += ALPHA * (sample - bias)
            processedSamples += 1
            if (!enabled && processedSamples >= MIN_SAMPLES && monopolarSamples >= MIN_SAMPLES && abs(bias) >= ENABLE_THRESHOLD) {
                enabled = true
            } else if (enabled && (abs(bias) <= DISABLE_THRESHOLD || monopolarSamples == 0)) {
                enabled = false
            }
            correctionGain = if (enabled) {
                (correctionGain + CORRECTION_RAMP).coerceAtMost(1.0)
            } else {
                (correctionGain - CORRECTION_RAMP).coerceAtLeast(0.0)
            }
            if (correctionGain > 0.0) {
                val value = (sample - bias * correctionGain).coerceIn(-1.0, 1.0)
                conditioned[index] = if (value < 0) {
                    (value * 32768.0).roundToInt().coerceIn(-32768, 32767).toShort()
                } else {
                    (value * 32767.0).roundToInt().coerceIn(-32768, 32767).toShort()
                }
            }
        }
        return conditioned
    }

    private companion object {
        const val ALPHA = 0.0001
        const val ENABLE_THRESHOLD = 0.04
        const val DISABLE_THRESHOLD = 0.015
        const val MIN_SAMPLES = 4_800
        const val CORRECTION_RAMP = 0.0005
        const val ZERO_EPSILON = 0.0005
    }
}
