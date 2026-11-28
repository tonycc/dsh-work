package work.dsh.mobile.web

import org.junit.Assert.assertEquals
import org.junit.Test

class FileSaverTest {
    @Test
    fun `file names lose path separators and control characters`() {
        assertEquals("..__etc_passwd", FileSaver.safeName("../\\etc/passwd"))
        assertEquals("季度报告_v2.pdf", FileSaver.safeName("季度报告\u0007v2.pdf"))
        assertEquals("下载文件", FileSaver.safeName("   "))
    }
}
