package work.dsh.mobile.session

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceIdentityTest {
    @Test
    fun `the device id is generated once, matches the server rule and survives restarts`() {
        val preferences = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test-device", Context.MODE_PRIVATE)
        val first = DeviceIdentity.load(preferences)
        val second = DeviceIdentity.load(preferences)
        assertTrue(DeviceIdentity.pattern.matches(first.id))
        assertEquals(first.id, second.id)
    }

    @Test
    fun `device names avoid repeating the manufacturer and stay within 80 characters`() {
        assertEquals("Xiaomi 23127PN0CC", DeviceIdentity.deviceName("Xiaomi", "23127PN0CC"))
        assertEquals("Google Pixel 8", DeviceIdentity.deviceName("Google", "Pixel 8"))
        assertEquals("HUAWEI Mate 60", DeviceIdentity.deviceName("HUAWEI", "HUAWEI Mate 60"))
        assertEquals(80, DeviceIdentity.deviceName("X", "y".repeat(200)).length)
    }
}
