package work.dsh.mobile.web

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import work.dsh.mobile.BuildConfig

/** App 在 User-Agent 末尾追加的标识；员工端据此进入 Android 容器模式。 */
val appUserAgentToken = "DshWorkAndroid/${BuildConfig.VERSION_NAME}"

/**
 * 承载员工端页面的 WebView。只在本 WebView 打开登记的服务器地址；其他链接交给系统浏览器。
 * 会话 Cookie 由原生登录写入同一个 [CookieManager]，打开页面无需再登录。
 */
@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
class WorkbenchWebView(
    context: Context,
    private val origin: String,
    callbacks: Callbacks,
) : WebView(context) {

    interface Callbacks {
        fun onAuthExpired()
        fun onPasswordChangeRequired()
        fun onSaveFile(fileName: String, mimeType: String, base64: String)
        /** 页面的 `<input type=file>`：原生打开文件选择器，结果交回 [callback]。 */
        fun onChooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean
        fun onHistoryChanged(canGoBack: Boolean)
    }

    @Volatile
    private var lastUrl: String? = null

    init {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.userAgentString = "${settings.userAgentString} $appUserAgentToken"
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)

        addJavascriptInterface(
            WebBridge(
                allowedOrigin = origin,
                currentUrl = { lastUrl },
                onAuthExpired = callbacks::onAuthExpired,
                onPasswordChangeRequired = callbacks::onPasswordChangeRequired,
                onSaveFile = callbacks::onSaveFile,
            ),
            WebBridge.NAME,
        )

        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (WebBridge.isSameOrigin(url, origin)) return false
                openExternally(view.context, request.url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                lastUrl = url
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                lastUrl = url
                callbacks.onHistoryChanged(view.canGoBack())
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean = callbacks.onChooseFiles(filePathCallback, fileChooserParams)
        }
    }

    private fun openExternally(context: Context, uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http" && uri.scheme != "mailto" && uri.scheme != "tel") return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // 没有可打开该链接的应用。
        }
    }
}
