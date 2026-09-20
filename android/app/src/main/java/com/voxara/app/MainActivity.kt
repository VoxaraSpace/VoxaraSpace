package com.voxara.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Voxara for Android: the web client (the same one the desktop app and the
 * browser use) inside a system WebView, with the parts a phone needs around
 * it: a launcher icon, voxara:// and invite-link handling, and the
 * microphone/camera permission bridge so calls work.
 *
 * The WebView only ever loads voxaraspace.com. Anything else goes to the
 * system browser.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        const val HOME = "https://voxaraspace.com/app/"
        private val ALLOWED_HOSTS = setOf("voxaraspace.com", "www.voxaraspace.com")
    }

    private lateinit var web: WebView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var offline: View
    private var pendingPermission: PermissionRequest? = null

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val req = pendingPermission ?: return@registerForActivityResult
        pendingPermission = null
        val allowed = req.resources.filter { res ->
            when (res) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted[Manifest.permission.RECORD_AUDIO] == true
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted[Manifest.permission.CAMERA] == true
                else -> false
            }
        }
        if (allowed.isEmpty()) req.deny() else req.grant(allowed.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        swipe = findViewById(R.id.swipe)
        offline = findViewById(R.id.offline)
        findViewById<TextView>(R.id.offlineTitle).text = getString(R.string.offline_title)
        findViewById<TextView>(R.id.offlineBody).text = getString(R.string.offline_body)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString VoxaraAndroid/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.scheme == "voxara") { handleDeepLink(url); return true }
                if (url.host in ALLOWED_HOSTS) return false
                // Everything off-site opens in the phone's browser.
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { offline.visibility = View.GONE }
            override fun onPageFinished(view: WebView, url: String?) { swipe.isRefreshing = false }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { offline.visibility = View.VISIBLE; swipe.isRefreshing = false }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                // Only our own origin may ask for the mic or camera.
                val host = runCatching { Uri.parse(request.origin.toString()).host }.getOrNull()
                if (host !in ALLOWED_HOSTS) { request.deny(); return }
                val wanted = mutableListOf<String>()
                for (res in request.resources) when (res) {
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> wanted += Manifest.permission.RECORD_AUDIO
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> wanted += Manifest.permission.CAMERA
                }
                if (wanted.isEmpty()) { request.deny(); return }
                val missing = wanted.filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE || it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }.toTypedArray()); return }
                pendingPermission = request
                askPermissions.launch(missing.toTypedArray())
            }
        }

        swipe.setOnRefreshListener { web.reload() }
        // Only the offline card pulls to refresh; the chat scrolls on its own.
        swipe.isEnabled = false
        offline.setOnClickListener { web.reload() }

        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            registerForActivityResult(ActivityResultContracts.RequestPermission()) {}.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(targetFor(intent) ?: HOME)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        targetFor(intent)?.let { web.loadUrl(it) }
    }

    /** voxara://join/CODE and https://voxaraspace.com/invite/CODE both land on the app's join flow. */
    private fun targetFor(intent: Intent?): String? {
        val data = intent?.data ?: return null
        if (data.scheme == "voxara") return deepLinkTarget(data)
        if (data.host in ALLOWED_HOSTS && data.path?.startsWith("/invite/") == true) {
            val code = data.lastPathSegment ?: return HOME
            return "$HOME?join=$code"
        }
        return null
    }

    private fun deepLinkTarget(uri: Uri): String {
        val parts = uri.pathSegments
        return if (uri.host == "join" && parts.isNotEmpty()) "$HOME?join=${parts[0]}" else HOME
    }

    private fun handleDeepLink(uri: Uri) { web.loadUrl(deepLinkTarget(uri)) }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) { web.goBack(); return true }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() { web.destroy(); super.onDestroy() }
}
