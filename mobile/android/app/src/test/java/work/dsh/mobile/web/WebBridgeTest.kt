package work.dsh.mobile.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebBridgeTest {
    private val origin = "https://m.example.com:4174"

    private fun bridge(url: String?, calls: MutableList<String>) = WebBridge(
        allowedOrigin = origin,
        currentUrl = { url },
        onAuthExpired = { calls += "auth" },
        onPasswordChangeRequired = { calls += "password" },
        onSaveFile = { name, type, data -> calls += "save:$name:$type:$data" },
        post = { it.run() },
    )

    @Test
    fun `pages from the registered server reach native`() {
        val calls = mutableListOf<String>()
        val bridge = bridge("$origin/c/groups", calls)
        bridge.onAuthExpired()
        bridge.onPasswordChangeRequired()
        bridge.saveFile("a.txt", "text/plain", "YQ==")
        assertEquals(listOf("auth", "password", "save:a.txt:text/plain:YQ=="), calls)
    }

    @Test
    fun `other origins, including look-alike hosts, are ignored`() {
        for (url in listOf("https://evil.example/c/chats", "$origin.evil.example/", "https://m.example.com:4175/", null)) {
            val calls = mutableListOf<String>()
            bridge(url, calls).onAuthExpired()
            assertTrue("$url must be ignored", calls.isEmpty())
        }
        assertFalse(WebBridge.isSameOrigin("${origin}0/", origin))
    }
}
