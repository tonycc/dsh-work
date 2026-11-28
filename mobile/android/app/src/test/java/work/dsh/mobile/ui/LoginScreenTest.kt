package work.dsh.mobile.ui

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class LoginScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun `login is enabled once account and password are filled and passes them on`() {
        var submitted: Triple<String, String, String>? = null
        compose.setContent {
            DshTheme {
                LoginScreen("https://m.example.com:4174/", notice = null, error = null, busy = false) { s, u, p -> submitted = Triple(s, u, p) }
            }
        }
        compose.onNodeWithText("登录").assertIsNotEnabled()
        compose.onNodeWithText("账号").performTextInput("zhang@example.com")
        compose.onNodeWithText("密码").performTextInput("Secret123")
        compose.onNodeWithText("登录").assertIsEnabled().performClick()
        assertEquals(Triple("https://m.example.com:4174/", "zhang@example.com", "Secret123"), submitted)
    }

    @Test
    fun `server errors and expiry notices are shown`() {
        compose.setContent {
            DshTheme {
                LoginScreen("https://m.example.com/", notice = "登录已失效，请重新登录", error = "账号或密码错误，或账号已停用", busy = false) { _, _, _ -> }
            }
        }
        compose.onNodeWithText("登录已失效，请重新登录").assertExists()
        compose.onNodeWithText("账号或密码错误，或账号已停用").assertExists()
    }
}
