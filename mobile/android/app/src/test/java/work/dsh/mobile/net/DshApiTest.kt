package work.dsh.mobile.net

import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class DshApiTest {
    private lateinit var server: MockWebServer
    private lateinit var store: FakeCookieStore
    private lateinit var api: DshApi
    private val device = DeviceInfo("android-0f5c1a2b-3c4d", "Pixel 8")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        store = FakeCookieStore()
        api = DshApi(server.url("/"), SharedCookieJar(store))
    }

    @After
    fun tearDown() = server.shutdown()

    @Test
    fun `login posts the device with the registered Origin and keeps the session cookie`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("Set-Cookie", "dsh_work_local_session=token-1; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800")
                .setBody("""{"mustChangePassword":false,"expiresInSeconds":28800}"""),
        )
        val result = api.login("zhang@example.com", "Secret123", device)
        assertFalse(result.mustChangePassword)
        assertEquals(28800, result.expiresInSeconds)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/auth/workbench/mobile/login", request.path)
        assertEquals(DshApi.originOf(server.url("/")), request.getHeader("Origin"))
        val body = request.body.readUtf8()
        assertTrue(body.contains("\"deviceId\":\"android-0f5c1a2b-3c4d\""))
        assertTrue(body.contains("\"deviceName\":\"Pixel 8\""))
        assertEquals("dsh_work_local_session=token-1", store.cookieHeader("any"))
    }

    @Test
    fun `session reads the user and sends the stored cookie without an Origin header`() = runTest {
        store.setCookie("x", "dsh_work_local_session=token-2; Path=/")
        server.enqueue(MockResponse().setBody("""{"data":{"user":{"id":"U1","name":"林岚","department":"研发部","title":"企业员工","role":"employee"},"identityProvider":"mobile-app"}}"""))
        val user = api.session()
        assertEquals("林岚", user.name)
        assertEquals("研发部", user.department)
        val request = server.takeRequest()
        assertEquals("dsh_work_local_session=token-2", request.getHeader("Cookie"))
        assertNull(request.getHeader("Origin"))
    }

    @Test
    fun `server errors surface their code and message`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"invalid_credentials","message":"账号或密码错误，或账号已停用"}}"""))
        try {
            api.login("zhang@example.com", "wrong", device)
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertEquals(401, error.status)
            assertEquals("invalid_credentials", error.code)
            assertEquals("账号或密码错误，或账号已停用", error.message)
        }
    }

    @Test
    fun `a password change required session is reported as such`() = runTest {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"password_change_required","message":"请先修改初始密码"}}"""))
        try {
            api.session()
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertEquals("password_change_required", error.code)
        }
    }

    @Test
    fun `non-JSON failures still produce a readable error`() = runTest {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        try {
            api.logout()
            fail("expected ApiException")
        } catch (error: ApiException) {
            assertEquals("http_502", error.code)
        }
    }

    @Test
    fun `origins omit the default port like browsers do`() {
        assertEquals("https://m.example.com", DshApi.originOf("https://m.example.com/".toHttpUrl()))
        assertEquals("https://m.example.com:4174", DshApi.originOf("https://m.example.com:4174/c/chats".toHttpUrl()))
    }
}
