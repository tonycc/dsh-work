package work.dsh.mobile.session

import android.content.SharedPreferences
import android.os.Build
import work.dsh.mobile.net.DeviceInfo
import java.util.UUID

/**
 * 本机的设备标识：首次启动随机生成并保存在本应用的私有存储里（不读取硬件标识，不需要额外权限）。
 * 服务端用它在同一台手机重新登录时替换旧会话；卸载重装后视为新设备。
 */
object DeviceIdentity {
    private const val KEY = "device_id"

    /** 与服务端校验一致：8–128 位字母、数字或 `._:-`。 */
    val pattern = Regex("^[A-Za-z0-9._:-]{8,128}$")

    fun load(preferences: SharedPreferences): DeviceInfo {
        val stored = preferences.getString(KEY, null)?.takeIf { pattern.matches(it) }
        val id = stored ?: "android-${UUID.randomUUID()}".also { preferences.edit().putString(KEY, it).apply() }
        return DeviceInfo(id, deviceName())
    }

    fun deviceName(manufacturer: String = Build.MANUFACTURER.orEmpty(), model: String = Build.MODEL.orEmpty()): String {
        val name = if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model"
        return name.trim().take(80)
    }
}
