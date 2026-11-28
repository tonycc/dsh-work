package work.dsh.mobile.session

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerAddressTest {
    @Test
    fun `addresses are normalised to the https root`() {
        assertEquals("https://m.example.com:4174/", ServerAddress.parse(" https://m.example.com:4174/c/chats?x=1 ").toString())
        assertEquals("https://m.example.com/", ServerAddress.parse("m.example.com").toString())
    }

    @Test
    fun `plain http and garbage are refused`() {
        assertNull(ServerAddress.parse("http://192.168.1.99:4174"))
        assertNull(ServerAddress.parse("not a url"))
        assertNull(ServerAddress.parse(""))
    }
}
