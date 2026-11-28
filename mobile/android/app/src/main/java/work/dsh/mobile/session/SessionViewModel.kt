package work.dsh.mobile.session

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import work.dsh.mobile.BuildConfig
import work.dsh.mobile.net.ApiException
import work.dsh.mobile.net.CookieStore
import work.dsh.mobile.net.DshApi
import work.dsh.mobile.net.SessionUser
import work.dsh.mobile.net.SharedCookieJar
import work.dsh.mobile.net.WebViewCookieStore
import java.io.IOException

sealed interface AppState {
    data object Checking : AppState
    data class LoggedOut(val notice: String? = null) : AppState
    data object MustChangePassword : AppState
    data class LoggedIn(val user: SessionUser) : AppState
}

/**
 * App 的登录状态。原生是唯一的登录入口：WebView 遇到会话失效或需要改密时经桥回到这里。
 */
class SessionViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("dsh-work", Context.MODE_PRIVATE)
    private val cookies: CookieStore = WebViewCookieStore()
    private val device = DeviceIdentity.load(preferences)

    private val _state = MutableStateFlow<AppState>(AppState.Checking)
    val state: StateFlow<AppState> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    var server: HttpUrl = ServerAddress.parse(preferences.getString("server", null) ?: BuildConfig.DEFAULT_BASE_URL)
        ?: ServerAddress.parse("https://m.example.com:4174")!!
        private set

    private var api = DshApi(server, SharedCookieJar(cookies))

    init {
        refresh()
    }

    /** 启动或回到前台时核对会话。 */
    fun refresh() {
        viewModelScope.launch {
            _state.value = try {
                AppState.LoggedIn(api.session())
            } catch (error: ApiException) {
                when (error.code) {
                    "password_change_required" -> AppState.MustChangePassword
                    else -> if (error.status == 401) AppState.LoggedOut() else AppState.LoggedOut(error.message)
                }
            } catch (error: IOException) {
                AppState.LoggedOut("无法连接服务器：${error.message ?: "网络错误"}")
            }
        }
    }

    fun login(serverInput: String, username: String, password: String) = perform {
        val address = ServerAddress.parse(serverInput) ?: throw ApiException(0, "invalid_server", "服务器地址必须是 https:// 开头的地址")
        if (address != server) {
            server = address
            preferences.edit().putString("server", address.toString()).apply()
            cookies.clear()
            api = DshApi(server, SharedCookieJar(cookies))
        }
        val result = api.login(username.trim(), password, device)
        _state.value = if (result.mustChangePassword) AppState.MustChangePassword else AppState.LoggedIn(api.session())
    }

    fun changePassword(currentPassword: String, newPassword: String) = perform {
        api.changePassword(currentPassword, newPassword)
        _state.value = AppState.LoggedIn(api.session())
    }

    fun logout() = perform {
        runCatching { api.logout() }
        cookies.clear()
        _state.value = AppState.LoggedOut()
    }

    /** WebView 报告会话失效（401）。 */
    fun onAuthExpired() {
        cookies.clear()
        _state.value = AppState.LoggedOut("登录已失效，请重新登录")
    }

    /** WebView 报告需要先修改初始密码。 */
    fun onPasswordChangeRequired() {
        _state.value = AppState.MustChangePassword
    }

    fun clearError() {
        _error.value = null
    }

    private fun perform(block: suspend () -> Unit) {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            _error.value = null
            try {
                block()
            } catch (error: ApiException) {
                _error.value = error.message
            } catch (error: IOException) {
                _error.value = "无法连接服务器：${error.message ?: "网络错误"}"
            } finally {
                _busy.value = false
            }
        }
    }
}
