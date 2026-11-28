package work.dsh.mobile.net

/** 测试替身：记录写入的 Set-Cookie，按“名=值”拼出 Cookie 头（不区分地址）。 */
class FakeCookieStore : CookieStore {
    val written = mutableListOf<Pair<String, String>>()
    private val jar = linkedMapOf<String, String>()
    var flushed = 0

    override fun setCookie(url: String, setCookie: String) {
        written += url to setCookie
        val pair = setCookie.substringBefore(';')
        val name = pair.substringBefore('=')
        val value = pair.substringAfter('=', "")
        if (value.isEmpty() || setCookie.contains("max-age=0", ignoreCase = true)) jar.remove(name) else jar[name] = value
    }

    override fun cookieHeader(url: String): String? =
        jar.entries.joinToString("; ") { "${it.key}=${it.value}" }.ifEmpty { null }

    override fun clear() = jar.clear()

    override fun flush() {
        flushed++
    }
}
