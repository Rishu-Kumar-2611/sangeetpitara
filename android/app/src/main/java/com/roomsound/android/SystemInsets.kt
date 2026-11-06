package com.roomsound.android

import android.os.Build
import android.view.View
import android.view.WindowInsets

/** Keep controls clear of Android 15/16 system bars, cutouts and the keyboard. */
fun View.applySystemInsets() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
        fitsSystemWindows = true
        return
    }
    val left = paddingLeft
    val top = paddingTop
    val right = paddingRight
    val bottom = paddingBottom
    setOnApplyWindowInsetsListener { view, insets ->
        val safe = insets.getInsets(WindowInsets.Type.systemBars() or
            WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
        view.setPadding(left + safe.left, top + safe.top, right + safe.right, bottom + safe.bottom)
        insets
    }
    requestApplyInsets()
}
