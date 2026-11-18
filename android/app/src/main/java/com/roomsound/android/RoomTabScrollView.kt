package com.roomsound.android

import android.content.Context
import android.view.MotionEvent
import android.widget.HorizontalScrollView
import android.view.ViewConfiguration

/** Let vertical swipes over the tabs scroll the page; keep sideways tab navigation. */
class RoomTabScrollView(context: Context) : HorizontalScrollView(context) {
    private var downX = 0f
    private var downY = 0f
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { downX = event.x; downY = event.y }
            MotionEvent.ACTION_MOVE -> {
                val dx = kotlin.math.abs(event.x - downX)
                val dy = kotlin.math.abs(event.y - downY)
                if (dy > slop && dy > dx) parent.requestDisallowInterceptTouchEvent(false)
            }
        }
        return super.dispatchTouchEvent(event)
    }
}
