package com.roomsound.android

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin

internal enum class PlaybackVisual(
    val label: String,
    val asset: String? = null,
    val crop: RectF = RectF(),
    val background: Int = 0xff171717.toInt(),
) {
    CASSETTE("Cassette"),
    BICYCLE("Bicycle", "11-visual-bicycle.jpg", RectF(132f, 66f, 1232f, 706f)),
    CAR("Neon sports car", "12-visual-sports-car.jpg", RectF(81f, 166f, 1295f, 592f)),
    RADIO("Vintage radio", "13-visual-vintage-radio.jpg", RectF(49f, 354f, 447f, 606f), 0xff231910.toInt()),
}

internal class PlaybackArtwork(context: Context, private val visual: PlaybackVisual) {
    private val bitmap: Bitmap? = visual.asset?.let { asset ->
        context.assets.open("playback/$asset").use { BitmapFactory.decodeStream(it) }
    }
    private val art = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        textSize = 19f
    }
    private val mask = Path()
    private val bounds = RectF()

    fun draw(canvas: Canvas, target: RectF, radius: Float, seconds: Float, playing: Boolean) {
        val image = bitmap ?: return
        val crop = visual.crop
        val size = minOf(target.width() / crop.width(), target.height() / crop.height())
        canvas.save()
        mask.reset()
        mask.addRoundRect(target, radius, radius, Path.Direction.CW)
        canvas.clipPath(mask)
        canvas.drawColor(visual.background)
        canvas.translate(target.centerX() - crop.centerX() * size, target.centerY() - crop.centerY() * size)
        canvas.scale(size, size)
        canvas.clipRect(crop)
        canvas.drawBitmap(image, 0f, 0f, art)
        if (playing) {
            when (visual) {
                PlaybackVisual.BICYCLE -> {
                    bikeWheel(canvas, 413f, 470f, seconds, 0f, 0xff88fff1.toInt())
                    bikeWheel(canvas, 964f, 470f, seconds, PI.toFloat(), 0xfffff190.toInt())
                }
                PlaybackVisual.CAR -> {
                    carWheel(canvas, image, 335f, 458f, seconds, 0f)
                    carWheel(canvas, image, 1042f, 457f, seconds, (PI * .9).toFloat())
                }
                PlaybackVisual.RADIO -> radioDisplay(canvas, seconds)
                PlaybackVisual.CASSETTE -> Unit
            }
        }
        canvas.restore()
    }

    private fun level(t: Float, i: Float): Float =
        (.48f + .22f * sin(t * TAU * 1.125f + i * .43f) +
            .15f * cos(t * TAU * .75f - i * .94f)).coerceIn(.06f, 1f)

    private fun arc(canvas: Canvas, x: Float, y: Float, radius: Float, phase: Float, sweep: Float, color: Int, alpha: Int) {
        bounds.set(x - radius, y - radius, x + radius, y + radius)
        ink.style = Paint.Style.STROKE
        ink.color = color
        ink.alpha = alpha
        ink.strokeWidth = 3f
        canvas.drawArc(bounds, phase, sweep, false, ink)
    }

    private fun bikeWheel(canvas: Canvas, x: Float, y: Float, t: Float, offset: Float, color: Int) {
        val phase = t * 90f + offset * 180f / PI.toFloat()
        arc(canvas, x, y, 163f, phase, 42f, color, 192)
        for (r in 117..148 step 8) arc(canvas, x, y, r.toFloat(), phase + 8f, 65f, color, 95)
        ink.style = Paint.Style.FILL
        ink.color = color
        canvas.save()
        canvas.translate(x, y)
        for (i in 0 until 32) {
            val height = 1 + 5 * level(t + offset, i.toFloat())
            for (j in 0 until ceil(height).toInt()) {
                ink.alpha = (185 * (height - j).coerceIn(0f, 1f)).toInt()
                val top = -(108f + 5f * j)
                canvas.drawRect(-1.7f, top, 1.7f, top + 3f, ink)
            }
            canvas.rotate(360f / 32)
        }
        canvas.restore()
    }

    private fun carWheel(canvas: Canvas, image: Bitmap, x: Float, y: Float, t: Float, offset: Float) {
        val phase = t * 90f + offset * 180f / PI.toFloat()
        canvas.save()
        canvas.rotate(phase, x, y)
        mask.reset()
        mask.addCircle(x, y, 75f, Path.Direction.CW)
        canvas.clipPath(mask)
        canvas.drawBitmap(image, 0f, 0f, art)
        canvas.restore()
        val cyan = 0xff59f3ff.toInt()
        val pink = 0xfff87ae8.toInt()
        arc(canvas, x, y, 85f, phase, 52f, cyan, 220)
        arc(canvas, x, y, 85f, phase + 180f, 41f, pink, 210)
        ink.style = Paint.Style.STROKE
        ink.strokeWidth = 2f
        for (side in listOf(-1, 1)) {
            ink.color = if (side < 0) cyan else pink
            for (i in 0 until 13) {
                val h = (1 - i / 13f) * (8 + 43 * level(t, i + offset))
                val barX = x + side * (91 + 4.3f * i)
                ink.alpha = (220 * (1 - i / 15f)).toInt()
                canvas.drawLine(barX, y - h / 2, barX, y + h / 2, ink)
            }
        }
        ink.style = Paint.Style.FILL
        for (i in NOTES.indices) {
            val f = (t / 2f + i / 3f + offset * .05f) % 1f
            ink.color = if (i % 2 == 0) cyan else pink
            ink.alpha = (sin(f * PI.toFloat()) * 200).toInt()
            canvas.drawText(NOTES[i], x + cos(i * 2.15f + offset) * (92 + 22 * f), y - 64 - 50 * f + (i % 2) * 25, ink)
        }
    }

    private fun radioDisplay(canvas: Canvas, t: Float) {
        canvas.save()
        canvas.clipRect(246f, 426f, 429f, 502f)
        val shimmer = 252f + 85f * (1 - cos(t * TAU / 4))
        ink.style = Paint.Style.FILL
        ink.color = Color.WHITE
        ink.shader = RadialGradient(shimmer, 464f, 63f, 0x43ffc27c, Color.TRANSPARENT, Shader.TileMode.CLAMP)
        canvas.drawRect(246f, 426f, 429f, 502f, ink)
        ink.shader = null
        ink.color = 0x88ffc77d.toInt()
        ink.strokeWidth = 1.1f
        canvas.drawLine(258f, 475f, 415f, 475f, ink)
        for (i in 0..26) {
            val x = 259f + i * 6
            canvas.drawLine(x, 474f, x, if (i % 5 == 0) 464f else 470f, ink)
        }
        val needle = 347f + 3.5f * sin(t * TAU * .5f)
        ink.color = 0xe0ffbb64.toInt()
        canvas.drawLine(needle, 445f, needle, 482f, ink)
        canvas.restore()
    }

    private companion object {
        val TAU = (2 * PI).toFloat()
        val NOTES = listOf("♫", "♪", "♩")
    }
}
