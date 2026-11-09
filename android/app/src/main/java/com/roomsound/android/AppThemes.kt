package com.roomsound.android

import android.app.Activity
import android.content.Context
import android.util.TypedValue

object AppThemes {
    val names = arrayOf("Console · Dark", "Console · Light", "Forest", "Brass", "Rose")
    private val keys = arrayOf("dark", "light", "forest", "brass", "rose")
    fun selected(context: Context): Int {
        val saved = context.getSharedPreferences("appearance", Context.MODE_PRIVATE).getString("theme", "light")
        return keys.indexOf(saved).takeIf { it >= 0 } ?: 1
    }
    fun save(context: Context, index: Int) {
        context.getSharedPreferences("appearance", Context.MODE_PRIVATE).edit().putString("theme", keys[index]).apply()
    }
    fun apply(activity: Activity, control: Boolean = false) {
        val styles = if (control) intArrayOf(
            R.style.Theme_RoomSound_ControlRequest, R.style.Theme_RoomSound_Playground_ControlRequest,
            R.style.Theme_RoomSound_Forest_ControlRequest, R.style.Theme_RoomSound_Brass_ControlRequest,
            R.style.Theme_RoomSound_Rose_ControlRequest,
        ) else intArrayOf(
            R.style.Theme_RoomSound, R.style.Theme_RoomSound_Playground,
            R.style.Theme_RoomSound_Forest, R.style.Theme_RoomSound_Brass, R.style.Theme_RoomSound_Rose,
        )
        activity.setTheme(styles[selected(activity)])
    }
    private val attributes = mapOf(
        R.color.roomsound_background_top to R.attr.roomsound_background_top,
        R.color.roomsound_background_bottom to R.attr.roomsound_background_bottom,
        R.color.roomsound_header_top to R.attr.roomsound_header_top,
        R.color.roomsound_header_bottom to R.attr.roomsound_header_bottom,
        R.color.roomsound_panel_top to R.attr.roomsound_panel_top,
        R.color.roomsound_panel_bottom to R.attr.roomsound_panel_bottom,
        R.color.roomsound_panel_stroke to R.attr.roomsound_panel_stroke,
        R.color.roomsound_inset to R.attr.roomsound_inset,
        R.color.roomsound_inset_stroke to R.attr.roomsound_inset_stroke,
        R.color.roomsound_field to R.attr.roomsound_field,
        R.color.roomsound_field_focused to R.attr.roomsound_field_focused,
        R.color.roomsound_field_stroke to R.attr.roomsound_field_stroke,
        R.color.roomsound_field_focus_stroke to R.attr.roomsound_field_focus_stroke,
        R.color.roomsound_cream to R.attr.roomsound_cream,
        R.color.roomsound_cream_soft to R.attr.roomsound_cream_soft,
        R.color.roomsound_cream_muted to R.attr.roomsound_cream_muted,
        R.color.roomsound_brass to R.attr.roomsound_brass,
        R.color.roomsound_brass_bright to R.attr.roomsound_brass_bright,
        R.color.roomsound_brass_shadow to R.attr.roomsound_brass_shadow,
        R.color.roomsound_skin to R.attr.roomsound_skin,
        R.color.roomsound_success to R.attr.roomsound_success,
        R.color.roomsound_warning to R.attr.roomsound_warning,
        R.color.roomsound_danger to R.attr.roomsound_danger,
        R.color.roomsound_on_accent to R.attr.roomsound_on_accent,
        R.color.roomsound_accent_soft to R.attr.roomsound_accent_soft,
        R.color.roomsound_button_primary_top to R.attr.roomsound_button_primary_top,
        R.color.roomsound_button_primary_bottom to R.attr.roomsound_button_primary_bottom,
        R.color.roomsound_button_primary_pressed_top to R.attr.roomsound_button_primary_pressed_top,
        R.color.roomsound_button_primary_pressed_bottom to R.attr.roomsound_button_primary_pressed_bottom,
        R.color.roomsound_button_secondary_top to R.attr.roomsound_button_secondary_top,
        R.color.roomsound_button_secondary_bottom to R.attr.roomsound_button_secondary_bottom,
        R.color.roomsound_button_secondary_pressed_top to R.attr.roomsound_button_secondary_pressed_top,
        R.color.roomsound_button_secondary_pressed_bottom to R.attr.roomsound_button_secondary_pressed_bottom,
        R.color.roomsound_button_danger_top to R.attr.roomsound_button_danger_top,
        R.color.roomsound_button_danger_bottom to R.attr.roomsound_button_danger_bottom,
        R.color.roomsound_button_danger_pressed_top to R.attr.roomsound_button_danger_pressed_top,
        R.color.roomsound_button_danger_pressed_bottom to R.attr.roomsound_button_danger_pressed_bottom,
        R.color.roomsound_button_disabled to R.attr.roomsound_button_disabled,
        R.color.roomsound_button_disabled_stroke to R.attr.roomsound_button_disabled_stroke,
        R.color.roomsound_seekbar_track to R.attr.roomsound_seekbar_track,
        R.color.roomsound_seekbar_progress to R.attr.roomsound_seekbar_progress,
        R.color.roomsound_seekbar_thumb_top to R.attr.roomsound_seekbar_thumb_top,
        R.color.roomsound_seekbar_thumb_bottom to R.attr.roomsound_seekbar_thumb_bottom
    )
    fun color(context: Context, id: Int): Int {
        val attr = attributes[id] ?: return context.getColor(id)
        val value = TypedValue()
        return if(context.theme.resolveAttribute(attr,value,true)) value.data else context.getColor(id)
    }
}
