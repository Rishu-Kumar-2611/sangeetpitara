package com.roomsound.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import com.roomsound.android.access.LocalDemoRewardedAccessProvider
import com.roomsound.android.access.RewardedAccessGate
import com.roomsound.android.access.RewardedAccessHandle
import com.roomsound.android.access.RewardedAccessListener
import com.roomsound.android.access.RewardedAccessProvider
import com.roomsound.android.access.SharedPreferencesRewardedAccessStore
import com.roomsound.android.capture.CaptureCapabilityReport
import com.roomsound.android.capture.CaptureSnapshot
import com.roomsound.android.capture.CaptureStatus
import com.roomsound.android.capture.PlaybackCaptureCapabilities
import com.roomsound.android.capture.PlaybackCaptureService
import com.roomsound.android.capture.RoomSessionCoordinator
import com.roomsound.android.capture.SourcePlaybackController
import com.roomsound.android.room.RoomConnectionState
import com.roomsound.android.room.RoomEndpointBootstrap
import com.roomsound.android.room.RoomEndpointValidator
import com.roomsound.android.room.RoomSoundEvent
import com.roomsound.android.room.RoomChatMessage
import com.roomsound.android.room.RoomState
import com.roomsound.android.update.ReleaseUpdateChecker
import java.io.PrintWriter
import java.io.StringWriter
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

/** Native Android room controls. Media/signaling state is owned by the service. */
class MainActivity : Activity() {
    companion object {
        private const val REQUEST_MEDIA_PROJECTION = 6102
        private const val REQUEST_RUNTIME_PERMISSIONS = 6103
        private const val REQUEST_POST_NOTIFICATIONS = 6104
        private const val STATE_PENDING_CAPTURE_ID = "pending_capture_id"
        private const val STATE_PROJECTION_IN_FLIGHT = "projection_consent_in_flight"
        private const val PREFERENCES_NAME = "roomsound_android"
        private const val GUEST_ID_KEY = "guest_id"
        private const val LAST_CRASH_DIAGNOSTIC_KEY = "last_uncaught_exception"
        private const val MAX_CRASH_DIAGNOSTIC_CHARS = 8192
        private const val MAX_CRASH_SUMMARY_CHARS = 180
        private const val TRANSPORT_RENDER_INTERVAL_MS = 500L
        private val SENSITIVE_URL_PATTERN = Regex("""(?i)\b(?:https?|wss?)://[^\s]+""")
        private val SENSITIVE_VALUE_PATTERN = Regex(
            """(?i)\b(?:api[_-]?key|authorization|bearer|password|passwd|secret|token|room[_-]?code|roomcode)\b\s*(?:[:=]\s*)?(?:bearer\s+)?[^\s,;]+""",
        )
        private var crashHandlerInstalled = false
    }

    // Same type as the website: Poppins headings, Mukta body (res/font, SIL OFL).
    private val headingTypeface by lazy { resources.getFont(R.font.poppins_semibold) }
    private val labelTypeface by lazy { resources.getFont(R.font.mukta_medium) }
    private val strongTypeface by lazy { resources.getFont(R.font.mukta_semibold) }

    private lateinit var statusText: TextView
    private lateinit var handoffControlText: TextView
    private lateinit var handoffControlButton: Button
    private lateinit var accessStatusText: TextView
    private lateinit var updatePanel: LinearLayout
    private lateinit var updateText: TextView
    private var updateApkUrl: String? = null
    private lateinit var accessButton: Button
    private lateinit var displayNameInput: EditText
    private lateinit var roomNameInput: EditText
    private lateinit var roomCodeInput: EditText
    private lateinit var roomConnectionText: TextView
    private lateinit var roomStateText: TextView
    private lateinit var roomCodePanel: LinearLayout
    private lateinit var roomCodeText: TextView
    private lateinit var roomEventsText: TextView
    private lateinit var transportText: TextView
    private lateinit var peopleText: TextView
    private lateinit var activityText: TextView
    private lateinit var healthText: TextView
    private lateinit var approvalContainer: LinearLayout
    private lateinit var moderationContainer: LinearLayout
    private lateinit var chatText: TextView
    private lateinit var reactionRow: LinearLayout
    // Chat events arrive between state snapshots; keep them (and reaction
    // updates) until the next snapshot carries them.
    private val liveChatMessages = linkedMapOf<String, RoomChatMessage>()
    private val reactionOverrides = mutableMapOf<String, Map<String, List<String>>>()
    private lateinit var chatInput: EditText
    private lateinit var volumeSeekBar: SeekBar
    private lateinit var muteButton: Button
    private lateinit var createRoomButton: Button
    private lateinit var joinRoomButton: Button
    private lateinit var sourceButton: Button
    private lateinit var takeoverButton: Button
    private lateinit var requestAudioButton: Button
    private lateinit var leaveRoomButton: Button
    private lateinit var endRoomButton: Button

    /** The capture transaction owned by the service/coordinator, if any. */
    private var pendingCaptureId: String? = null
    private var pendingCaptureStart = false
    private var pendingRoomSourceStart = false
    private var projectionConsentInFlight = false
    private var captureService: PlaybackCaptureService? = null
    private var serviceBound = false
    private var serviceBindingInFlight = false
    private var activityResumed = false
    private var notificationPermissionRequestInFlight = false
    private var notificationPermissionRequestedRoomId: String? = null
    private var latestCapability: CaptureCapabilityReport? = null
    private var roomSession: RoomSessionCoordinator? = null
    private var latestRoomState: RoomState? = null
    private var latestSnapshot = CaptureSnapshot(CaptureStatus.IDLE)
    private var muted = false
    private var rewardedAccessHandle: RewardedAccessHandle? = null
    private var rewardedAccessProvider: RewardedAccessProvider? = null
    private var rewardedAccessExpiryRunnable: Runnable? = null
    private val roomEvents = ArrayDeque<String>()
    private val transportRenderHandler = Handler(Looper.getMainLooper())
    private var transportRenderPosted = false
    private var lastTransportRenderAt = 0L
    private val transportRenderRunnable = Runnable {
        transportRenderPosted = false
        lastTransportRenderAt = SystemClock.uptimeMillis()
        renderTransport()
    }
    private val preferences by lazy { getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE) }
    private val rewardedAccessGate by lazy {
        RewardedAccessGate(SharedPreferencesRewardedAccessStore(preferences))
    }
    private val guestId: String by lazy {
        preferences.getString(GUEST_ID_KEY, null)?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().also {
            preferences.edit().putString(GUEST_ID_KEY, it).apply()
        }
    }

    private val serviceListener: (CaptureSnapshot) -> Unit = { snapshot ->
        runOnUiThread { renderSnapshot(snapshot) }
    }

    private val roomListener = object : RoomSessionCoordinator.Listener {
        override fun onConnectionStateChanged(state: RoomConnectionState) {
            runOnUiThread {
                renderRoomConnection(state)
                if (state == RoomConnectionState.FAILED) {
                    appendRoomEvent("Connection failed. Check the endpoint, port, Wi-Fi, and Windows Firewall.")
                }
            }
        }

        override fun onEvent(event: RoomSoundEvent) {
            runOnUiThread { handleRoomEvent(event) }
        }

        override fun onPublisherStatus(message: String) {
            runOnUiThread {
                if (message.isNotBlank()) appendRoomEvent(message)
                requestTransportRender()
            }
        }

        override fun onSessionChanged() {
            runOnUiThread {
                renderRoomState(roomSession?.currentRoomState())
                requestTransportRender()
            }
        }
    }

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            serviceBindingInFlight = false
            val localBinder = binder as? PlaybackCaptureService.LocalBinder ?: run {
                serviceBound = false
                return
            }
            attachToService(localBinder.service())
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            serviceBindingInFlight = false
            detachFromService()
            serviceBound = false
            renderSnapshot(CaptureSnapshot(CaptureStatus.STOPPED, message = "Capture service disconnected."))
            renderRoomState(null)
            renderTransportNow()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installUncaughtExceptionHandler()
        AppThemes.apply(this)
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(0) {
                if (nativePage != "home") navigateNative("home") else finish()
            }
        }
        pendingCaptureId = savedInstanceState?.getString(STATE_PENDING_CAPTURE_ID)
        projectionConsentInFlight = savedInstanceState?.getBoolean(STATE_PROJECTION_IN_FLIGHT, false) == true
        nativePage = savedInstanceState?.getString("native-page") ?: "home"
        setContentView(buildContentView())
        savedInstanceState?.let { state ->
            displayNameInput.setText(state.getString("entry-name", "")); roomNameInput.setText(state.getString("entry-room", "")); roomCodeInput.setText(state.getString("entry-code", ""))
        }
        checkForAppUpdate()
        showPreviousCrashNotice()
        refreshCapability()
        ensureCaptureService()
    }

    override fun onResume() {
        super.onResume()
        activityResumed = true
        ensureCaptureService()
        if (serviceBound) renderAttachedServiceState()
        renderPlaybackHandoffControl()
        requestNotificationPermissionIfNeeded()
    }

    override fun onPause() {
        activityResumed = false
        audioRequestDialog?.dismiss()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_PENDING_CAPTURE_ID, pendingCaptureId)
        outState.putBoolean(STATE_PROJECTION_IN_FLIGHT, projectionConsentInFlight)
        outState.putString("native-page", nativePage)
        if (::displayNameInput.isInitialized) { outState.putString("entry-name",displayNameInput.text.toString()); outState.putString("entry-room",roomNameInput.text.toString()); outState.putString("entry-code",roomCodeInput.text.toString()) }
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        activityResumed = false
        transportRenderHandler.removeCallbacks(transportRenderRunnable)
        transportRenderPosted = false
        rewardedAccessHandle?.cancel()
        rewardedAccessHandle = null
        rewardedAccessProvider?.close()
        rewardedAccessProvider = null
        rewardedAccessExpiryRunnable?.let(transportRenderHandler::removeCallbacks)
        rewardedAccessExpiryRunnable = null
        detachFromService()
        if (serviceBound || serviceBindingInFlight) {
            runCatching { unbindService(serviceConnection) }
            serviceBound = false
            serviceBindingInFlight = false
        }
        // Do not close the started service: the room and foreground capture are
        // deliberately independent from this Activity's view lifecycle.
        super.onDestroy()
    }

    private fun installUncaughtExceptionHandler() {
        if (crashHandlerInstalled) return
        crashHandlerInstalled = true
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        val crashPreferences = applicationContext.getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            val diagnostic = buildCrashDiagnostic(thread, throwable)
            try {
                val persisted = crashPreferences.edit()
                    .putString(LAST_CRASH_DIAGNOSTIC_KEY, diagnostic)
                    .commit()
                if (!persisted) android.util.Log.e("RoomSound", "Could not persist uncaught exception diagnostic")
            } catch (persistenceError: Throwable) {
                try {
                    android.util.Log.e(
                        "RoomSound",
                        "Could not persist uncaught exception diagnostic (${persistenceError.javaClass.simpleName})",
                    )
                } catch (_: Throwable) {}
            }
            try { android.util.Log.e("RoomSound", diagnostic) } catch (_: Throwable) {}
            try {
                previousHandler?.uncaughtException(thread, throwable)
            } catch (handlerError: Throwable) {
                try {
                    android.util.Log.e(
                        "RoomSound",
                        "Previous uncaught exception handler failed (${handlerError.javaClass.simpleName})",
                    )
                } catch (_: Throwable) {}
            }
        }
    }

    private fun buildCrashDiagnostic(thread: Thread, throwable: Throwable): String {
        val stackTrace = StringWriter()
        runCatching { PrintWriter(stackTrace).use { throwable.printStackTrace(it) } }
        val stackTraceText = stackTrace.toString()
        val raw = buildString {
            append("Uncaught exception on ")
            append(thread.name)
            append(": ")
            append(throwable.javaClass.name)
            append(": ")
            append(throwable.message ?: "no message")
            if (stackTraceText.isNotEmpty()) {
                append('\n')
                append(stackTraceText)
            }
        }
        return raw
            .replace(SENSITIVE_URL_PATTERN, "<url redacted>")
            .replace(SENSITIVE_VALUE_PATTERN, "<secret redacted>")
            .take(MAX_CRASH_DIAGNOSTIC_CHARS)
    }

    private fun showPreviousCrashNotice() {
        val diagnostic = preferences.getString(LAST_CRASH_DIAGNOSTIC_KEY, null)?.takeIf { it.isNotBlank() } ?: return
        runCatching { preferences.edit().remove(LAST_CRASH_DIAGNOSTIC_KEY).commit() }
        val summary = diagnostic.substringBefore('\n').trim().take(MAX_CRASH_SUMMARY_CHARS)
        appendRoomEvent("Previous launch ended unexpectedly: ${summary.ifBlank { "uncaught exception recorded" }}")
    }

    private fun ensureCaptureService() {
        val intent = Intent(this, PlaybackCaptureService::class.java)
        if (serviceBound || serviceBindingInFlight) return
        serviceBindingInFlight = true
        val requested = runCatching { bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE) }
            .onFailure { appendRoomEvent("Room service could not bind: ${it.message}") }
            .getOrDefault(false)
        if (!requested) serviceBindingInFlight = false
    }

    private fun attachToService(service: PlaybackCaptureService) {
        val session = service.roomSession()
        if (captureService === service && roomSession === session) {
            serviceBound = true
            renderAttachedServiceState()
            return
        }
        detachFromService()
        captureService = service
        roomSession = session
        serviceBound = true
        // A started service may outlive this Activity (including rotation).
        session.addListener(roomListener)
        service.addListener(serviceListener)
        val savedVolume = session.playbackVolume()
        muted = savedVolume == 0.0
        if (!muted) volumeSeekBar.progress = (savedVolume * 100).toInt()
        updateMuteButton()
        renderAttachedServiceState()
        requestNotificationPermissionIfNeeded()
    }

    private fun detachFromService() {
        roomSession?.removeListener(roomListener)
        captureService?.removeListener(serviceListener)
        roomSession = null
        captureService = null
    }

    private fun renderAttachedServiceState() {
        val service = captureService
        val session = roomSession
        renderSnapshot(service?.snapshot() ?: CaptureSnapshot(CaptureStatus.IDLE))
        renderRoomConnection(session?.connectionState() ?: RoomConnectionState.IDLE)
        renderRoomState(session?.currentRoomState())
        renderTransportNow()
        requestNotificationPermissionIfNeeded()
    }

    private var nativePage = "home"
    private var nearbyStarting = false
    private var renderedRoomId: String? = null
    private val announcedAudioRequests = linkedSetOf<String>()
    private var audioRequestDialog: android.app.AlertDialog? = null
    private var displayedAudioRequestId: String? = null
    private val nativePanels = mutableMapOf<String, View>()
    private var nativeScroll: ScrollView? = null
    private lateinit var nativeBack: Button
    private lateinit var nativeTabs: LinearLayout
    private lateinit var nativeLocalInviteButton: Button
    private lateinit var nativeReturnButton: Button
    private lateinit var nativeEntry: LinearLayout
    private lateinit var nativeSessionControls: LinearLayout
    private fun navigateNative(page: String) {
        if (page in setOf("create", "join")) {
            if (roomSession?.currentRoomState() != null) {
                android.widget.Toast.makeText(this, "Leave your current room before starting another", android.widget.Toast.LENGTH_SHORT).show()
                nativePage = "room"
                renderNativePage()
                return
            }
            nearbyEndpointOverride = null
            roomSession?.let(::configureRoomSession)
        }
        nativePage = page
        renderNativePage()
        nativeScroll?.post { nativeScroll?.smoothScrollTo(0, 0) }
    }
    private fun renderNativePage() {
        if (!::nativeBack.isInitialized) return
        nativePanels.forEach { (name, panel) ->
            panel.visibility = if (name == nativePage || (name == "entry" && nativePage in setOf("create", "join", "room")) || (name == "capture" && nativePage == "sound")) View.VISIBLE else View.GONE
        }
        nativeBack.visibility = if (nativePage == "home") View.GONE else View.VISIBLE
        nativeReturnButton.visibility = if (roomSession?.currentRoomState() != null) View.VISIBLE else View.GONE
        nativeLocalInviteButton.visibility = if (roomSession?.currentEndpoint()?.startsWith("ws://127.0.0.1:") == true) View.VISIBLE else View.GONE
        nativeTabs.visibility = if (roomSession?.currentRoomState() != null && nativePage != "home") View.VISIBLE else View.GONE
        nativeEntry.visibility = if (nativePage in setOf("create", "join")) View.VISIBLE else View.GONE
        nativeSessionControls.visibility = if (nativePage == "room") View.VISIBLE else View.GONE
        roomNameInput.visibility = if (nativePage == "create") View.VISIBLE else View.GONE
        createRoomButton.visibility = if (nativePage == "create") View.VISIBLE else View.GONE
        roomCodeInput.visibility = if (nativePage == "join") View.VISIBLE else View.GONE
        joinRoomButton.visibility = if (nativePage == "join") View.VISIBLE else View.GONE
        updatePanel.visibility = if (nativePage == "status" && updateApkUrl != null) View.VISIBLE else View.GONE
    }
    @Deprecated("Legacy back dispatcher")
    override fun onBackPressed() {
        if (nativePage != "home") navigateNative("home") else super.onBackPressed()
    }

    private fun buildContentView(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundResource(R.drawable.bg_roomsound_background)
        }

        val header = panelContainer(R.drawable.bg_roomsound_header)
        val brandRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        brandRow.addView(ImageView(this).apply {
            setImageResource(R.mipmap.ic_launcher)
            contentDescription = getString(R.string.app_name)
        }, LinearLayout.LayoutParams(dp(52), dp(52)).apply { marginEnd = dp(12) })
        val brandCopy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        brandCopy.addView(TextView(this).apply {
            text = getString(R.string.header_eyebrow)
            textSize = 11f
            letterSpacing = 0.16f
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_brass_bright))
            setTypeface(labelTypeface)
        }, matchWrap())
        brandCopy.addView(TextView(this).apply {
            text = getString(R.string.header_title)
            textSize = 25f
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream))
            setTypeface(headingTypeface)
            setPadding(0, dp(7), 0, dp(5))
        }, matchWrap())
        brandRow.addView(brandCopy, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        brandRow.addView(button("Theme", ButtonTone.SECONDARY) {
            android.app.AlertDialog.Builder(this).setTitle("Choose your theme")
                .setSingleChoiceItems(AppThemes.names,AppThemes.selected(this)) { dialog,index ->
                    if(index != AppThemes.selected(this)) { AppThemes.save(this,index); dialog.dismiss(); recreate() } else dialog.dismiss()
                }.setNegativeButton("Cancel",null).show()
        }, LinearLayout.LayoutParams(dp(88),LinearLayout.LayoutParams.WRAP_CONTENT))
        header.addView(brandRow, matchWrap())
        content.addView(header, panelLayout())
        nativeBack = button("← Welcome", ButtonTone.SECONDARY) { navigateNative("home") }
        content.addView(nativeBack, panelLayout())
        val welcome = panelContainer()
        welcome.addView(sectionTitle("Listen together."), matchWrap())
        welcome.addView(sectionLabel("Choose how you want to connect."), marginLayout())
        welcome.addView(button("Create a room · Online") { navigateNative("create") }, marginLayout())
        welcome.addView(button("Join a room · Online", ButtonTone.SECONDARY) { navigateNative("join") }, marginLayout())
        welcome.addView(button("Play Close · Hotspot / Wi-Fi", ButtonTone.SECONDARY) { navigateNative("nearby") }, marginLayout())
        nativeReturnButton = button("Return to your room", ButtonTone.SECONDARY) {
            if (roomSession?.currentRoomState() != null) navigateNative("room") else android.widget.Toast.makeText(this,"Create or join a room first",android.widget.Toast.LENGTH_SHORT).show()
        }
        welcome.addView(nativeReturnButton, marginLayout())
        nativePanels["home"] = welcome
        content.addView(welcome, panelLayout())
        nativeTabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        listOf("room" to "Room", "chat" to "Chat", "people" to "People", "sound" to "Audio", "status" to "Status").forEach { (page, title) ->
            nativeTabs.addView(button(title, ButtonTone.SECONDARY) { navigateNative(page) }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
        content.addView(nativeTabs, panelLayout())

        updatePanel = panelContainer().apply { visibility = View.GONE }
        updateText = labelText().apply {
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream))
            setPadding(0, 0, 0, dp(8))
        }
        updatePanel.addView(updateText, matchWrap())
        updatePanel.addView(button(getString(R.string.update_download)) { openUpdateDownload() }, matchWrap())
        updatePanel.addView(
            button(getString(R.string.update_later), ButtonTone.SECONDARY) { updatePanel.visibility = View.GONE },
            marginLayout(),
        )
        content.addView(updatePanel, panelLayout())

        val accessPanel = panelContainer()
        accessPanel.visibility = View.GONE
        accessStatusText = labelText().apply {
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream_soft))
            setPadding(0, 0, 0, dp(8))
        }
        accessPanel.addView(accessStatusText, matchWrap())
        accessButton = button("Start 30-second demo reward") { startRewardedAccess() }
        accessPanel.addView(accessButton, marginLayout())
        content.addView(accessPanel, panelLayout())

        val nearbyPanel = panelContainer()
        nearbyPanel.addView(sectionTitle("Play Close"), matchWrap())
        nearbyPanel.addView(sectionLabel("Offline music on the same hotspot or Wi-Fi. Join in the Android app to request control and share device audio. Browser guests can listen and share local music files."), matchWrap())
        val nearbyName = inputText("Your name for Nearby Vibe", null)
        nearbyPanel.addView(nearbyName, marginLayout())
        nearbyPanel.addView(button("Open hotspot settings", ButtonTone.SECONDARY) {
            runCatching { startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS)) }
        }, marginLayout())
        nearbyPanel.addView(button("Host & create nearby room") {
            val session = roomSession
            if (session == null || !session.canSelectRoom()) appendRoomEvent("Leave your current room first.")
            else if (!nearbyStarting) runCatching {
                val name = nearbyName.text.toString().trim().ifEmpty { displayNameInput.text.toString().trim() }
                require(name.isNotEmpty()) { "Enter your name above before hosting." }
                nearbyStarting = true
                android.widget.Toast.makeText(this,"Preparing your local room…",android.widget.Toast.LENGTH_SHORT).show()
                Thread({
                    val prepared = runCatching { session.prepareNearbyIdentity() }
                    runOnUiThread {
                        nearbyStarting = false
                        if (!isFinishing && !isDestroyed && roomSession === session) runCatching {
                            prepared.getOrThrow()
                            check(session.canSelectRoom()) { "Leave your current room first." }
                            displayNameInput.setText(name)
                            nearbyEndpointOverride = session.startNearbyHost()
                            check(configureRoomSession(session))
                            if (roomNameInput.text.isBlank()) roomNameInput.setText("Nearby Vibe")
                            createRoom()
                            refreshNearbyInvite()
                            appendRoomEvent("Creating your local room. Open View local invite once joined.")
                        }.onFailure { android.widget.Toast.makeText(this,"Nearby hosting failed: ${it.message}",android.widget.Toast.LENGTH_LONG).show() }
                    }
                },"Nearby-identity").apply { isDaemon = true; start() }
            }.onFailure { appendRoomEvent("Nearby hosting failed: ${it.message}") }
        }, marginLayout())
        nearbyInviteText = labelText().apply {
            setTextIsSelectable(true)
            textSize = 15f
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setBackgroundResource(R.drawable.bg_roomsound_inset)
        }
        nearbyPanel.addView(nearbyInviteText, marginLayout())
        nearbyCopyButton = button("Copy local invite", ButtonTone.SECONDARY) {
            val link = roomSession?.nearbyInvites()?.firstOrNull() ?: return@button
            (getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("Nearby Vibe", link))
            android.widget.Toast.makeText(this, "Local invite copied", android.widget.Toast.LENGTH_SHORT).show()
        }
        val inviteActions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        inviteActions.addView(nearbyCopyButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        nearbyShareButton = button("Share invite", ButtonTone.SECONDARY) {
            val links = roomSession?.nearbyInvites().orEmpty()
            if (links.isNotEmpty()) startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, "Join my hotspot or Wi-Fi, then open Nearby Vibe:\n" + links.joinToString("\n")) }, "Share Nearby Vibe"))
        }
        inviteActions.addView(nearbyShareButton, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8) })
        nearbyPanel.addView(inviteActions, marginLayout())
        nearbyPanel.addView(button("Refresh invite", ButtonTone.SECONDARY) { refreshNearbyInvite() }, marginLayout())
        refreshNearbyInvite()
        nearbyPanel.addView(button("Join nearby room in app", ButtonTone.SECONDARY) {
            val entry = inputText("Paste the host's local invite link", null)
            android.app.AlertDialog.Builder(this).setTitle("Join Play Close").setView(entry)
                .setPositiveButton("Join") { _, _ ->
                    runCatching {
                        val name = nearbyName.text.toString().trim()
                        require(name.isNotEmpty()) { "Enter your name before joining." }
                        val session = roomSession ?: error("Audio service is not ready yet.")
                        check(session.joinNearby(entry.text.toString(),name,guestId)) { "Leave your current room first." }
                        nearbyEndpointOverride = session.currentEndpoint()
                        displayNameInput.setText(name)
                        appendRoomEvent("Connecting securely over the local network…")
                    }.onFailure { android.widget.Toast.makeText(this,it.message ?: "Check the invite",android.widget.Toast.LENGTH_LONG).show() }
                }.setNegativeButton("Cancel", null).show()
        }, marginLayout())
        nearbyPanel.addView(button("Join nearby invite in browser", ButtonTone.SECONDARY) {
            val entry = inputText("Paste the host's local invite link", null)
            android.app.AlertDialog.Builder(this).setTitle("Join Nearby Vibe").setView(entry)
                .setPositiveButton("Open") { _, _ ->
                    runCatching {
                        val uri = java.net.URI(entry.text.toString().trim())
                        val host = uri.host.orEmpty()
                        require(uri.scheme == "http" && host.matches(Regex("(10|192\\.168|172\\.(1[6-9]|2[0-9]|3[01]))\\.[0-9.]+")) && uri.userInfo == null)
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())))
                    }.onFailure { appendRoomEvent("Paste the complete private hotspot invite from your host.") }
                }.setNegativeButton("Cancel", null).show()
        }, marginLayout())
        nearbyPanel.addView(button("Use online rooms", ButtonTone.SECONDARY) {
            if (roomSession?.canSelectRoom() != true) appendRoomEvent("Leave your current room first.")
            else { nearbyEndpointOverride = null; roomSession?.let(::configureRoomSession) }
        }, marginLayout())
        nativePanels["nearby"] = nearbyPanel
        content.addView(nearbyPanel, panelLayout())

        val roomPanel = panelContainer()
        roomPanel.addView(sectionTitle("Room control"), matchWrap())
        roomPanel.addView(sectionLabel("Create or join a listening room"), matchWrap())

        nativeEntry = verticalContainer()
        roomPanel.addView(nativeEntry, matchWrap())
        displayNameInput = inputText("Your name", null)
        nativeEntry.addView(displayNameInput, marginLayout())
        roomNameInput = inputText("Room name", null)
        nativeEntry.addView(roomNameInput, marginLayout())
        createRoomButton = button("Create room") { createRoom() }
        nativeEntry.addView(createRoomButton, marginLayout())
        roomCodeInput = inputText("Room code to join", null).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        nativeEntry.addView(roomCodeInput, marginLayout())
        joinRoomButton = button("Join room") { joinRoom() }
        nativeEntry.addView(joinRoomButton, marginLayout())

        nativeSessionControls = verticalContainer()
        roomPanel.addView(nativeSessionControls, matchWrap())
        nativeLocalInviteButton = button("View local invite", ButtonTone.SECONDARY) { navigateNative("nearby") }
        nativeSessionControls.addView(nativeLocalInviteButton, marginLayout())
        val roomStatusPanel = statusPanel()
        roomConnectionText = labelText().apply {
            text = "Connection: not connected"
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_brass_bright))
            setTypeface(strongTypeface)
            setPadding(0, 0, 0, dp(4))
        }
        roomStatusPanel.addView(roomConnectionText, matchWrap())
        roomStateText = labelText().apply {
            setLineSpacing(0f, 1.12f)
            setPadding(0, 0, 0, dp(5))
        }
        roomStatusPanel.addView(roomStateText, matchWrap())
        roomEventsText = diagnosticText().apply {
            visibility = View.GONE
            maxLines = 2
            setPadding(dp(12), dp(9), dp(12), dp(9))
        }
        roomStatusPanel.addView(roomEventsText, marginLayout())
        nativeSessionControls.addView(roomStatusPanel, marginLayout())

        roomCodePanel = statusPanel().apply {
            visibility = View.GONE
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        roomCodePanel.addView(sectionLabel("Room code"), matchWrap())
        roomCodeText = TextView(this).apply {
            textSize = 30f
            setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream))
            setTypeface(headingTypeface)
            letterSpacing = 0.12f
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(7), dp(8), dp(7))
            setTextIsSelectable(true)
            contentDescription = "Room code will appear here after joining."
        }
        roomCodePanel.addView(roomCodeText, matchWrap())
        roomCodePanel.addView(labelText().apply {
            text = "Share this code with anyone joining the room."
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, 0)
        }, matchWrap())
        nativeSessionControls.addView(roomCodePanel, marginLayout())

        sourceButton = button("Share device audio") { handleSourceAction() }
        nativeSessionControls.addView(sourceButton, marginLayout())
        takeoverButton = button("Take back control", ButtonTone.SECONDARY) { takeoverSource() }
        nativeSessionControls.addView(takeoverButton, marginLayout())
        requestAudioButton = button("Request to share device audio", ButtonTone.SECONDARY) { requestAudioControl() }
        nativeSessionControls.addView(requestAudioButton, marginLayout())
        leaveRoomButton = button("Leave room", ButtonTone.SECONDARY) { leaveRoom() }
        nativeSessionControls.addView(leaveRoomButton, marginLayout())
        endRoomButton = button("End room", ButtonTone.DANGER) { endRoom() }
        nativeSessionControls.addView(endRoomButton, marginLayout())

        nativePanels["entry"] = roomPanel
        content.addView(roomPanel, panelLayout())

        // The browser exposes People as a first-class room surface. Keep the
        // same roster, request queue, moderation actions, and recent activity
        // reachable on a phone instead of burying them in room controls.
        val peoplePanel = panelContainer()
        peoplePanel.addView(sectionTitle("People"), matchWrap())
        peopleText = diagnosticText().apply {
            text = "Join a room to see everyone here."
            setPadding(dp(12), dp(11), dp(12), dp(11))
        }
        peoplePanel.addView(peopleText, marginLayout())
        approvalContainer = dynamicPanel()
        peoplePanel.addView(approvalContainer, marginLayout())
        moderationContainer = dynamicPanel()
        peoplePanel.addView(moderationContainer, marginLayout())
        peoplePanel.addView(sectionLabel("Recent activity"), marginLayout())
        activityText = diagnosticText().apply {
            text = "No room activity yet."
            setPadding(dp(12), dp(11), dp(12), dp(11))
        }
        peoplePanel.addView(activityText, matchWrap())
        nativePanels["people"] = peoplePanel
        content.addView(peoplePanel, panelLayout())

        val chatPanel = panelContainer()
        chatPanel.addView(sectionTitle("Chat"), matchWrap())
        chatText = labelText().apply { setPadding(0, dp(4), 0, dp(4)) }
        chatText.setBackgroundResource(R.drawable.bg_roomsound_inset)
        chatText.setPadding(dp(12), dp(12), dp(12), dp(12))
        chatText.minHeight = dp(70)
        chatText.setLineSpacing(0f, 1.12f)
        chatPanel.addView(chatText, matchWrap())
        reactionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            visibility = View.GONE
        }
        chatPanel.addView(reactionRow, marginLayout())
        val chatRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        chatInput = inputText("Message", null)
        chatRow.addView(chatInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        chatRow.addView(
            button("Send") { sendChat() },
            LinearLayout.LayoutParams(dp(88), LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) },
        )
        chatPanel.addView(chatRow, marginLayout())
        nativePanels["chat"] = chatPanel
        content.addView(chatPanel, panelLayout())

        val listeningPanel = panelContainer()
        listeningPanel.addView(sectionTitle("Local listening"), matchWrap())
        volumeSeekBar = SeekBar(this).apply {
            max = 100
            progress = 100
            contentDescription = "Local listening volume"
            splitTrack = false
            progressDrawable = getDrawable(R.drawable.roomsound_seekbar_track)
            thumb = getDrawable(R.drawable.roomsound_seekbar_thumb)
            setPadding(dp(4), dp(5), dp(4), dp(5))
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) applyPlaybackVolume()
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }
        listeningPanel.addView(volumeSeekBar, matchWrap())
        muteButton = button("Mute listening", ButtonTone.SECONDARY) { muted = !muted; updateMuteButton(); applyPlaybackVolume() }
        listeningPanel.addView(muteButton, marginLayout())

        transportText = diagnosticText().apply {
            visibility = View.GONE
            setPadding(dp(12), dp(11), dp(12), dp(11))
        }
        listeningPanel.addView(transportText, marginLayout())
        nativePanels["sound"] = listeningPanel
        content.addView(listeningPanel, panelLayout())

        val healthPanel = panelContainer()
        healthPanel.addView(sectionTitle("Health diagnostics"), matchWrap())
        healthPanel.addView(sectionLabel("LIVE STREAM STATUS"), matchWrap())
        healthText = diagnosticText().apply {
            text = "Join a room to inspect connection, capture, relay, and native audio health."
            setPadding(dp(12), dp(11), dp(12), dp(11))
        }
        healthPanel.addView(healthText, matchWrap())
        nativePanels["status"] = healthPanel
        content.addView(healthPanel, panelLayout())

        val capturePanel = panelContainer()
        capturePanel.addView(sectionTitle("Playback sharing"), matchWrap())
        statusText = diagnosticText().apply { setPadding(dp(12), dp(11), dp(12), dp(7)) }
        capturePanel.addView(statusText, marginLayout())
        handoffControlText = labelText().apply {
            setPadding(0, dp(4), 0, dp(4))
        }
        capturePanel.addView(handoffControlText, matchWrap())
        handoffControlButton = button("Enable pause on source handoff", ButtonTone.SECONDARY) {
            openPlaybackHandoffSettings()
        }
        capturePanel.addView(handoffControlButton, marginLayout())
        nativePanels["capture"] = capturePanel
        content.addView(capturePanel, panelLayout())

        renderRoomState(null)
        renderTransportNow()
        updateMuteButton()
        renderAccessState()
        renderPlaybackHandoffControl()
        renderNativePage()
        return ScrollView(this).apply {
            nativeScroll = this
            applySystemInsets()
            isFillViewport = true
            isVerticalScrollBarEnabled = false
            setBackgroundResource(R.drawable.bg_roomsound_background)
            addView(content)
        }
    }

    private fun createRoom() {
        if (!requireRewardedAccess()) return
        val displayName = displayNameInput.text.toString().trim()
        if (displayName.isEmpty()) {
            displayNameInput.error = "Enter your name"
            displayNameInput.requestFocus()
            appendRoomEvent("Enter your name before creating a room.")
            return
        }
        val roomName = roomNameInput.text.toString().trim()
        if (roomName.isEmpty()) {
            roomNameInput.error = "Enter a room name"
            roomNameInput.requestFocus()
            appendRoomEvent("Enter a room name before creating a room.")
            return
        }
        val session = roomSessionForRoomAction() ?: return
        appendRoomEvent("Creating room '$roomName' as $displayName.")
        try {
            session.createRoom(roomName, displayName, guestId)
        } catch (t: Throwable) {
            captureService?.cancelRoomPreparation()
            android.util.Log.e("RoomSound", "createRoom failed", t)
            appendRoomEvent(t.message ?: "The room could not be created: ${t.javaClass.simpleName}")
        }
    }

    private fun joinRoom() {
        if (!requireRewardedAccess()) return
        val displayName = displayNameInput.text.toString().trim()
        if (displayName.isEmpty()) {
            displayNameInput.error = "Enter your name"
            displayNameInput.requestFocus()
            appendRoomEvent("Enter your name before joining a room.")
            return
        }
        val roomCode = roomCodeInput.text.toString().trim().uppercase(Locale.US)
        if (roomCode.isEmpty()) {
            appendRoomEvent("Enter a room code before joining.")
            return
        }
        val session = roomSessionForRoomAction() ?: return
        appendRoomEvent("Joining room $roomCode as $displayName.")
        try {
            session.joinRoom(roomCode, displayName, guestId)
        } catch (t: Throwable) {
            captureService?.cancelRoomPreparation()
            android.util.Log.e("RoomSound", "joinRoom failed", t)
            appendRoomEvent(t.message ?: "The room could not be joined: ${t.javaClass.simpleName}")
        }
    }

    private lateinit var nearbyInviteText: TextView
    private lateinit var nearbyCopyButton: Button
    private lateinit var nearbyShareButton: Button
    private fun refreshNearbyInvite() {
        if (!::nearbyInviteText.isInitialized) return
        val links = runCatching { roomSession?.nearbyInvites().orEmpty() }.getOrDefault(emptyList())
        nearbyInviteText.text = when {
            links.isNotEmpty() -> "Your offline invite\n\n" + links.joinToString("\n\n") + "\n\nFriends: join this phone's hotspot, then open the link."
            nearbyEndpointOverride != null && roomSession?.currentRoomState() != null -> "No local network address yet. Enable your hotspot or connect to Wi-Fi, then tap Refresh invite."
            nearbyEndpointOverride != null -> "Creating your nearby room… Your invite will appear here when connected."
            else -> "Your local link appears here after you host a nearby room. The online website cannot generate a link for your phone."
        }
        nearbyCopyButton.isEnabled = links.isNotEmpty()
        nearbyShareButton.isEnabled = links.isNotEmpty()
    }
    private var nearbyEndpointOverride: String? = null

    private fun configuredRoomEndpoint(): String? = nearbyEndpointOverride ?: RoomEndpointBootstrap.selectEndpoint(
        configuredEndpoint = BuildConfig.ROOMSOUND_DEFAULT_ENDPOINT,
        isDebugBuild = BuildConfig.DEBUG,
        isEmulator = isProbablyEmulator(),
    )?.let(RoomEndpointValidator::normalize)

    private fun configureRoomSession(session: RoomSessionCoordinator): Boolean {
        val endpoint = configuredRoomEndpoint()
        if (endpoint == null) {
            appendRoomEvent("Room endpoint is not configured. Build this APK with ROOMSOUND_DEFAULT_ENDPOINT.")
            return false
        }
        if (!session.configureEndpoint(endpoint)) {
            appendRoomEvent("The configured room endpoint is invalid or the room service is not ready. Use a valid WebSocket server endpoint.")
            return false
        }
        return true
    }

    private fun roomSessionForRoomAction(): RoomSessionCoordinator? {
        val session = roomSession
        if (session == null) {
            appendRoomEvent("The room service is not ready. Try again in a moment.")
            return null
        }
        if (!activityResumed || isFinishing || !session.canSelectRoom()) return null
        if (configuredRoomEndpoint() == null) {
            appendRoomEvent("Room endpoint is not configured or is invalid.")
            return null
        }
        // Foreground promotion happens now, inside this validated user action,
        // before configureEndpoint can dispatch any asynchronous network work.
        if (captureService?.prepareRoomPlayback() != true) {
            appendRoomEvent("Background listening could not start. Try joining again while the app is visible.")
            return null
        }
        if (session.currentEndpoint() == null && !configureRoomSession(session)) {
            captureService?.cancelRoomPreparation()
            return null
        }
        if (session.currentEndpoint() == null) {
            captureService?.cancelRoomPreparation()
            appendRoomEvent("The room service has no configured endpoint. Rebuild the APK with ROOMSOUND_DEFAULT_ENDPOINT.")
            return null
        }
        return session
    }

    private fun isProbablyEmulator(): Boolean = Build.FINGERPRINT.startsWith("generic") ||
        Build.FINGERPRINT.lowercase().contains("emulator") ||
        Build.MODEL.contains("Emulator", ignoreCase = true) ||
        Build.MODEL.contains("Android SDK built for", ignoreCase = true)

    private fun requireRewardedAccess(): Boolean {
        // Free build: all rooms are unrestricted — no demo/timer required.
        // Keep the gate class for a future opt-in, but always grant here.
        return true
    }

    private fun startRewardedAccess() {
        if (rewardedAccessGate.hasAccess()) {
            renderAccessState()
            return
        }
        if (rewardedAccessHandle != null) return
        val provider = rewardedAccessProvider ?: LocalDemoRewardedAccessProvider().also {
            rewardedAccessProvider = it
        }
        accessButton.isEnabled = false
        accessStatusText.text = "${provider.displayName}: starting 30-second countdown…"
        rewardedAccessHandle = provider.start(object : RewardedAccessListener {
            override fun onCountdown(secondsRemaining: Int) {
                runOnUiThread {
                    if (!isFinishing) {
                        accessStatusText.text =
                            "${provider.displayName}: $secondsRemaining seconds remaining. Keep this demo open to earn six hours of local access."
                    }
                }
            }

            override fun onCompleted() {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    rewardedAccessHandle = null
                    rewardedAccessGate.grant()
                    appendRoomEvent("Demo reward completed. Room creation, joining, and device-audio capture are unlocked for six hours on this device.")
                    renderAccessState()
                }
            }

            override fun onFailed(message: String) {
                runOnUiThread {
                    if (isFinishing) return@runOnUiThread
                    rewardedAccessHandle = null
                    accessStatusText.text = message
                    accessButton.isEnabled = true
                }
            }
        })
    }

    private fun renderAccessState() {
        if (!::accessStatusText.isInitialized) return
        rewardedAccessExpiryRunnable?.let(transportRenderHandler::removeCallbacks)
        rewardedAccessExpiryRunnable = null
        accessStatusText.text = "Free access — room creation, joining, and playback sharing are unrestricted on this device."
        accessStatusText.setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_success))
        accessButton.text = "Free access active"
        accessButton.isEnabled = false
        updateRoomEntryControls()
        renderRoomState(latestRoomState ?: roomSession?.currentRoomState())
    }

    private fun expireRewardedAccess() {
        // Free build: expiry is disabled — keep room/capture alive.
        renderAccessState()
    }

    private fun updateRoomEntryControls() {
        if (!::createRoomButton.isInitialized) return
        val joined = roomSession?.connectionState() == RoomConnectionState.JOINED
        val canSelect = roomSession?.canSelectRoom() == true && configuredRoomEndpoint() != null
        createRoomButton.isEnabled = canSelect && !joined
        joinRoomButton.isEnabled = canSelect && !joined
    }

    private fun formatAccessDuration(remainingMillis: Long): String {
        val totalSeconds = (remainingMillis + 999L) / 1_000L
        val hours = totalSeconds / 3_600L
        val minutes = (totalSeconds % 3_600L) / 60L
        val seconds = totalSeconds % 60L
        return if (hours > 0L) {
            "${hours}h ${minutes}m"
        } else {
            "${minutes}m ${seconds}s"
        }
    }

    private fun handleRoomEvent(event: RoomSoundEvent) {
        try {
            when (event) {
                is RoomSoundEvent.Joined -> {
                    if (notificationPermissionRequestedRoomId != event.state.room.id) {
                        notificationPermissionRequestedRoomId = null
                    }
                    if (latestRoomState?.room?.id != event.state.room.id) {
                        liveChatMessages.clear()
                        reactionOverrides.clear()
                    }
                    latestRoomState = event.state
                    appendRoomEvent("Joined room ${event.state.room.code}.")
                    renderRoomState(event.state)
                    requestNotificationPermissionIfNeeded()
                }
                is RoomSoundEvent.State -> {
                    latestRoomState = event.state
                    renderRoomState(event.state)
                    requestNotificationPermissionIfNeeded()
                }
                is RoomSoundEvent.Error -> appendRoomEvent("Server error: ${event.message}")
                is RoomSoundEvent.LocalError -> appendRoomEvent("Not sent: ${event.message}")
                is RoomSoundEvent.Chat -> {
                    appendRoomEvent("${event.message.senderName ?: "Room"}: ${event.message.text}")
                    liveChatMessages[event.message.id] = event.message
                    latestRoomState?.let(::renderChat)
                }
                is RoomSoundEvent.Reaction -> {
                    reactionOverrides[event.messageId] = event.reactions
                    latestRoomState?.let(::renderChat)
                }
                is RoomSoundEvent.ControlRequested -> appendRoomEvent(
                    "${event.request.requesterName} requested ${event.request.sourceType.lowercase(Locale.US)}. Review the approval controls below.",
                )
                is RoomSoundEvent.RequestResult -> appendRoomEvent(
                    "Audio request ${event.status.lowercase(Locale.US)}. ${if (event.status == "APPROVED") "Tap Share approved device audio to grant Android system consent." else ""}",
                )
                is RoomSoundEvent.ControlRequestExpired -> appendRoomEvent("Audio request ${event.requestId} expired.")
                is RoomSoundEvent.SourceDisconnected -> appendRoomEvent("The active source disconnected.")
                is RoomSoundEvent.HostDisconnected -> appendRoomEvent("The host disconnected.")
                is RoomSoundEvent.HostPromoted -> appendRoomEvent("A co-host was promoted to host.")
                is RoomSoundEvent.Takeover -> appendRoomEvent("The room source was taken over immediately.")
                is RoomSoundEvent.Removed -> {
                    notificationPermissionRequestedRoomId = null
                    latestRoomState = null
                    appendRoomEvent(event.message)
                    renderRoomState(null)
                }
                is RoomSoundEvent.RoomEnded -> {
                    notificationPermissionRequestedRoomId = null
                    latestRoomState = null
                    appendRoomEvent(event.message)
                    renderRoomState(null)
                }
                is RoomSoundEvent.Rtc -> Unit
                is RoomSoundEvent.StaleStateIgnored -> appendRoomEvent(
                    "Ignored stale room state epoch ${event.receivedEpoch}; current epoch is ${event.currentEpoch}.",
                )
                is RoomSoundEvent.Unknown -> appendRoomEvent("Ignored unknown room event '${event.type}'.")
            }
            requestTransportRender()
        } catch (t: Throwable) {
            android.util.Log.e("RoomSound", "handleRoomEvent crashed for $event", t)
            appendRoomEvent("Room event handling hit an internal error (${t.javaClass.simpleName}); state refresh may be needed.")
            runCatching { requestTransportRender() }
        }
    }

    private fun renderRoomConnection(state: RoomConnectionState) {
        try {
            roomConnectionText.text = "Connection: ${state.name.lowercase(Locale.US)}"
            val joined = state == RoomConnectionState.JOINED
            updateRoomEntryControls()
            if (!joined && latestRoomState == null) runCatching { renderRoomState(null) }
            renderHealth()
        } catch (t: Throwable) { android.util.Log.e("RoomSound", "renderRoomConnection failed", t) }
    }

    private fun renderRoomState(state: RoomState?) {
        try {
        if (roomSession != null && pendingCaptureId != null && roomSession?.pendingCapture()?.id != pendingCaptureId) {
            pendingCaptureId = null
            pendingCaptureStart = false
            projectionConsentInFlight = false
            pendingRoomSourceStart = false
        }
        val previousRoomId = renderedRoomId
        latestRoomState = state
        if (state != null && state.room.id != previousRoomId && nativePage in setOf("home", "create", "join", "nearby")) navigateNative("room")
        if (state != null) {
            if (renderedRoomId != state.room.id) announcedAudioRequests.clear()
            renderedRoomId = state.room.id
        } else if (roomSession?.currentEndpoint() == null && previousRoomId != null) {
            renderedRoomId = null
            announcedAudioRequests.clear()
            audioRequestDialog?.dismiss()
            navigateNative("home")
        }
        renderNativePage()
        refreshNearbyInvite()
        updateRoomEntryControls()
        renderCaptureControls(state)
        if (state == null) {
            roomStateText.text = if (renderedRoomId != null) "Connection interrupted. Reconnecting to your room…" else "No room state. Create or join a room to continue."
            takeoverButton.isEnabled = false
            requestAudioButton.text = "Request to share device audio"
            requestAudioButton.isEnabled = false
            // Leaving is local cleanup and must remain available during retries.
            leaveRoomButton.isEnabled = roomSession?.currentEndpoint() != null || renderedRoomId != null
            endRoomButton.isEnabled = false
            runCatching {
                approvalContainer.removeAllViews()
                approvalContainer.visibility = View.GONE
            }
            runCatching {
                roomCodeText.text = ""
                roomCodeText.contentDescription = "Room code will appear here after joining."
                roomCodePanel.visibility = View.GONE
            }
            runCatching {
                moderationContainer.removeAllViews()
                moderationContainer.visibility = View.GONE
            }
            renderPeople(null)
            chatText.text = "—"
            renderHealth()
            return
        }

        val room = state.room
        val self = state.self
        val isHost = self != null && self.id == room.hostId
        val isModerator = self != null && (isHost || self.id == room.cohostId)
        val sourceMember = state.members.firstOrNull { it.id == room.activeSourceId }
        roomCodePanel.visibility = View.VISIBLE
        roomCodeText.text = room.code
        roomCodeText.contentDescription = "Room code ${room.code}. Share this code with anyone joining the room."
        roomStateText.text = buildString {
            append("Room ${room.code} · ${room.status}\n")
            append("Source: ${sourceMember?.name ?: "none"} · ${room.sourceStatus}")
        }

        val ownPendingRequest = self != null && state.requests.any {
            it.requesterId == self.id && it.status.equals("PENDING", ignoreCase = true)
        }
        requestAudioButton.text = if (ownPendingRequest) "Cancel audio request" else "Request to share device audio"
        requestAudioButton.visibility = if (isModerator || self?.id == room.activeSourceId) View.GONE else View.VISIBLE
        val accessGranted = rewardedAccessGate.hasAccess()
        requestAudioButton.isEnabled = accessGranted && self != null && !isModerator && self.id != room.activeSourceId
        takeoverButton.isEnabled = accessGranted && isModerator && room.activeSourceId != null && self?.id != room.activeSourceId
        leaveRoomButton.isEnabled = true
        endRoomButton.isEnabled = isHost
        runCatching { renderApprovalControls(state, isModerator) }
        runCatching { renderModerationControls(state, isHost, isModerator) }
        showAudioRequestAlert(state)
        renderPeople(state)
        renderChat(state)
        renderHealth()
        } catch (t: Throwable) { android.util.Log.e("RoomSound", "renderRoomState failed", t); appendRoomEvent("Room UI hit an internal error: ${t.message}") }
    }

    private fun renderPeople(state: RoomState?) {
        if (!::peopleText.isInitialized) return
        if (state == null) {
            peopleText.text = "Join a room to see the people, source, and request queue."
            renderActivity()
            return
        }
        val sourceId = state.room.activeSourceId
        peopleText.text = buildString {
            append(state.members.size).append(if (state.members.size == 1) " person" else " people")
            append(" in room\n\n")
            state.members.forEachIndexed { index, member ->
                if (index > 0) append('\n')
                append(if (member.online) "● " else "○ ")
                append(member.name)
                if (member.id == state.self?.id) append(" (You)")
                append(" — ").append(member.role.lowercase(Locale.US))
                if (member.id == sourceId) append(" · sharing audio")
                else if (!member.online) append(" · offline")
            }
            val pending = state.requests.count { it.status.equals("PENDING", ignoreCase = true) }
            append("\n\nPending requests: ").append(pending)
        }
        renderActivity()
    }

    private fun renderActivity() {
        if (!::activityText.isInitialized) return
        activityText.text = roomEvents.toList().takeLast(8)
            .joinToString("\n") { "• $it" }
            .ifBlank { "No room activity yet." }
    }

    private fun renderChat(state: RoomState) {
        val messages = (state.messages + liveChatMessages.values)
            .filter { it.kind == "chat" }
            .distinctBy { it.id }
            .sortedBy { it.createdAt }
            .takeLast(12)
        chatText.text = messages.joinToString("\n") { message ->
            val reactions = (reactionOverrides[message.id] ?: message.reactions)
                .filterValues { it.isNotEmpty() }
                .entries.joinToString(" ") { (emoji, members) -> "$emoji${members.size}" }
            "${message.senderName ?: "Room"}: ${message.text}" + if (reactions.isEmpty()) "" else "   $reactions"
        }.ifEmpty { "No messages yet." }

        // Quick reactions apply to the newest message; servers without
        // reactions publish no set, so the row stays hidden there.
        val emojis = roomSession?.currentChatReactions().orEmpty()
        val target = messages.lastOrNull()
        reactionRow.removeAllViews()
        reactionRow.visibility = if (emojis.isEmpty() || target == null) View.GONE else View.VISIBLE
        if (target == null) return
        val selfId = state.self?.id
        val current = reactionOverrides[target.id] ?: target.reactions
        for (emoji in emojis) {
            val mine = selfId != null && current[emoji].orEmpty().contains(selfId)
            reactionRow.addView(
                button(emoji, if (mine) ButtonTone.PRIMARY else ButtonTone.SECONDARY) {
                    roomSession?.sendReaction(target.id, emoji)
                }.apply {
                    textSize = 18f
                    minWidth = dp(44)
                    minimumWidth = dp(44)
                    setPadding(0, 0, 0, 0)
                    contentDescription = "${if (mine) "Remove" else "React with"} $emoji on the latest message"
                },
                LinearLayout.LayoutParams(0, dp(44), 1f).apply { marginEnd = dp(6) },
            )
        }
    }

    private fun renderApprovalControls(state: RoomState, isModerator: Boolean) {
        approvalContainer.removeAllViews()
        approvalContainer.visibility = View.GONE
        if (!isModerator) return
        approvalContainer.visibility = View.VISIBLE
        val pending = state.requests.filter { it.status.equals("PENDING", ignoreCase = true) }
        approvalContainer.addView(sectionLabel("Broadcast requests"))
        if (pending.isEmpty()) {
            approvalContainer.addView(labelText().apply { text = "No pending requests." }, matchWrap())
            return
        }
        pending.forEach { request ->
            val requestPanel = verticalContainer().apply {
                setPadding(0, dp(6), 0, dp(7))
            }
            requestPanel.addView(labelText().apply {
                text = "${request.requesterName}: ${request.note.ifBlank { "device audio" }}"
                textSize = 14f
                setPadding(0, dp(4), 0, dp(5))
            }, matchWrap())
            requestPanel.addView(button(getString(R.string.approve_control_request)) { approveRequest(request.id) }.apply {
                isEnabled = rewardedAccessGate.hasAccess()
                contentDescription = "Approve audio request from ${request.requesterName}"
            }, requestButtonLayout())
            requestPanel.addView(button(getString(R.string.reject_control_request), ButtonTone.DANGER) { rejectRequest(request.id) }.apply {
                isEnabled = rewardedAccessGate.hasAccess()
                contentDescription = "Disapprove audio request from ${request.requesterName}"
            }, requestButtonLayout().apply { topMargin = dp(8) })
            approvalContainer.addView(requestPanel, matchWrap())
        }
    }

    private fun showAudioRequestAlert(state: RoomState) {
        val pending = state.requests.filter { it.status == "PENDING" && it.expiresAt > System.currentTimeMillis() }
        if (audioRequestDialog?.isShowing == true) {
            if (pending.none { it.id == displayedAudioRequestId } || !isCurrentModerator(state)) audioRequestDialog?.dismiss()
            return
        }
        if (!activityResumed || isFinishing || isDestroyed || projectionConsentInFlight || notificationPermissionRequestInFlight || !isCurrentModerator(state)) return
        val request = pending.firstOrNull { it.id !in announcedAudioRequests && it.requesterId != state.self?.id } ?: return
        announcedAudioRequests.add(request.id)
        while (announcedAudioRequests.size > 128) announcedAudioRequests.remove(announcedAudioRequests.first())
        displayedAudioRequestId = request.id
        val canPause = SourcePlaybackController.isNotificationAccessEnabled(this)
        val text = "${request.requesterName} wants to play music. Approving gives them audio control." +
            if (canPause) " Your current media app will receive a pause command when this phone loses control."
            else " Enable automatic music pausing to pause other apps on this phone when control changes."
        audioRequestDialog = android.app.AlertDialog.Builder(this)
            .setTitle("Request to play music").setMessage(text)
            .setPositiveButton("Approve") { _, _ -> approveRequest(request.id) }
            .setNegativeButton("Reject") { _, _ -> rejectRequest(request.id) }
            .setNeutralButton(if (canPause) "Review in People" else "Enable automatic pause") { _, _ ->
                navigateNative("people")
                if (!canPause) openPlaybackHandoffSettings()
            }.create().also { dialog ->
                dialog.setOnDismissListener {
                    audioRequestDialog = null; displayedAudioRequestId = null
                    window.decorView.post {
                        roomSession?.currentRoomState()?.let(::showAudioRequestAlert)
                        requestNotificationPermissionIfNeeded()
                    }
                }
                dialog.show()
                window.decorView.postDelayed({ if (displayedAudioRequestId == request.id) audioRequestDialog?.dismiss() }, (request.expiresAt-System.currentTimeMillis()).coerceAtLeast(1L))
            }
    }

    private fun renderModerationControls(state: RoomState, isHost: Boolean, isModerator: Boolean) {
        moderationContainer.removeAllViews()
        moderationContainer.visibility = View.GONE
        if (!isModerator) return
        moderationContainer.visibility = View.VISIBLE
        moderationContainer.addView(sectionLabel(if (isHost) "Host controls" else "Co-host controls"))
        if (!SourcePlaybackController.isNotificationAccessEnabled(this)) {
            moderationContainer.addView(sectionLabel("To pause YouTube Music or another media app automatically when control changes, enable Android Notification Access. Room audio always switches to the approved player."), matchWrap())
            moderationContainer.addView(button("Enable automatic music pausing", ButtonTone.SECONDARY) { openPlaybackHandoffSettings() }, matchWrap())
        }
        if (isHost) {
            val currentCohost = state.members.firstOrNull { it.id == state.room.cohostId }
            if (currentCohost != null) {
                moderationContainer.addView(button("Remove co-host: ${currentCohost.name}") {
                    assignCohost(null)
                }, matchWrap())
            }
            state.members.filter { member ->
                member.id != state.self?.id && member.id != state.room.hostId && member.id != state.room.cohostId
            }.forEach { member ->
                moderationContainer.addView(button("Make ${member.name} co-host") {
                    assignCohost(member.id)
                }, matchWrap())
            }
        }
        state.members.filter { member -> member.id != state.self?.id && member.id != state.room.hostId }.forEach { member ->
            if (member.online && member.id != state.room.activeSourceId) {
                moderationContainer.addView(button("Allow ${member.name} to play audio") {
                    roomSession?.grantSource(member.id)
                }, matchWrap())
            }
            moderationContainer.addView(button("Remove ${member.name}") { removeMember(member.id) }, matchWrap())
        }
    }

    private fun renderTransport() {
        val snapshot = roomSession?.transportSnapshot()
        if (snapshot == null) {
            transportText.text = "Audio sharing is unavailable."
            renderHealth()
            return
        }
        transportText.text = when {
            !snapshot.mediaBackendConfigured -> "Audio sharing is unavailable."
            snapshot.backendReady -> "Audio sharing is ready."
            else -> "Audio sharing is preparing."
        }
        renderHealth()
    }

    private fun renderHealth() {
        if (!::healthText.isInitialized) return
        val session = roomSession
        val room = latestRoomState
        val transport = session?.transportSnapshot()
        val capture = latestSnapshot
        healthText.text = buildString {
            append("Connection: ")
                .append(session?.connectionState()?.name?.lowercase(Locale.US) ?: "not connected")
            append("\nCapture: ").append(capture.status.name.lowercase(Locale.US))
            append(" · frames ").append(capture.framesCaptured)
            append(" · non-silent ").append(capture.nonSilentFrames)
            room?.let {
                append("\nRoom: ").append(it.room.code)
                append(" · source ").append(it.room.sourceStatus.lowercase(Locale.US))
                append(" · epoch ").append(it.room.sourceEpoch)
            }
            if (transport == null) {
                append("\nMedia: not configured")
                return@buildString
            }
            append("\nMedia: ").append(if (transport.mediaRelayEnabled) "PCM16 relay" else "direct WebRTC")
            append("\nBackend: ").append(
                when {
                    !transport.mediaBackendConfigured -> "unavailable"
                    transport.backendReady -> "ready"
                    else -> "preparing"
                },
            )
            append("\nPublished: ").append(transport.acceptedFrames)
            append(" · dropped: ").append(
                transport.droppedUnauthorizedFrames +
                    transport.droppedNotLiveFrames +
                    transport.droppedStaleEpochFrames +
                    transport.droppedUnavailableFrames,
            )
            if (transport.mediaRelayEnabled) {
                append("\nReceived relay: ").append(transport.receivedRelayFrames)
                append(" · rejected: ").append(
                    transport.droppedRelayUnauthorizedFrames +
                        transport.droppedRelayStaleEpochFrames +
                        transport.droppedRelayMalformedFrames +
                        transport.droppedRelayUnavailableFrames,
                )
            }
            transport.publisherDiagnostics
                ?.takeIf { it.isNotBlank() }
                ?.take(1800)
                ?.let { append("\n\nNative diagnostics:\n").append(it) }
        }
    }

    /** Capture snapshots arrive frequently; only update the controls that depend on them. */
    private fun renderCaptureControls(state: RoomState?) {
        renderSourceControl(state)
    }

    private fun renderSourceControl(state: RoomState?) {
        if (!::sourceButton.isInitialized) return
        if (state == null) {
            sourceButton.text = "Share device audio"
            sourceButton.isEnabled = false
            return
        }
        val room = state.room
        val self = state.self
        val isHost = self != null && self.id == room.hostId
        val isModerator = self != null && (isHost || self.id == room.cohostId)
        val isSelfSource = self != null && self.id == room.activeSourceId
        val captureActive = latestSnapshot.status in setOf(
            CaptureStatus.STARTING,
            CaptureStatus.READY,
            CaptureStatus.CAPTURING,
            CaptureStatus.NO_ACTIVE_PLAYBACK,
        )
        val consentPending = projectionConsentInFlight || pendingCaptureStart
        if (isSelfSource) {
            sourceButton.text = when {
                !rewardedAccessGate.hasAccess() && !captureActive -> "Unlock access to share device audio"
                consentPending -> "Awaiting Android consent…"
                captureActive && room.sourceStatus.equals("STARTING", ignoreCase = true) -> "Preparing device audio…"
                captureActive -> "Stop sharing device audio"
                room.sourceStatus.equals("STARTING", ignoreCase = true) -> "Share approved device audio"
                else -> "Resume device audio"
            }
            sourceButton.isEnabled = (rewardedAccessGate.hasAccess() || captureActive) && !consentPending && (!captureActive || room.sourceStatus.equals("LIVE", ignoreCase = true) ||
                room.sourceStatus.equals("STARTING", ignoreCase = true)
            )
        } else if (isModerator) {
            sourceButton.text = when {
                !rewardedAccessGate.hasAccess() -> "Unlock access to share device audio"
                consentPending -> "Awaiting Android consent…"
                captureActive -> "Preparing device audio…"
                room.activeSourceId != null -> "Take over & share device audio"
                else -> "Share device audio"
            }
            sourceButton.isEnabled = rewardedAccessGate.hasAccess() && !consentPending && !captureActive
        } else {
            sourceButton.text = "Wait for source control"
            sourceButton.isEnabled = false
        }
    }

    private fun requestTransportRender() {
        if (!::transportText.isInitialized || transportRenderPosted) return
        val now = SystemClock.uptimeMillis()
        val elapsed = now - lastTransportRenderAt
        val delay = if (lastTransportRenderAt == 0L || elapsed >= TRANSPORT_RENDER_INTERVAL_MS) {
            0L
        } else {
            TRANSPORT_RENDER_INTERVAL_MS - elapsed
        }
        transportRenderPosted = true
        transportRenderHandler.postDelayed(transportRenderRunnable, delay)
    }

    private fun renderTransportNow() {
        if (!::transportText.isInitialized) return
        transportRenderHandler.removeCallbacks(transportRenderRunnable)
        transportRenderPosted = false
        lastTransportRenderAt = SystemClock.uptimeMillis()
        renderTransport()
    }

    private fun handleSourceAction() {
        val session = roomSession ?: run { showRoomActionMessage("The audio service is reconnecting. Try again shortly."); return }
        if (session.connectionState() != RoomConnectionState.JOINED) { showRoomActionMessage("Reconnecting to your room. Share after the connection returns; Leave room is still available."); return }
        val state = session.currentRoomState() ?: run { showRoomActionMessage("Waiting for the room's current approval state."); return }
        val self = state.self ?: return
        val isModerator = self.id == state.room.hostId || self.id == state.room.cohostId
        val isSelfSource = self.id == state.room.activeSourceId
        val captureActive = latestSnapshot.status in setOf(
            CaptureStatus.STARTING,
            CaptureStatus.READY,
            CaptureStatus.CAPTURING,
            CaptureStatus.NO_ACTIVE_PLAYBACK,
        )
        if (isSelfSource && captureActive) {
            stopCapture()
        } else if (isSelfSource || isModerator) {
            if (!requireRewardedAccess()) return
            beginCapture(forRoomSource = true)
        } else {
            appendRoomEvent("Tap Request to share device audio first so the host can approve your turn.")
        }
    }

    private fun requestAudioControl() {
        if (!requireRewardedAccess()) return
        val session = roomSession ?: return
        val state = session.currentRoomState()
        val self = state?.self
        if (state == null || self == null || self.id == state.room.hostId || self.id == state.room.cohostId) {
            appendRoomEvent("A request is available to a participant while the room is active.")
            return
        }
        val existingPending = state.requests.firstOrNull {
            it.requesterId == self.id && it.status.equals("PENDING", ignoreCase = true)
        }
        if (existingPending != null) {
            if (session.cancelRequest(existingPending.id)) {
                appendRoomEvent("Canceled pending audio request.")
            } else {
                appendRoomEvent("Could not cancel the audio request.")
            }
            return
        }
        if (session.requestControl("ANDROID_DEVICE_AUDIO", "I want to share Android playback audio.")) {
            appendRoomEvent("Requested device-audio control from the host.")
        } else showRoomActionMessage("The request could not be sent. Wait for the room connection, then try again.")
    }

    private fun takeoverSource() {
        if (!requireRewardedAccess()) return
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.room.activeSourceId == null || state.self?.id == state.room.activeSourceId) {
            appendRoomEvent("Refresh the room state; takeover is available only to a host or co-host while another source is active.")
            return
        }
        if (session.takeover()) appendRoomEvent("Taking back control now. Android consent is required before this phone goes live.")
    }

    private fun approveRequest(requestId: String) {
        if (!requireRewardedAccess()) return
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.requests.none { it.id == requestId && it.status.equals("PENDING", true) }) {
            appendRoomEvent("Refresh the room state; this request is no longer actionable.")
            return
        }
        if (session.approveRequest(requestId)) appendRoomEvent("Approved request. The participant must tap Share and complete Android consent.")
    }

    private fun rejectRequest(requestId: String) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.requests.none { it.id == requestId && it.status.equals("PENDING", true) }) {
            appendRoomEvent("Refresh the room state; this request is no longer actionable.")
            return
        }
        session.rejectRequest(requestId)
    }

    private fun assignCohost(memberId: String?) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (state.self?.id != state.room.hostId) {
            appendRoomEvent("Only the host can assign or remove a co-host.")
            return
        }
        if (memberId != null && state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) {
            appendRoomEvent("Refresh the member list before assigning a co-host.")
            return
        }
        session.assignCohost(memberId)
    }

    private fun removeMember(memberId: String) {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: return
        if (!isCurrentModerator(state) || state.members.none { it.id == memberId && it.id != state.self?.id && it.id != state.room.hostId }) {
            appendRoomEvent("Refresh the room state; that member cannot be removed now.")
            return
        }
        session.removeMember(memberId)
    }

    private fun endRoom() {
        val session = roomSession ?: return
        val state = session.currentRoomState() ?: latestRoomState ?: return
        if (state.self?.id != state.room.hostId) {
            appendRoomEvent("Only the host can end the room.")
            return
        }
        pendingCaptureStart = false
        projectionConsentInFlight = false
        notificationPermissionRequestedRoomId = null
        cancelPendingCapture("Ended the room before capture consent completed.")
        if (session.endRoom()) {
            appendRoomEvent("Ending the room…")
        }
    }

    private fun sendChat() {
        val session = roomSession ?: return
        if (session.currentRoomState() == null) {
            appendRoomEvent("Join a room before sending chat.")
            return
        }
        if (session.sendChat(chatInput.text.toString())) chatInput.setText("")
    }

    private fun leaveRoom() {
        pendingCaptureStart = false
        projectionConsentInFlight = false
        notificationPermissionRequestedRoomId = null
        cancelPendingCapture("Left the room before capture consent completed.")
        roomSession?.leaveRoom()
        latestRoomState = null
        renderRoomState(null)
        renderTransportNow()
        appendRoomEvent("Left the room.")
    }

    private fun showRoomActionMessage(message: String) {
        appendRoomEvent(message)
        android.widget.Toast.makeText(this,message,android.widget.Toast.LENGTH_LONG).show()
    }

    private fun isCurrentModerator(state: RoomState): Boolean {
        val selfId = state.self?.id ?: return false
        return selfId == state.room.hostId || selfId == state.room.cohostId
    }

    private fun beginCapture(forRoomSource: Boolean) {
        if (!requireRewardedAccess()) return
        if (projectionConsentInFlight || pendingCaptureStart) {
            showRoomActionMessage("Android capture consent is already in progress. Finish or cancel that dialog first.")
            return
        }
        val session = roomSession ?: return
        if (!forRoomSource) {
            appendRoomEvent("Playback capture is available only when this phone is sharing room audio.")
            return
        }
        val captureId = session.beginCapture()
        if (captureId == null) {
            showRoomActionMessage("Cannot start phone audio yet. Check the room connection and ask the host to approve this phone again.")
            return
        }
        pendingCaptureId = captureId
        val capability = latestCapability ?: PlaybackCaptureCapabilities.inspect(this)
        if (!capability.apiSupported || !capability.mediaProjectionAvailable) {
            cancelPendingCapture(capability.summary)
            renderSnapshot(CaptureSnapshot(CaptureStatus.UNSUPPORTED_API, message = conciseCapabilityMessage(capability)))
            return
        }
        val missingPermissions = buildList {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                add(Manifest.permission.RECORD_AUDIO)
            }
        }
        pendingRoomSourceStart = forRoomSource
        if (missingPermissions.isNotEmpty()) {
            pendingCaptureStart = true
            renderSnapshot(CaptureSnapshot(
                CaptureStatus.PERMISSION_REQUIRED,
                message = "Allow Android's playback-capture permission. SangeetPitara does not use a microphone input.",
            ))
            requestPermissions(missingPermissions.toTypedArray(), REQUEST_RUNTIME_PERMISSIONS)
            return
        }
        launchProjectionConsent()
    }

    private fun launchProjectionConsent() {
        val session = roomSession
        val captureId = pendingCaptureId
        if (session == null || captureId == null || !session.prepareProjection(captureId) ||
            !session.markProjectionDialogOpen(captureId)
        ) {
            failPendingCapture("The room source authorization changed before Android consent could start.")
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        if (manager == null) {
            failPendingCapture("MediaProjection is unavailable.")
            return
        }
        pendingCaptureStart = false
        projectionConsentInFlight = true
        renderSnapshot(CaptureSnapshot(CaptureStatus.PROJECTION_REQUIRED, message = "Approve Android's system playback-capture dialog. No microphone source is selected."))
        val captureIntent = if (Build.VERSION.SDK_INT >= 34) {
            manager.createScreenCaptureIntent(android.media.projection.MediaProjectionConfig.createConfigForDefaultDisplay())
        } else manager.createScreenCaptureIntent()
        startActivityForResult(captureIntent, REQUEST_MEDIA_PROJECTION)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_POST_NOTIFICATIONS) {
            notificationPermissionRequestInFlight = false
            return
        }
        if (requestCode != REQUEST_RUNTIME_PERMISSIONS || !pendingCaptureStart) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            launchProjectionConsent()
        } else {
            failPendingCapture("Android audio permission was denied; playback capture cannot start.")
        }
        requestNotificationPermissionIfNeeded()
    }

    @Deprecated("Uses the dependency-free platform Activity result API.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_MEDIA_PROJECTION || !projectionConsentInFlight) return
        projectionConsentInFlight = false
        if (resultCode != RESULT_OK || data == null) {
            failPendingCapture("Android system capture consent was canceled.")
            requestNotificationPermissionIfNeeded()
            return
        }
        if (roomSession == null || pendingCaptureId == null) {
            failPendingCapture("The room service is unavailable.")
            requestNotificationPermissionIfNeeded()
            return
        }
        val sessionId = requireNotNull(pendingCaptureId)
        val serviceIntent = Intent(this, PlaybackCaptureService::class.java).apply {
            action = PlaybackCaptureService.ACTION_START
            putExtra(PlaybackCaptureService.EXTRA_RESULT_CODE, resultCode)
            putExtra(PlaybackCaptureService.EXTRA_RESULT_DATA, data)
            putExtra(PlaybackCaptureService.EXTRA_SESSION_ID, sessionId)
        }
        try {
            // The validated room-entry action already started/promoted the
            // service. A stale consent result must not create a new FGS obligation.
            startService(serviceIntent)
            renderSnapshot(CaptureSnapshot(CaptureStatus.STARTING, message = "Starting foreground playback capture; source activation waits for a successful AudioRecord read."))
        } catch (error: Throwable) {
            failPendingCapture("The foreground capture service could not start: ${error.message}")
        } finally {
            pendingRoomSourceStart = false
        }
        requestNotificationPermissionIfNeeded()
    }

    /**
     * Notification permission is deliberately a separate runtime request from
     * playback capture's RECORD_AUDIO request. It is only started while the
     * joined room is visible and no capture-consent transaction is active.
     */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            !activityResumed ||
            isFinishing ||
            (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed) ||
            notificationPermissionRequestInFlight ||
            audioRequestDialog?.isShowing == true ||
            pendingCaptureStart ||
            projectionConsentInFlight
        ) return

        val state = latestRoomState ?: roomSession?.currentRoomState() ?: return
        if (roomSession?.connectionState() != RoomConnectionState.JOINED ||
            !state.room.status.equals("ACTIVE", ignoreCase = true) ||
            state.self?.id !in setOf(state.room.hostId, state.room.cohostId) ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED ||
            notificationPermissionRequestedRoomId == state.room.id
        ) return

        notificationPermissionRequestedRoomId = state.room.id
        notificationPermissionRequestInFlight = true
        try {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_POST_NOTIFICATIONS)
        } catch (error: Throwable) {
            notificationPermissionRequestInFlight = false
            notificationPermissionRequestedRoomId = null
            android.util.Log.w("RoomSound", "Notification permission request failed", error)
        }
    }

    private fun failPendingCapture(message: String) {
        pendingCaptureStart = false
        projectionConsentInFlight = false
        pendingRoomSourceStart = false
        cancelPendingCapture(message)
        renderSnapshot(CaptureSnapshot(CaptureStatus.ERROR, message = message))
    }

    private fun cancelPendingCapture(message: String) {
        val session = roomSession ?: return
        val captureId = pendingCaptureId ?: return
        session.cancelCapture(captureId, message)
        pendingCaptureId = null
    }

    private fun stopCapture() {
        pendingCaptureStart = false
        if (projectionConsentInFlight) {
            projectionConsentInFlight = false
            cancelPendingCapture("Capture consent canceled by the user.")
        } else {
            roomSession?.stopCapture()
            pendingCaptureId = null
        }
        pendingRoomSourceStart = false
        renderSnapshot(CaptureSnapshot(CaptureStatus.STOPPED, message = "Stopping device audio capture."))
    }

    private fun refreshCapability() {
        latestCapability = PlaybackCaptureCapabilities.inspect(this)
        val capability = latestCapability ?: return
        renderSnapshot(
            CaptureSnapshot(
                if (capability.apiSupported && capability.mediaProjectionAvailable) {
                    CaptureStatus.IDLE
                } else {
                    CaptureStatus.UNSUPPORTED_API
                },
                message = conciseCapabilityMessage(capability),
            ),
        )
    }

    private fun renderSnapshot(snapshot: CaptureSnapshot) {
        latestSnapshot = snapshot
        if (snapshot.status == CaptureStatus.ERROR || snapshot.status == CaptureStatus.STOPPED) {
            pendingCaptureId = null
        }
        statusText.text = buildString {
            append(conciseCaptureStatus(snapshot))
            conciseCaptureMessage(snapshot)?.let { append("\n").append(it) }
        }
        renderCaptureControls(latestRoomState ?: roomSession?.currentRoomState())
        renderPlaybackHandoffControl()
        renderHealth()
        requestTransportRender()
    }

    private fun renderPlaybackHandoffControl() {
        if (!::handoffControlText.isInitialized || !::handoffControlButton.isInitialized) return
        if (SourcePlaybackController.isNotificationAccessEnabled(this)) {
            handoffControlText.text = "Pause-on-handoff is enabled. SangeetPitara can pause controllable media apps when this phone loses source control."
            handoffControlButton.text = "Open pause-on-handoff settings"
        } else {
            handoffControlText.text = "Optional: enable Android Notification Access (different from normal notifications) so SangeetPitara can pause the current media app when another room source is approved."
            handoffControlButton.text = "Enable pause on source handoff"
        }
    }

    private fun openPlaybackHandoffSettings() {
        try {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        } catch (error: Throwable) {
            appendRoomEvent("Android Notification Access settings could not open: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun conciseCapabilityMessage(capability: CaptureCapabilityReport): String? = when {
        !capability.apiSupported -> "Playback sharing needs Android 10 or newer."
        !capability.mediaProjectionAvailable -> "Android system capture is unavailable on this device."
        else -> null
    }

    private fun conciseCaptureStatus(snapshot: CaptureSnapshot): String = when (snapshot.status) {
        CaptureStatus.IDLE -> "Ready to share device audio."
        CaptureStatus.UNSUPPORTED_API -> "Playback sharing is unavailable."
        CaptureStatus.PERMISSION_REQUIRED -> "Audio permission is required."
        CaptureStatus.PROJECTION_REQUIRED -> "Android capture approval is required."
        CaptureStatus.STARTING -> "Starting device audio sharing…"
        CaptureStatus.READY -> "Device audio sharing is ready."
        CaptureStatus.CAPTURING -> "Sharing device audio."
        CaptureStatus.NO_ACTIVE_PLAYBACK -> "Sharing device audio · no active playback detected."
        CaptureStatus.STOPPED -> "Device audio sharing is stopped."
        CaptureStatus.ERROR -> "Device audio sharing needs attention."
    }

    private fun conciseCaptureMessage(snapshot: CaptureSnapshot): String? = when (snapshot.status) {
        CaptureStatus.PERMISSION_REQUIRED -> "Allow Android audio permission to continue."
        CaptureStatus.PROJECTION_REQUIRED -> "Approve the Android playback-capture dialog to continue."
        CaptureStatus.UNSUPPORTED_API -> snapshot.message ?: "Playback sharing is unavailable on this device."
        CaptureStatus.NO_ACTIVE_PLAYBACK -> "Start playback in a supported app to send audio."
        CaptureStatus.ERROR -> snapshot.message
            ?.lineSequence()
            ?.firstOrNull()
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?.take(180)
        else -> null
    }

    private fun applyPlaybackVolume() {
        val level = if (muted) 0.0 else volumeSeekBar.progress / 100.0
        roomSession?.setPlaybackVolume(level)
    }

    private fun updateMuteButton() {
        if (::muteButton.isInitialized) muteButton.text = if (muted) "Unmute listening" else "Mute listening"
    }

    private fun appendRoomEvent(message: String) {
        if (roomEvents.size >= 10) roomEvents.removeFirst()
        roomEvents.addLast(message)
        if (::roomEventsText.isInitialized) {
            roomEventsText.text = message
            roomEventsText.visibility = View.VISIBLE
        }
        renderActivity()
    }

    private enum class ButtonTone {
        PRIMARY,
        SECONDARY,
        DANGER,
    }

    private fun inputText(hint: String, value: String?): EditText = EditText(this).apply {
        setHint(hint)
        setText(value ?: "")
        setSingleLine(true)
        setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream))
        setHintTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream_muted))
        textSize = 15f
        minHeight = dp(48)
        setPadding(dp(13), dp(8), dp(13), dp(8))
        setBackgroundResource(R.drawable.bg_roomsound_field)
    }

    private fun button(text: String, tone: ButtonTone = ButtonTone.PRIMARY, action: () -> Unit): Button = Button(this).apply {
        this.text = text
        setOnClickListener { action() }
        setAllCaps(false)
        textSize = 15f
        setTypeface(strongTypeface)
        minHeight = dp(48)
        minimumHeight = dp(48)
        stateListAnimator = null
        setPadding(dp(12), 0, dp(12), 0)
        gravity = Gravity.CENTER
        setTextColor(
            when (tone) {
                ButtonTone.PRIMARY -> AppThemes.color(this@MainActivity, R.color.roomsound_on_accent)
                ButtonTone.SECONDARY -> AppThemes.color(this@MainActivity, R.color.roomsound_cream)
                ButtonTone.DANGER -> AppThemes.color(this@MainActivity, R.color.roomsound_danger)
            },
        )
        setBackgroundResource(
            when (tone) {
                ButtonTone.PRIMARY -> R.drawable.bg_roomsound_button_primary
                ButtonTone.SECONDARY -> R.drawable.bg_roomsound_button_secondary
                ButtonTone.DANGER -> R.drawable.bg_roomsound_button_danger
            },
        )
        elevation = 0f
    }

    private fun sectionTitle(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream))
        setTypeface(headingTypeface)
        letterSpacing = 0.025f
        setPadding(0, 0, 0, dp(8))
    }

    private fun sectionLabel(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 15f
        setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_brass_bright))
        setTypeface(labelTypeface)
        setPadding(0, dp(3), 0, dp(6))
    }

    private fun panelContainer(background: Int = R.drawable.bg_roomsound_panel) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(20), dp(20), dp(22))
        setBackgroundResource(background)
        elevation = 0f
        clipToPadding = true
    }

    private fun statusPanel() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(12), dp(11), dp(12), dp(11))
        setBackgroundResource(R.drawable.bg_roomsound_inset)
    }

    private fun dynamicPanel() = verticalContainer().apply {
        setPadding(dp(10), dp(7), dp(10), dp(9))
        setBackgroundResource(R.drawable.bg_roomsound_inset)
        visibility = View.GONE
    }

    private fun diagnosticText(): TextView = labelText().apply {
        setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream_soft))
        textSize = 12.5f
        setLineSpacing(0f, 1.15f)
        setBackgroundResource(R.drawable.bg_roomsound_inset)
    }

    private fun verticalContainer() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        clipToPadding = false
    }

    private fun labelText(): TextView = TextView(this).apply {
        textSize = 13.5f
        setTextColor(AppThemes.color(this@MainActivity, R.color.roomsound_cream_soft))
        setLineSpacing(0f, 1.12f)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    )

    private fun requestButtonLayout() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        dp(52),
    )

    private fun marginLayout() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
        topMargin = dp(12)
        gravity = Gravity.CENTER_HORIZONTAL
    }

    private fun panelLayout() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
        bottomMargin = dp(18)
    }

    /** Checks GitHub Releases off the main thread; shows a notice only for a newer version. */
    private fun checkForAppUpdate() {
        val checker = ReleaseUpdateChecker(BuildConfig.ROOMSOUND_RELEASES_REPOSITORY, BuildConfig.VERSION_NAME)
        Thread({
            val update = checker.check() ?: return@Thread
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                updateApkUrl = update.apkUrl
                updateText.text = getString(R.string.update_available, update.tag.removePrefix("v"))
                if (nativePage == "status") updatePanel.visibility = View.VISIBLE
            }
        }, "SangeetPitara-update-check").apply { isDaemon = true }.start()
    }

    private fun openUpdateDownload() {
        val url = updateApkUrl ?: return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
