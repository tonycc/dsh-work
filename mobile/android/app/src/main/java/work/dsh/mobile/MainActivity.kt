package work.dsh.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import work.dsh.mobile.session.AppState
import work.dsh.mobile.session.SessionViewModel
import work.dsh.mobile.ui.ChangePasswordScreen
import work.dsh.mobile.ui.DshTheme
import work.dsh.mobile.ui.HomeScreen
import work.dsh.mobile.ui.LoginScreen

class MainActivity : ComponentActivity() {
    private val session: SessionViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            DshTheme {
                Surface(Modifier.fillMaxSize()) { App(session) }
            }
        }
    }
}

@Composable
private fun App(session: SessionViewModel) {
    val state by session.state.collectAsStateWithLifecycle()
    val busy by session.busy.collectAsStateWithLifecycle()
    val error by session.error.collectAsStateWithLifecycle()
    when (val current = state) {
        AppState.Checking -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        is AppState.LoggedOut -> LoginScreen(
            defaultServer = session.server.toString(),
            notice = current.notice,
            error = error,
            busy = busy,
            onLogin = session::login,
        )
        AppState.MustChangePassword -> ChangePasswordScreen(
            error = error,
            busy = busy,
            onSubmit = session::changePassword,
            onCancel = session::logout,
        )
        is AppState.LoggedIn -> HomeScreen(
            user = current.user,
            server = session.server,
            onLogout = session::logout,
            onAuthExpired = session::onAuthExpired,
            onPasswordChangeRequired = session::onPasswordChangeRequired,
        )
    }
}
