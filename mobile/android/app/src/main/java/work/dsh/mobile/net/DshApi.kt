package work.dsh.mobile.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 服务端返回的错误（`{ error: { code, message } }`）或网络错误。 */
class ApiException(val status: Int, val code: String, message: String) : IOException(message)

@Serializable
data class MobileLoginResult(val mustChangePassword: Boolean, val expiresInSeconds: Long)

@Serializable
data class SessionUser(
    val id: String,
    val name: String,
    val department: String = "",
    val title: String = "",
)

data class DeviceInfo(val id: String, val name: String)

/**
 * M0 用到的几个认证接口。接口以服务端路由与集成测试为准（server/src/http/local-auth-routes.ts）。
 */
class DshApi(
    private val baseUrl: HttpUrl,
    cookieJar: SharedCookieJar,
    client: OkHttpClient = OkHttpClient(),
) {
    private val http = client.newBuilder()
        .cookieJar(cookieJar)
        .addInterceptor(OriginInterceptor(originOf(baseUrl)))
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun login(username: String, password: String, device: DeviceInfo): MobileLoginResult {
        val body = jsonBody(
            mapOf(
                "username" to username,
                "password" to password,
                "deviceId" to device.id,
                "deviceName" to device.name,
            ),
        )
        return call(post("/auth/workbench/mobile/login", body)) { json.decodeFromString<MobileLoginResult>(it) }
    }

    /** 当前登录用户；401 表示会话失效，403 `password_change_required` 表示需要先改密。 */
    suspend fun session(): SessionUser = call(Request.Builder().url(url("/api/workbench/v1/session")).get().build()) {
        val data = json.parseToJsonElement(it).jsonObject.getValue("data").jsonObject
        json.decodeFromJsonElement(SessionUser.serializer(), data.getValue("user"))
    }

    /** 修改密码；成功后服务端为本机换发新的 App 会话。 */
    suspend fun changePassword(currentPassword: String, newPassword: String) {
        call(post("/auth/workbench/password", jsonBody(mapOf("currentPassword" to currentPassword, "newPassword" to newPassword)))) {}
    }

    /** App 内退出只撤销本机会话。 */
    suspend fun logout() {
        call(post("/auth/workbench/logout", jsonBody(emptyMap()))) {}
    }

    private fun url(path: String): HttpUrl = baseUrl.resolve(path) ?: error("无效地址：$path")

    private fun post(path: String, body: RequestBody) = Request.Builder().url(url(path)).post(body).build()

    private suspend fun <T> call(request: Request, parse: (String) -> T): T = withContext(Dispatchers.IO) {
        http.newCall(request.newBuilder().header("Accept", "application/json").build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw toApiException(response, text)
            parse(text)
        }
    }

    private fun toApiException(response: Response, text: String): ApiException {
        val error = runCatching { json.parseToJsonElement(text).jsonObject["error"] as? JsonObject }.getOrNull()
        val code = error?.get("code")?.jsonPrimitive?.content ?: "http_${response.code}"
        val message = error?.get("message")?.jsonPrimitive?.content ?: "请求失败（${response.code}）"
        return ApiException(response.code, code, message)
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        private val jsonType = "application/json; charset=utf-8".toMediaType()

        private fun jsonBody(values: Map<String, String>): RequestBody =
            json.encodeToString(values).toRequestBody(jsonType)

        /** `scheme://host[:port]`，与浏览器发出的 Origin 相同（默认端口省略）。 */
        fun originOf(url: HttpUrl): String {
            val defaultPort = HttpUrl.defaultPort(url.scheme)
            return if (url.port == defaultPort) "${url.scheme}://${url.host}" else "${url.scheme}://${url.host}:${url.port}"
        }
    }
}
