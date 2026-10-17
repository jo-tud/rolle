package de.rolle.nfc

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.media.ToneGenerator
import android.media.AudioManager
import android.net.Uri
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.TagLostException
import android.nfc.tech.MifareClassic
import android.os.Bundle
import android.webkit.*
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity(), NfcAdapter.ReaderCallback {
    private lateinit var web: WebView
    private val adapter: NfcAdapter? by lazy { NfcAdapter.getDefaultAdapter(this) }
    private val reading = AtomicBoolean(false)
    private val worker = Executors.newSingleThreadExecutor()
    private var pendingCamera: PermissionRequest? = null
    @Volatile private var foreground = false
    @Volatile private var pageReady = false
    private val pendingScans = java.util.ArrayDeque<BambuTag.Data>()

    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "jo-tud.github.io" &&
        uri.port == -1 && (uri.path == "/rolle" || uri.path?.startsWith("/rolle/") == true)
    private fun cameraOrigin(request: PermissionRequest): Boolean = request.origin.toString().trimEnd('/') == "https://jo-tud.github.io"
    private fun message(text: String) = runOnUiThread { Toast.makeText(this, text, Toast.LENGTH_LONG).show() }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        web = WebView(this)
        setContentView(web)
        // Target 35 draws behind system bars unless insets are applied.
        web.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(true)
        }
        web.addJavascriptInterface(object {
            @JavascriptInterface fun isAvailable() = true
            @JavascriptInterface fun nfcSupported() = adapter != null &&
                packageManager.hasSystemFeature("com.nxp.mifare")
            @JavascriptInterface fun appVersion() = BuildConfig.VERSION_NAME
        }, "RolleNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (trusted(request.url)) return false
                if (request.isForMainFrame) openExternal(request.url)
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) { pageReady = false }
            override fun onPageFinished(view: WebView, url: String) {
                if (!trusted(Uri.parse(url))) return
                // Wait for Vite's module to register the event listener, not just document parsing.
                view.evaluateJavascript("document.readyState === 'complete' && window.RolleNfcReady === true") { ready ->
                    pageReady = ready == "true"
                    if (pageReady) while (pendingScans.isNotEmpty()) deliver(pendingScans.removeFirst())
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) = runOnUiThread {
                if (!foreground || !cameraOrigin(request) || !trusted(Uri.parse(web.url ?: "")) ||
                    !request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                    request.deny(); return@runOnUiThread
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    pendingCamera?.deny()
                    pendingCamera = request
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
                }
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCamera === request) pendingCamera = null
            }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!isUserGesture) return false
                val popup = WebView(this@MainActivity)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                        openExternal(r.url); v.destroy(); return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
        }
        web.loadUrl("https://jo-tud.github.io/rolle/")
        when {
            adapter == null -> message("Dieses Gerät hat kein NFC. Rolle ist weiterhin nutzbar.")
            !packageManager.hasSystemFeature("com.nxp.mifare") -> message("MIFARE Classic wird auf diesem Gerät möglicherweise nicht unterstützt. Rolle ist weiterhin nutzbar.")
        }
    }

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in listOf("https", "http", "mailto")) return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: ActivityNotFoundException) { message("Kein Browser zum Öffnen des Links vorhanden") }
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code != 1) return
        pendingCamera?.let {
            if (foreground && cameraOrigin(it) && trusted(Uri.parse(web.url ?: "")) && results.firstOrNull() == PackageManager.PERMISSION_GRANTED)
                it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            else { it.deny(); message("Kamera-Zugriff wurde nicht erlaubt") }
        }
        pendingCamera = null
    }

    override fun onResume() {
        super.onResume()
        foreground = true
        web.onResume()
        adapter?.let {
            if (!it.isEnabled) message("NFC ist ausgeschaltet. Bitte in den Einstellungen einschalten.")
            try { it.enableReaderMode(this, this, NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK, null) }
            catch (_: IllegalStateException) { message("NFC ist zurzeit nicht verfügbar") }
        }
    }
    override fun onPause() {
        foreground = false
        adapter?.disableReaderMode(this)
        pendingCamera?.deny(); pendingCamera = null
        web.onPause()
        super.onPause()
    }
    override fun onDestroy() {
        worker.shutdownNow()
        web.removeJavascriptInterface("RolleNative")
        web.destroy()
        super.onDestroy()
    }

    override fun onTagDiscovered(tag: Tag) {
        if (!foreground || !reading.compareAndSet(false, true)) return
        worker.execute {
            try {
                val classic = MifareClassic.get(tag)
                if (classic == null) { message("Dieser Tag oder dieses Handy unterstützt MIFARE Classic nicht."); return@execute }
                require(classic.size == MifareClassic.SIZE_1K) { "Kein unterstützter MIFARE-Classic-1K-Tag" }
                val keys = BambuTag.keys(tag.id)
                val blocks = mutableMapOf<Int, ByteArray>()
                try {
                    classic.connect()
                    for (sector in 0..4) {
                        if (!classic.authenticateSectorWithKeyA(sector, keys[sector])) {
                            message("Tag konnte nicht entschlüsselt werden. Bitte eine Bambu-Spule verwenden."); return@execute
                        }
                        for (i in 0..2) {
                            val block = classic.sectorToBlock(sector) + i
                            blocks[block] = classic.readBlock(block)
                        }
                    }
                } finally { try { classic.close() } catch (_: IOException) { } }
                val data = BambuTag.parse(blocks, tag.id)
                runOnUiThread {
                    if (!foreground || isDestroyed) return@runOnUiThread
                    ToneGenerator(AudioManager.STREAM_NOTIFICATION, 60).also { tone ->
                        tone.startTone(ToneGenerator.TONE_PROP_ACK, 100)
                        web.postDelayed({ tone.release() }, 200)
                    }
                    if (!pageReady) {
                        if (pendingScans.size < 20) pendingScans.addLast(data)
                        message("Tag gelesen. Rolle lädt noch oder unterstützt NFC noch nicht. Bitte die aktuelle Web-App bereitstellen und neu öffnen.")
                    } else deliver(data)
                }
            } catch (_: TagLostException) { message("Tag zu früh entfernt. Bitte die Spule länger ans Handy halten.") }
            catch (_: IOException) { message("Lesen fehlgeschlagen. Bitte die Spule ruhig ans Handy halten.") }
            catch (e: IllegalArgumentException) { message(e.message ?: "Unbekannter Tag-Typ") }
            catch (_: Exception) { message("NFC-Tag konnte nicht gelesen werden") }
            finally { reading.set(false) }
        }
    }

    private fun deliver(data: BambuTag.Data) {
        if (!trusted(Uri.parse(web.url ?: ""))) return
        val json = JSONObject().apply {
            put("source", "bambu-rfid"); put("trayUid", data.trayUid); put("tagUid", data.tagUid)
            put("variantId", data.variantId); put("materialId", data.materialId); put("type", data.type)
            put("detailedType", data.detailedType); put("colorRgba", data.colorRgba); put("colors", JSONArray(data.colors))
            put("weightG", data.weightG); put("diameterMm", data.diameterMm.toDouble())
            put("productionDate", data.productionDate); put("lengthM", data.lengthM)
        }
        // Quote a JSON string literal; tag bytes never become JavaScript source.
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('rolle:nfc',{detail:JSON.parse(" +
            JSONObject.quote(json.toString()) + ")}))", null)
    }
}
