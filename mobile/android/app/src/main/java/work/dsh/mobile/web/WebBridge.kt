package work.dsh.mobile.web

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface

/**
 * 注入员工端页面的 `window.dshAndroid`（apps/workbench-web/src/container/android.ts）。
 *
 * 方法在 WebView 的后台线程上被调用：先确认当前页面属于登记的服务器地址，再切回主线程交给原生。
 * 其他来源的页面（理论上不会在本 WebView 打开）调用时直接忽略。
 */
class WebBridge(
    private val allowedOrigin: String,
    private val currentUrl: () -> String?,
    private val onAuthExpired: () -> Unit,
    private val onPasswordChangeRequired: () -> Unit,
    private val onSaveFile: (fileName: String, mimeType: String, base64: String) -> Unit,
    private val post: (Runnable) -> Unit = Handler(Looper.getMainLooper())::post,
) {
    @JavascriptInterface
    fun onAuthExpired() = whenTrusted { onAuthExpired.invoke() }

    @JavascriptInterface
    fun onPasswordChangeRequired() = whenTrusted { onPasswordChangeRequired.invoke() }

    @JavascriptInterface
    fun saveFile(fileName: String, mimeType: String, base64: String) = whenTrusted {
        onSaveFile(fileName, mimeType, base64)
    }

    private fun whenTrusted(action: () -> Unit) {
        if (!isSameOrigin(currentUrl(), allowedOrigin)) return
        post(Runnable(action))
    }

    companion object {
        const val NAME = "dshAndroid"

        fun isSameOrigin(url: String?, origin: String): Boolean {
            if (url == null) return false
            return url == origin || url.startsWith("$origin/") || url.startsWith("$origin?") || url.startsWith("$origin#")
        }
    }
}
