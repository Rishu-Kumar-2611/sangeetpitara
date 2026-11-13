package com.roomsound.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Toast
import java.io.ByteArrayInputStream

/** The website manual and images are packaged in the APK, including PDF/ZIP exports. */
class UserManualActivity : Activity() {
    private lateinit var manual: WebView
    private var pendingExport: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        AppThemes.apply(this)
        super.onCreate(savedInstanceState)
        pendingExport = savedInstanceState?.getString("manual-export")
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(android.graphics.Color.WHITE)
        }
        content.addView(Button(this).apply {
            text = "Back to SangeetPitara"
            isAllCaps = false
            minHeight = (48 * resources.displayMetrics.density).toInt()
            gravity = Gravity.CENTER
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        manual = WebView(this).apply {
            settings.javaScriptEnabled = true // Local guide.js provides topic navigation.
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val path = localPath(request.url)
                    if (path == null) return missing()
                    return runCatching {
                        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.', ""))
                            ?: "application/octet-stream"
                        WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("javascript")) "UTF-8" else null,
                            assets.open("manual$path"))
                    }.getOrElse { missing() }
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val path = localPath(request.url) ?: return true
                    if (path == "/") { finish(); return true }
                    if (path in EXPORTS) { export(path); return true }
                    return false
                }
            }
            setDownloadListener { url, _, _, _, _ ->
                localPath(Uri.parse(url))?.takeIf { it in EXPORTS }?.let(::export)
            }
        }
        content.addView(manual, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        content.applySystemInsets()
        setContentView(content)
        if (savedInstanceState == null || manual.restoreState(savedInstanceState) == null) {
            manual.loadUrl("$ORIGIN/guide.html")
        }
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(0) { backToApp() }
        }
    }

    private fun localPath(uri: Uri): String? {
        if (uri.scheme != "https" || uri.host != HOST || uri.port != -1) return null
        val path = uri.path ?: return null
        if (path.contains('\\') || path.split('/').any { it == "." || it == ".." }) return null
        return path
    }

    private fun missing() = WebResourceResponse(
        "text/plain", "UTF-8", 404, "Not Found", emptyMap(),
        ByteArrayInputStream("Manual page unavailable".toByteArray()),
    )

    private fun export(path: String) {
        if (pendingExport != null) return
        pendingExport = path
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (path.endsWith(".pdf")) "application/pdf" else "application/zip"
            putExtra(Intent.EXTRA_TITLE, path.substringAfterLast('/'))
        }
        runCatching { startActivityForResult(intent, EXPORT_REQUEST) }.onFailure {
            pendingExport = null
            Toast.makeText(this, "Could not open the file picker.", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Uses the platform Activity result API.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != EXPORT_REQUEST) return
        val path = pendingExport.also { pendingExport = null } ?: return
        val uri = data?.data?.takeIf { resultCode == RESULT_OK } ?: return
        Thread({
            val saved = runCatching {
                assets.open("manual$path").use { input ->
                    requireNotNull(contentResolver.openOutputStream(uri, "wt")).use { input.copyTo(it) }
                }
            }.isSuccess
            runOnUiThread {
                if (!isFinishing && !isDestroyed) Toast.makeText(this,
                    if (saved) "Manual saved." else "Could not save the manual.", Toast.LENGTH_LONG).show()
            }
        }, "SangeetPitara-manual-export").start()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        manual.saveState(outState)
        outState.putString("manual-export", pendingExport)
        super.onSaveInstanceState(outState)
    }

    private fun backToApp() { if (manual.canGoBack()) manual.goBack() else finish() }

    @Deprecated("Legacy back dispatcher")
    override fun onBackPressed() = backToApp()

    override fun onDestroy() {
        manual.destroy()
        super.onDestroy()
    }

    companion object {
        private const val HOST = "manual.sangeetpitara.invalid"
        private const val ORIGIN = "https://$HOST"
        private const val EXPORT_REQUEST = 6201
        private val EXPORTS = setOf("/guide/SangeetPitara-User-Manual.pdf", "/guide/SangeetPitara-User-Manual.zip")
    }
}
