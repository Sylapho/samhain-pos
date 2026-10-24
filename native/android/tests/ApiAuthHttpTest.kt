package __APP_PACKAGE__

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.Principal
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ApiAuthHttpTest {
    private val config = ApiAuthConfiguration("configured", "https://api.example.invalid", "11111111-1111-4111-8111-111111111111")
    private class Connection : HttpsURLConnection(URL("https://api.example.invalid")) {
        val sent = ByteArrayOutputStream()
        var status = 200; var bytes = "{}".toByteArray(); var destination = "11111111-1111-4111-8111-111111111111"; var closed = false
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(bytes)
        override fun getErrorStream() = ByteArrayInputStream(bytes)
        override fun getOutputStream() = sent
        override fun getHeaderField(name: String?) = if(name == "X-Samhain-Destination") destination else null
        override fun disconnect() { closed = true }
        override fun usingProxy() = false
        override fun connect() {}
        override fun getCipherSuite() = "test-only"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getPeerPrincipal(): Principal? = null
        override fun getLocalPrincipal(): Principal? = null
    }
    @Test fun sendsExactUtf8BytesAndProofOnlyToConfiguredHttpsOrigin() {
        val conn = Connection(); val http = ApiAuthHttp(config) { conn }
        val raw = "{\"opaque\":\"é/😀\"} "
        http.signed("/api/v1/tablets/status", "api-token", raw, "nonce", "signature")
        assertArrayEquals(raw.toByteArray(Charsets.UTF_8), conn.sent.toByteArray())
        assertEquals("Bearer api-token", conn.getRequestProperty("Authorization"))
        assertNull(conn.getRequestProperty("apikey"))
        assertEquals("nonce", conn.getRequestProperty("X-Samhain-Nonce"))
        assertFalse(conn.instanceFollowRedirects); assertTrue(conn.closed)
        assertEquals(15000, conn.readTimeout); assertEquals(15000, conn.connectTimeout)
        assertThrows(IllegalArgumentException::class.java) { http.get("https://other.invalid/api/v1/auth/config") }
    }
    @Test fun redirectsWrongDestinationsOversizedAndInvalidUtf8ResponsesFailClosed() {
        for(kind in listOf("redirect", "destination", "oversized", "utf8")) {
            val conn = Connection()
            when(kind) {
                "redirect" -> conn.status = 302
                "destination" -> conn.destination = "different"
                "oversized" -> conn.bytes = ByteArray(1048577) { 32 }
                "utf8" -> conn.bytes = byteArrayOf(0xC3.toByte(), 0x28)
            }
            assertThrows(TabletAuthFailure::class.java) { ApiAuthHttp(config) { conn }.get("/api/v1/auth/config") }
            assertTrue(conn.closed)
        }
    }
    @Test fun onlyPublicOperationalErrorsLeaveTransport() {
        val conn = Connection(); conn.status = 403
        conn.bytes = "{\"error\":{\"code\":\"ACCESS_REVOKED\",\"message\":\"private-test-only\"}}".toByteArray()
        val error = assertThrows(TabletAuthFailure::class.java) { ApiAuthHttp(config) { conn }.get("/api/v1/auth/config") }
        assertEquals("revoked", error.code)
        assertFalse(error.toString().contains("private-test-only"))
    }
}
