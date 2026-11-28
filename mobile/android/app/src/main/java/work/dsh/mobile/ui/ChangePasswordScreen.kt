package work.dsh.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/** 首次登录或管理员重置后修改初始密码。规则与网页相同（8–64 位），以服务端校验为准。 */
@Composable
fun ChangePasswordScreen(
    error: String?,
    busy: Boolean,
    onSubmit: (current: String, new: String) -> Unit,
    onCancel: () -> Unit,
) {
    var current by rememberSaveable { mutableStateOf("") }
    var next by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf("") }
    val mismatch = confirm.isNotEmpty() && confirm != next
    val tooShort = next.isNotEmpty() && next.length < 8

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 48.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("修改初始密码", style = MaterialTheme.typography.headlineSmall)
        Text("首次登录需要先设置自己的密码。修改后，其他设备上的登录会失效。", style = MaterialTheme.typography.bodyMedium)
        PasswordField("当前密码", current) { current = it }
        PasswordField("新密码（8–64 位）", next) { next = it }
        PasswordField("确认新密码", confirm) { confirm = it }
        val hint = when {
            tooShort -> "新密码至少 8 位"
            mismatch -> "两次输入的新密码不一致"
            else -> error
        }
        if (hint != null) Text(hint, color = MaterialTheme.colorScheme.error)
        Button(
            onClick = { onSubmit(current, next) },
            enabled = !busy && current.isNotEmpty() && next.length >= 8 && next == confirm,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (busy) "正在保存…" else "保存并进入") }
        TextButton(onClick = onCancel) { Text("退出登录") }
    }
}

@Composable
private fun PasswordField(label: String, value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        modifier = Modifier.fillMaxWidth(),
    )
}
