package com.roomsound.android.capture

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.roomsound.android.R
import com.roomsound.android.room.RoomRequest
import com.roomsound.android.room.RoomState

/**
 * A request-specific, Gmail-style confirmation surface opened from a control
 * request notification. The activity receives only the opaque request id and
 * resolves the current display name from the service-owned room state.
 */
class RoomControlRequestActivity : Activity() {
    companion object {
        private const val SERVICE_BIND_TIMEOUT_MS = 1_500L
    }

    private val main = Handler(Looper.getMainLooper())
    private var requestId = ""
    private var captureService: PlaybackCaptureService? = null
    private var serviceBound = false
    private var serviceBindingInFlight = false
    private var decisionInFlight = false

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            serviceBindingInFlight = false
            val localBinder = binder as? PlaybackCaptureService.LocalBinder ?: run {
                captureService = null
                renderUnavailable()
                return
            }
            captureService = localBinder.service()
            serviceBound = true
            renderCurrentRequest()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            serviceBindingInFlight = false
            serviceBound = false
            captureService = null
            renderUnavailable()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureWindow()
        requestId = intent.getStringExtra(RoomControlRequestNotifications.EXTRA_REQUEST_ID)
            ?.trim()
            .orEmpty()
        if (requestId.isBlank()) {
            finish()
            return
        }
        renderLoading()
    }

    override fun onStart() {
        super.onStart()
        bindToCaptureService()
        main.postDelayed({
            if (!isFinishing && captureService == null) renderUnavailable()
        }, SERVICE_BIND_TIMEOUT_MS)
    }

    override fun onStop() {
        main.removeCallbacksAndMessages(null)
        if (serviceBound || serviceBindingInFlight) {
            runCatching { unbindService(serviceConnection) }
            serviceBound = false
            serviceBindingInFlight = false
        }
        captureService = null
        super.onStop()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent == null) return
        setIntent(intent)
        requestId = intent.getStringExtra(RoomControlRequestNotifications.EXTRA_REQUEST_ID)
            ?.trim()
            .orEmpty()
        decisionInFlight = false
        if (requestId.isBlank()) {
            finish()
        } else {
            renderLoading()
            renderCurrentRequest()
        }
    }

    private fun configureWindow() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
    }

    private fun bindToCaptureService() {
        if (serviceBound || serviceBindingInFlight) return
        serviceBindingInFlight = true
        val requested = runCatching {
            bindService(
                Intent(this, PlaybackCaptureService::class.java),
                serviceConnection,
                Context.BIND_AUTO_CREATE,
            )
        }.getOrDefault(false)
        if (!requested) {
            serviceBindingInFlight = false
            renderUnavailable()
        }
    }

    private fun renderCurrentRequest() {
        val state = captureService?.roomSession()?.currentRoomState()
        val request = state?.requests?.firstOrNull { it.id == requestId && it.status.equals("PENDING", true) }
        if (state == null || request == null || !isModerator(state) || !state.room.status.equals("ACTIVE", true)) {
            renderUnavailable()
            return
        }
        setContentView(promptView(request))
    }

    private fun isModerator(state: RoomState): Boolean {
        val selfId = state.self?.id ?: return false
        return selfId == state.room.hostId || selfId == state.room.cohostId
    }

    private fun renderLoading() {
        setContentView(messageView(
            eyebrow = getString(R.string.control_request_prompt_eyebrow),
            title = getString(R.string.control_request_prompt_title),
            body = "Checking the current room request…",
            actionLabel = null,
        ))
    }

    private fun renderUnavailable() {
        if (isFinishing) return
        setContentView(messageView(
            eyebrow = getString(R.string.control_request_prompt_eyebrow),
            title = getString(R.string.control_request_stale_title),
            body = getString(R.string.control_request_stale_text),
            actionLabel = getString(R.string.close_prompt),
        ))
    }

    private fun promptView(request: RoomRequest): View {
        val root = promptRoot()
        val panel = promptPanel()
        addHeader(panel, getString(R.string.control_request_prompt_eyebrow))
        panel.addView(textView(
            getString(R.string.control_request_requester, request.requesterName.ifBlank { "Guest" }),
            22f,
            R.color.roomsound_cream,
            Typeface.BOLD,
        ), matchWrap())
        panel.addView(textView(
            getString(R.string.control_request_prompt_body),
            17f,
            R.color.roomsound_cream_soft,
            Typeface.NORMAL,
        ).apply { setPadding(0, dp(10), 0, 0) }, matchWrap())
        if (request.note.isNotBlank()) {
            panel.addView(textView(
                "\"${request.note}\"",
                15f,
                R.color.roomsound_cream_muted,
                Typeface.ITALIC,
            ).apply {
                setBackgroundResource(R.drawable.bg_roomsound_inset)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setMaxLines(3)
            }, matchWrapWithTopMargin(12))
        }
        panel.addView(textView(
            getString(R.string.control_request_prompt_note),
            14f,
            R.color.roomsound_cream_muted,
            Typeface.NORMAL,
        ).apply { setPadding(0, dp(14), 0, dp(4)) }, matchWrap())

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        actions.addView(actionButton(
            getString(R.string.approve_control_request),
            R.drawable.bg_roomsound_button_primary,
        ) { decide(request.id, approve = true) }, LinearLayout.LayoutParams(0, dp(56), 1f).apply {
            marginEnd = dp(6)
        })
        actions.addView(actionButton(
            getString(R.string.reject_control_request),
            R.drawable.bg_roomsound_button_danger,
        ) { decide(request.id, approve = false) }, LinearLayout.LayoutParams(0, dp(56), 1f).apply {
            marginStart = dp(6)
        })
        panel.addView(actions, matchWrapWithTopMargin(10))
        root.addView(panel, centeredPanelLayout())
        return root
    }

    private fun messageView(
        eyebrow: String,
        title: String,
        body: String,
        actionLabel: String?,
    ): View {
        val root = promptRoot()
        val panel = promptPanel()
        addHeader(panel, eyebrow)
        panel.addView(textView(title, 22f, R.color.roomsound_cream, Typeface.BOLD), matchWrap())
        panel.addView(textView(body, 17f, R.color.roomsound_cream_soft, Typeface.NORMAL).apply {
            setPadding(0, dp(10), 0, dp(4))
        }, matchWrap())
        if (actionLabel != null) {
            panel.addView(actionButton(actionLabel, R.drawable.bg_roomsound_button_primary) {
                finish()
            }, matchWrapWithTopMargin(18))
        }
        root.addView(panel, centeredPanelLayout())
        return root
    }

    private fun addHeader(panel: LinearLayout, eyebrow: String) {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            contentDescription = getString(R.string.app_name)
        }, LinearLayout.LayoutParams(dp(58), dp(58)).apply { marginEnd = dp(12) })
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(textView(
            eyebrow,
            11f,
            R.color.roomsound_brass_bright,
            Typeface.NORMAL,
        ).apply { letterSpacing = 0.14f }, matchWrap())
        copy.addView(textView(
            getString(R.string.app_name),
            25f,
            R.color.roomsound_cream,
            Typeface.BOLD,
        ).apply { setPadding(0, dp(5), 0, 0) }, matchWrap())
        header.addView(copy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        panel.addView(header, matchWrap())
    }

    private fun promptRoot(): FrameLayout = FrameLayout(this).apply {
        setBackgroundColor(Color.argb(224, 18, 9, 6))
        setPadding(dp(18), dp(18), dp(18), dp(18))
        isClickable = true
        isFocusable = true
    }

    private fun promptPanel(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = getDrawable(R.drawable.bg_roomsound_panel)
        setPadding(dp(20), dp(20), dp(20), dp(20))
        elevation = dp(8).toFloat()
        minimumHeight = (resources.displayMetrics.heightPixels * 0.44f).toInt()
    }

    private fun centeredPanelLayout(): FrameLayout.LayoutParams = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
        gravity = Gravity.CENTER
    }

    private fun textView(
        value: String,
        size: Float,
        color: Int,
        style: Int,
    ): TextView = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(getColor(color))
        setTypeface(Typeface.create("sans-serif", style))
        setLineSpacing(0f, 1.12f)
    }

    private fun actionButton(label: String, backgroundResource: Int, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            setTextColor(getColor(R.color.roomsound_cream))
            setTextSize(16f)
            setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL))
            background = getDrawable(backgroundResource)
            minHeight = dp(56)
            minimumHeight = dp(56)
            setPadding(dp(8), 0, dp(8), 0)
            setOnClickListener { onClick() }
        }

    private fun decide(id: String, approve: Boolean) {
        if (decisionInFlight) return
        decisionInFlight = true
        val action = if (approve) {
            RoomControlRequestNotifications.ACTION_APPROVE_REQUEST
        } else {
            RoomControlRequestNotifications.ACTION_REJECT_REQUEST
        }
        val path = if (approve) "approve" else "reject"
        val intent = Intent(this, PlaybackCaptureService::class.java).apply {
            this.action = action
            putExtra(RoomControlRequestNotifications.EXTRA_REQUEST_ID, id)
            data = Uri.parse("roomsound://control-request/${Uri.encode(id)}/$path")
        }
        runCatching { startService(intent) }
            .onSuccess { finish() }
            .onFailure {
                decisionInFlight = false
                Toast.makeText(this, "The decision could not be sent. Try again.", Toast.LENGTH_LONG).show()
            }
    }

    private fun matchWrap(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    )

    private fun matchWrapWithTopMargin(margin: Int): LinearLayout.LayoutParams = matchWrap().apply {
        topMargin = dp(margin)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
