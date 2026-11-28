package work.dsh.mobile.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Face
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import okhttp3.HttpUrl
import work.dsh.mobile.BuildConfig
import work.dsh.mobile.net.DshApi
import work.dsh.mobile.net.SessionUser
import work.dsh.mobile.web.FileSaver
import work.dsh.mobile.web.WorkbenchWebView

/** 底部导航。M0 的“对话”“群组”是 WebView 里的员工端协作模式页面，v0.1 起“对话”改为原生。 */
enum class HomeTab(val label: String, val path: String?, val icon: ImageVector) {
    Chats("对话", "/c/chats", Icons.Filled.List),
    Groups("群组", "/c/groups", Icons.Filled.Face),
    Me("我", null, Icons.Filled.Person),
}

@Composable
fun HomeScreen(
    user: SessionUser,
    server: HttpUrl,
    onLogout: () -> Unit,
    onAuthExpired: () -> Unit,
    onPasswordChangeRequired: () -> Unit,
) {
    val context = LocalContext.current
    val origin = remember(server) { DshApi.originOf(server) }
    var tab by rememberSaveable { mutableStateOf(HomeTab.Chats) }
    val canGoBack = remember { mutableStateMapOf<HomeTab, Boolean>() }
    var pendingFiles by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }

    val chooser = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        pendingFiles?.onReceiveValue(selectedUris(result.resultCode, result.data))
        pendingFiles = null
    }

    val backStates = canGoBack
    val authExpired = onAuthExpired
    val passwordChangeRequired = onPasswordChangeRequired
    val webViews = remember(server) { mutableMapOf<HomeTab, WorkbenchWebView>() }
    DisposableEffect(webViews) {
        onDispose { webViews.values.forEach { it.destroy() } }
    }

    fun webViewFor(target: HomeTab): WorkbenchWebView = webViews.getOrPut(target) {
        WorkbenchWebView(
            context,
            origin,
            object : WorkbenchWebView.Callbacks {
                override fun onAuthExpired() = authExpired()
                override fun onPasswordChangeRequired() = passwordChangeRequired()
                override fun onSaveFile(fileName: String, mimeType: String, base64: String) =
                    FileSaver.save(context, fileName, mimeType, base64)

                override fun onChooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
                    pendingFiles?.onReceiveValue(null)
                    pendingFiles = callback
                    val intent = params.createIntent().apply {
                        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }
                    }
                    return runCatching { chooser.launch(intent) }.onFailure {
                        pendingFiles = null
                        callback.onReceiveValue(null)
                    }.isSuccess
                }

                override fun onHistoryChanged(canGoBack: Boolean) {
                    backStates[target] = canGoBack
                }
            },
        ).also { it.loadUrl(server.resolve(target.path!!).toString()) }
    }

    BackHandler(enabled = canGoBack[tab] == true) { webViews[tab]?.goBack() }

    Scaffold(
        bottomBar = {
            NavigationBar {
                HomeTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = item == tab,
                        onClick = { tab = item },
                        icon = { Icon(item.icon, contentDescription = null) },
                        label = { Text(item.label) },
                    )
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding).fillMaxSize()
        if (tab.path == null) {
            ProfilePane(user, origin, onLogout, modifier)
        } else {
            key(tab) {
                val view = webViewFor(tab)
                AndroidView(
                    factory = { (view.parent as? ViewGroup)?.removeView(view); view },
                    modifier = modifier,
                )
            }
        }
    }
}

@Composable
private fun ProfilePane(user: SessionUser, origin: String, onLogout: () -> Unit, modifier: Modifier) {
    Column(modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(user.name, style = MaterialTheme.typography.headlineSmall)
        if (user.title.isNotBlank() || user.department.isNotBlank()) {
            Text(listOf(user.title, user.department).filter { it.isNotBlank() }.joinToString(" · "))
        }
        Text("服务器：$origin", style = MaterialTheme.typography.bodySmall)
        Text("版本：${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Text("退出登录") }
        Text("退出只影响这台手机，电脑上的登录不受影响。", style = MaterialTheme.typography.bodySmall)
    }
}

private fun selectedUris(resultCode: Int, data: Intent?): Array<Uri>? {
    if (resultCode != Activity.RESULT_OK || data == null) return null
    val clip = data.clipData
    if (clip != null && clip.itemCount > 0) return Array(clip.itemCount) { clip.getItemAt(it).uri }
    return data.data?.let { arrayOf(it) }
}
