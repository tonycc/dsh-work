package work.dsh.mobile.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** 与员工端协作模式同一组颜色（CollabShell 的选中色）。 */
private val colors = lightColorScheme(
    primary = Color(0xFF1F5A49),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEAF4F0),
    onPrimaryContainer = Color(0xFF124D3F),
    surface = Color.White,
    background = Color.White,
)

@Composable
fun DshTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, content = content)
}
