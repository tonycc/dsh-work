package work.dsh.mobile.net

import android.webkit.CookieManager
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * 原生请求与 WebView 共用的 Cookie 存储（移动端方案“认证边界”）。
 *
 * 登录响应里的会话 Cookie 原样写入这里，WebView 打开员工端时自然带上，无需再登录。
 * 代码里不出现 Cookie 名称：生产环境是 `__Host-` 前缀，本地与测试环境不是。
 */
interface CookieStore {
    /** [setCookie] 为一条完整的 Set-Cookie 值（含 Path、Max-Age、Secure 等属性）。 */
    fun setCookie(url: String, setCookie: String)

    /** 返回请求该地址时应带的 `Cookie` 头（`a=b; c=d`），没有时为 null。 */
    fun cookieHeader(url: String): String?

    fun clear()

    fun flush()
}

/** 生产实现：WebView 的 [CookieManager]，进程内唯一，写后 flush 落盘。 */
class WebViewCookieStore(private val manager: CookieManager = CookieManager.getInstance()) : CookieStore {
    init {
        manager.setAcceptCookie(true)
    }

    override fun setCookie(url: String, setCookie: String) = manager.setCookie(url, setCookie)

    override fun cookieHeader(url: String): String? = manager.getCookie(url)

    override fun clear() {
        manager.removeAllCookies(null)
        manager.flush()
    }

    override fun flush() = manager.flush()
}

/** 让 OkHttp 读写 [CookieStore]，原生请求与 WebView 看到的是同一份会话。 */
class SharedCookieJar(private val store: CookieStore) : CookieJar {
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        // Cookie.toString() 生成标准 Set-Cookie：只对主机生效的 Cookie 不带 Domain，满足 __Host- 前缀要求。
        cookies.forEach { store.setCookie(url.toString(), it.toString()) }
        store.flush()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val header = store.cookieHeader(url.toString()) ?: return emptyList()
        return header.split(';')
            .map { it.trim() }
            .filter { it.contains('=') }
            .mapNotNull { Cookie.parse(url, it) }
    }
}
