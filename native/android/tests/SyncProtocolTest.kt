package __APP_PACKAGE__

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncProtocolTest {
    @Test fun transportPreservesUnicodeAndDoesNotUseAndroidSlashEscaping() {
        val text = "é/😀\n\t\"\\\u0001\u2028"
        val json = JSONObject().put("z",1).put("a",text)
        val expected = "{\"a\":\"é/😀\\n\\t\\\"\\\\\\u0001\u2028\",\"z\":1}"
        assertEquals(expected,SyncProtocol.canonical(json))
        assertNotEquals(CanonicalJson.stringify(json),SyncProtocol.canonical(json))
        val unsigned = JSONObject().put("id","opaque/a").put("sequence",1)
        val ts = JSONObject(unsigned.toString()).put("hash",SyncProtocol.sha(SyncProtocol.canonical(unsigned)))
        val android = JSONObject(unsigned.toString()).put("hash",CanonicalJson.sha256(unsigned))
        assertEquals("ts-ledger-v1",SyncProtocol.ledgerProfile(ts))
        assertEquals("android-ledger-v1",SyncProtocol.ledgerProfile(android))
        assertEquals("opaque/a",ts.getString("id"))
    }
    @Test fun fingerprintMatchesThePublishedSamhainSyncVector() {
        val path = "docs/architecture-supabase-offline-first.md"
        val doc = listOf(java.io.File("../$path"),java.io.File(path),java.io.File("../../$path")).first { it.exists() }.readText()
        val example = doc.substringAfter("<!-- sync-request-example -->").substringAfter("```json").substringBefore("```")
        val request = JSONObject(example)
        val event = request.getJSONArray("events").getJSONObject(0)
        val row = OutboxEntry(event.getString("eventId"),request.getString("chainId"),"ledger","cash_session_opened","session",
            event.getString("sourceTerminalId"),event.getLong("sequence"),event.getString("hash"),null,
            event.getString("payloadCanonical"),event.getString("ledgerCanonicalization"))
        assertEquals(event.getString("transportFingerprint"),SyncProtocol.fingerprint(row,request))
        val ackExample = doc.substringAfter("<!-- sync-ack-example -->").substringAfter("```json").substringBefore("```")
        assertEquals(1,SyncProtocol.validateAck(request,JSONObject(ackExample)).size)
    }
}
