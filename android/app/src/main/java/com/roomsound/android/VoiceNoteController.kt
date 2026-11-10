package com.roomsound.android

import android.app.Activity
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.roomsound.android.room.ChatContent
import com.roomsound.android.room.RoomVoiceNote
import java.io.File
import java.util.Base64
import java.util.UUID

/** Foreground-only microphone notes, independent of the room's music service. */
class VoiceNoteController(private val activity: Activity, private val changed: () -> Unit, private val error: (String) -> Unit) : AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val directory = File(activity.cacheDir, "voice-notes").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var started = 0L
    private var player: MediaPlayer? = null
    private var playingFile: File? = null
    var draft: RoomVoiceNote? = null
        private set
    var draftId: String? = null
        private set
    /** Called when a recording has just become a draft (Telegram-style: stop means send). */
    var onDraftReady: (() -> Unit)? = null
    /** Called with true when a voice message starts playing and false when it stops. */
    var onPlaybackChanged: ((Boolean) -> Unit)? = null
    var onRecordingChanged: ((Boolean) -> Unit)? = null
    val recording get() = recorder != null
    val playing get() = player != null
    val elapsedSeconds get() = ((SystemClock.elapsedRealtime() - started) / 1000).toInt().coerceIn(0,30)
    private val tick = object : Runnable { override fun run() { if (!recording) return; changed(); if (elapsedSeconds >= 30) stopRecording() else handler.postDelayed(this, 250) } }
    @Suppress("DEPRECATION")
    fun start() {
        if (recording || draft != null) return
        stopPlayback()
        try {
            val file = File.createTempFile("recording-", ".m4a", directory); recordingFile = file
            val capture = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(activity) else MediaRecorder()
            recorder = capture
            capture.setAudioSource(MediaRecorder.AudioSource.MIC)
            capture.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            capture.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            capture.setAudioChannels(1); capture.setAudioSamplingRate(16000); capture.setAudioEncodingBitRate(24000)
            capture.setMaxDuration(ChatContent.MAX_DURATION_MS); capture.setMaxFileSize(ChatContent.MAX_VOICE_BYTES.toLong())
            capture.setOutputFile(file.absolutePath)
            capture.setOnInfoListener { _, what, _ -> if (recorder === capture && (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED || what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) stopRecording() }
            capture.setOnErrorListener { _, _, _ -> if (recorder === capture) { cancelRecording(); error("Recording failed. Please try again.") } }
            onRecordingChanged?.invoke(true)
            capture.prepare(); capture.start(); started = SystemClock.elapsedRealtime(); handler.post(tick)
            changed()
        } catch (_: Exception) { cancelRecording(); error("The microphone is unavailable. Close other recording apps and try again.") }
    }
    fun stopRecording() {
        val capture = recorder ?: return
        recorder = null; handler.removeCallbacks(tick)
        val file = recordingFile; recordingFile = null
        try {
            capture.stop()
            val duration = (SystemClock.elapsedRealtime() - started).coerceAtMost(30_000)
            require(file != null && file.length() in 12..ChatContent.MAX_VOICE_BYTES.toLong() && duration >= 200)
            draft = RoomVoiceNote("audio/mp4", duration, Base64.getEncoder().encodeToString(file.readBytes()))
            draftId = UUID.randomUUID().toString()
        } catch (_: Exception) { error("Record between 1 and 30 seconds, then try again.") }
        finally { runCatching { capture.release() }; onRecordingChanged?.invoke(false); file?.delete(); changed() }
        if (draft != null) onDraftReady?.invoke()
    }
    fun cancelRecording() {
        handler.removeCallbacks(tick)
        val capture = recorder; recorder = null
        if (capture != null) { runCatching { capture.stop() }; runCatching { capture.release() }; onRecordingChanged?.invoke(false) }
        recordingFile?.delete(); recordingFile = null; changed()
    }
    fun discard() { stopPlayback(); draft = null; draftId = null; changed() }
    fun acknowledge(id: String?) { if (id != null && id == draftId) discard() }
    fun restore(note: RoomVoiceNote, id: String) { draft = note; draftId = id; changed() }
    fun stopPlayback() {
        val previous = player; player = null
        previous?.let { runCatching { it.stop() }; it.release() }
        playingFile?.delete(); playingFile = null
        if (previous != null) onPlaybackChanged?.invoke(false)
        changed()
    }
    fun play(note: RoomVoiceNote) {
        if (recording) return
        stopPlayback()
        try {
            val data = note.data ?: throw IllegalStateException()
            require(data.length <= ((ChatContent.MAX_VOICE_BYTES + 2) / 3) * 4)
            val bytes = Base64.getDecoder().decode(data); require(bytes.size <= ChatContent.MAX_VOICE_BYTES)
            val file = File.createTempFile("listen-", if (note.mimeType.contains("mp4")) ".m4a" else ".webm", directory)
            file.writeBytes(bytes); playingFile = file
            val media = MediaPlayer(); player = media
            onPlaybackChanged?.invoke(true)
            media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).setAllowedCapturePolicy(AudioAttributes.ALLOW_CAPTURE_BY_NONE).build())
            media.setDataSource(file.absolutePath)
            media.setOnPreparedListener { if (player === it) runCatching { it.start() }.onFailure { stopPlayback(); error("This recording could not be played.") } }
            media.setOnCompletionListener { if (player === it) stopPlayback() }
            media.setOnErrorListener { failed, _, _ -> if (player === failed) { stopPlayback(); error("This recording could not be played on this device.") }; true }
            media.prepareAsync(); changed()
        } catch (_: Exception) { stopPlayback(); error("This recording is no longer available or could not be opened.") }
    }
    override fun close() { cancelRecording(); stopPlayback(); directory.listFiles()?.forEach { it.delete() } }
}
