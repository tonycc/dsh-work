package work.dsh.mobile.net

import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedCookieJarTest {
    private val url = "https://m.example.com:4174/auth/workbench/mobile/login".toHttpUrl()

    @Test
    fun `host-only __Host- cookies are written without a Domain so the prefix stays valid`() {
        val store = FakeCookieStore()
        val cookie = Cookie.parse(url, "__Host-dsh_work_local_session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure")!!
        SharedCookieJar(store).saveFromResponse(url, listOf(cookie))
        val written = store.written.single().second
        assertTrue(written.startsWith("__Host-dsh_work_local_session=abc;"))
        assertTrue(written.contains("path=/"))
        assertTrue(written.contains("secure"))
        assertTrue(written.contains("httponly"))
        assertFalse(written.contains("domain=", ignoreCase = true))
        assertEquals(1, store.flushed)
    }

    @Test
    fun `requests carry whatever the shared store holds, whatever the cookie is called`() {
        val store = FakeCookieStore()
        store.setCookie(url.toString(), "dsh_work_local_session=one; Path=/")
        store.setCookie(url.toString(), "other=two; Path=/")
        val loaded = SharedCookieJar(store).loadForRequest("https://m.example.com:4174/api/workbench/v1/session".toHttpUrl())
        assertEquals(listOf("dsh_work_local_session" to "one", "other" to "two"), loaded.map { it.name to it.value })
    }

    @Test
    fun `an empty store sends no cookies`() {
        assertTrue(SharedCookieJar(FakeCookieStore()).loadForRequest(url).isEmpty())
    }
}
