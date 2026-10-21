package fr.samhain.pos

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URL
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SupabaseSyncHttpTest {
    private class Connection(val status: Int, val response: String, val retry: String? = null) : HttpsURLConnection(URL("https://test.invalid")) {
        val sent = ByteArrayOutputStream()
        var released = false
        override fun getResponseCode() = status
        override fun getOutputStream() = sent
        override fun getInputStream() = ByteArrayInputStream(response.toByteArray(Charsets.UTF_8))
        override fun getErrorStream() = inputStream
        override fun getHeaderField(name: String): String? = if(name == "Retry-After") retry else null
        override fun disconnect() { released = true }
        override fun usingProxy() = false
        override fun connect() {}
        override fun getCipherSuite() = "test"
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getLocalCertificates(): Array<Certificate>? = null
    }
    private fun send(connection: Connection, body: String = "{}"): org.json.JSONObject =
        SupabaseAuthHttp(SupabaseConfiguration("configured","test","https://test.invalid","sb_publishable_test")) { connection }
            .postProtectedRaw("/functions/v1/ledger-ingest-v1","test-token",body,"test-nonce","test-signature")

    @Test fun protectedTransportSendsExactlyTheSignedRawBytesAndReleasesConnection() {
        val connection = Connection(200,"{\"committed\":true}")
        val payload = "{ \"opaque\" : \"é/😀\" }"
        send(connection,payload)
        assertArrayEquals(payload.toByteArray(Charsets.UTF_8),connection.sent.toByteArray())
        assertEquals(30000,connection.connectTimeout); assertEquals(30000,connection.readTimeout)
        assertFalse(connection.instanceFollowRedirects)
        assertTrue(connection.released)
    }
    @Test fun structuredErrorsRetainOnlySafeCodesAndRetryAfter() {
        for(status in listOf(408,429,500,502,503,504)) {
            val connection = Connection(status,"{\"error\":{\"code\":\"SERVER_UNAVAILABLE\"}}","60")
            val error = assertThrows(SyncHttpFailure::class.java) { send(connection) }
            assertEquals(status,error.httpStatus)
            assertEquals(60000L,error.retryAfterMillis)
            assertTrue(connection.released)
        }
        val recovery = assertThrows(SyncHttpFailure::class.java) { send(Connection(409,"{\"error\":{\"code\":\"HEAD_MOVED\"}}")) }
        assertEquals("HEAD_MOVED",recovery.errorCode)
        val unsafe = assertThrows(SyncHttpFailure::class.java) { send(Connection(409,"{\"error\":{\"code\":\"secret-test-must-not-be-retained\"}}")) }
        assertEquals("HTTP_ERROR",unsafe.errorCode)
    }
    @Test fun non200SuccessMalformedTruncatedAndOversizeBodiesCannotBecomeAnAck() {
        for(connection in listOf(Connection(207,"{}"),Connection(200,"{\"committed\":"),Connection(200,"x".repeat(1048577)))) {
            val error = assertThrows(SyncHttpFailure::class.java) { send(connection) }
            assertEquals("INVALID_ACK",error.errorCode)
            assertTrue(connection.released)
        }
    }
    @Test fun authStatusesUseTheCommonNativeRefreshAndPausePath() {
        assertEquals("session_expired",assertThrows(TabletAuthFailure::class.java) { send(Connection(401,"{}")) }.code)
        assertEquals("authorization_denied",assertThrows(TabletAuthFailure::class.java) { send(Connection(403,"{}")) }.code)
    }
}
