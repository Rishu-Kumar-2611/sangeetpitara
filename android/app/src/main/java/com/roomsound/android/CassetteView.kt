package com.roomsound.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * The now-playing cassette from the website, drawn natively. The reels turn
 * while room audio is live; colours follow the app theme.
 */
class CassetteView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val tape = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        pathEffect = DashPathEffect(floatArrayOf(4 * density, 4 * density), 0f)
    }
    private val rect = RectF()
    private var angle = 0f
    private var lastFrameNanos = 0L

    /** True while audio is live: the reels turn. */
    var spinning = false
        set(value) {
            if (field == value) return
            field = value
            lastFrameNanos = 0L
            invalidate()
        }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // Full row width, so the cassette can be centred; it is drawn at most 300 dp wide.
        val full = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(full, (min(full.toFloat(), MAX_WIDTH_DP * density) / 1.58f).toInt())
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val c = { id: Int -> AppThemes.color(context, id) }
        val w = min(width.toFloat(), MAX_WIDTH_DP * density)
        val left = (width - w) / 2f
        val h = height.toFloat()
        val radius = 14 * density

        // Shell.
        rect.set(left, 0f, left + w, h)
        fill.color = c(R.color.roomsound_inset)
        canvas.drawRoundRect(rect, radius, radius, fill)
        stroke.color = if (spinning) c(R.color.roomsound_brass) else c(R.color.roomsound_inset_stroke)
        stroke.strokeWidth = 1.5f * density
        canvas.drawRoundRect(rect, radius, radius, stroke)

        // Label strip with an accent line.
        val pad = w * 0.07f
        rect.set(left + pad, h * 0.11f, left + w - pad, h * 0.32f)
        fill.color = c(R.color.roomsound_field)
        canvas.drawRoundRect(rect, 6 * density, 6 * density, fill)
        fill.color = c(R.color.roomsound_brass)
        canvas.drawRect(left + pad + w * 0.05f, h * 0.27f, left + pad + w * 0.30f, h * 0.27f + 2.5f * density, fill)

        // Tape window.
        val windowTop = h * 0.42f
        val windowBottom = h * 0.80f
        rect.set(left + pad, windowTop, left + w - pad, windowBottom)
        fill.color = c(R.color.roomsound_background_bottom)
        val pill = (windowBottom - windowTop) / 2f
        canvas.drawRoundRect(rect, pill, pill, fill)

        // Reels joined by tape.
        val cy = (windowTop + windowBottom) / 2f
        val reelRadius = pill * 0.78f
        val leftReel = left + pad + pill
        val rightReel = left + w - pad - pill
        tape.color = c(R.color.roomsound_cream_muted)
        tape.strokeWidth = 1.2f * density
        canvas.drawLine(leftReel + reelRadius, cy, rightReel - reelRadius, cy, tape)
        drawReel(canvas, leftReel, cy, reelRadius, angle)
        drawReel(canvas, rightReel, cy, reelRadius, angle * 0.8f)

        // Bottom tab.
        fill.color = c(R.color.roomsound_field)
        rect.set(left + w * 0.3f, h * 0.9f, left + w * 0.7f, h)
        canvas.drawRoundRect(rect, 3 * density, 3 * density, fill)

        if (spinning && ValueAnimator.areAnimatorsEnabled()) {
            val now = System.nanoTime()
            if (lastFrameNanos != 0L) angle = (angle + (now - lastFrameNanos) / 1_000_000_000f * 120f) % 360f
            lastFrameNanos = now
            postInvalidateOnAnimation()
        }
    }

    private fun drawReel(canvas: Canvas, cx: Float, cy: Float, radius: Float, rotation: Float) {
        fill.color = AppThemes.color(context, R.color.roomsound_panel_bottom)
        canvas.drawCircle(cx, cy, radius, fill)
        stroke.color = AppThemes.color(context, R.color.roomsound_cream_muted)
        stroke.strokeWidth = 1.5f * density
        canvas.drawCircle(cx, cy, radius, stroke)
        stroke.color = AppThemes.color(context, R.color.roomsound_cream)
        stroke.strokeWidth = 2.5f * density
        for (spoke in 0 until 6) {
            val a = Math.toRadians((rotation + spoke * 60f).toDouble())
            val inner = radius * 0.32f
            val outer = radius * 0.78f
            canvas.drawLine(
                cx + (cos(a) * inner).toFloat(), cy + (sin(a) * inner).toFloat(),
                cx + (cos(a) * outer).toFloat(), cy + (sin(a) * outer).toFloat(), stroke,
            )
        }
    }

    private companion object { const val MAX_WIDTH_DP = 300f }

    override fun onDetachedFromWindow() {
        lastFrameNanos = 0L
        super.onDetachedFromWindow()
    }
}
