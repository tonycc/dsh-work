package work.dsh.mobile.session

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** 员工端服务器地址：只接受 HTTPS，规范成不带路径的根地址（如 `https://m.example.com:4174/`）。 */
object ServerAddress {
    fun parse(input: String): HttpUrl? {
        val text = input.trim().let { if (it.contains("://")) it else "https://$it" }
        val url = text.toHttpUrlOrNull() ?: return null
        if (url.scheme != "https" || url.host.isBlank()) return null
        return url.newBuilder().encodedPath("/").query(null).fragment(null).username("").password("").build()
    }
}
