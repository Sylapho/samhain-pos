package fr.samhain.pos

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Opt-in live campaign; run via pnpm test:supabase:room. Never contacts a hosted project. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class LiveSupabaseIntegrationTest {
    private fun bridge(command: JSONObject): JSONObject {
        val uri = URI(System.getenv("SAMHAIN_INTEGRATION_BRIDGE")!!)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0)
        val connection = uri.toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 10000; connection.readTimeout = 60000
            connection.instanceFollowRedirects = false; connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer " + System.getenv("SAMHAIN_INTEGRATION_NONCE"))
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(command.toString().toByteArray(Charsets.UTF_8)) }
            assertEquals("Local integration bridge assertion failed", 200, connection.responseCode)
            return JSONObject(connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
        } finally { connection.disconnect() }
    }

    @Test fun roomOfflineToRealSupabaseSurvivesLostAckRestartAndRevocation() {
        assumeTrue("Run the isolated Supabase campaign to supply the test bridge", System.getenv("SAMHAIN_INTEGRATION_BRIDGE") != null)
        val executor = Executors.newSingleThreadExecutor()
        try { executor.submit {
            repeat(2) { terminalIndex -> campaign(terminalIndex) }
        }.get() } finally { executor.shutdownNow() }
    }

    private fun campaign(index: Int) {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "live-sync-${UUID.randomUUID()}.db"
        fun open() = Room.databaseBuilder(context, SamhainPosDatabase::class.java, name).build()
        var db = open()
        var store = RoomOrderStore(db)
        val terminal = "live-terminal-$index-${UUID.randomUUID()}"
        val source = JSONObject().put("softwareVersion", "integration-fixture").put("buildMode", "test")
            .put("terminal", JSONObject().put("terminalId", terminal).put("terminalCode", "A").put("displayName", "Fixture é/😀"))
            .put("organization", JSONObject().put("organizationName", "Synthetic integration fixture")
                .put("eventName", "Fixture").put("city", "").put("address", "").put("siret", "")
                .put("vatNumber", "").put("usesDemoPlaceholders", true))
        val start = "2026-10-18T09:00:00.000Z"
        val finish = "2026-10-21T18:00:00.000Z"
        fun order(id: String, date: String) = JSONObject().put("id", id).put("orderNumberPrefix", "A")
            .put("receiptNumberPrefix", "R-A-20261018").put("terminal", source.getJSONObject("terminal"))
            .put("paymentMethod", "cash").put("paymentStatus", "paid").put("paidAt", date)
            .put("createdAt", date).put("status", "confirmed").put("itemCount", 1).put("totalCents", 500)
            .put("items", JSONArray().put(JSONObject().put("lineId", "fixture-line").put("productId", "synthetic")
                .put("name", "Synthetic fixture").put("quantity", 1).put("unitPriceCents", 500).put("vatRate", 10)
                .put("options", JSONArray()).put("ingredients", JSONArray()).put("removedIngredientIds", JSONArray())
                .put("dataConfidence", "temporary")))
            .put("printing", JSONObject().put("status", "unknown").put("customerReceipt", "printed")
                .put("preparationTicket", "unknown").put("attempts", 1).put("updatedAt", date))
        var clock = 1000000L
        try {
            store.openCashSession(JSONObject().put("sessionId", "session").put("openingFloatCents", 0)
                .put("periodStart", start).put("createdAt", start).put("recordedAt", start).put("source", source))
            store.updateCashFloat(JSONObject().put("operationId", "float").put("sessionId", "session")
                .put("previousOpeningFloatCents", 0).put("newOpeningFloatCents", 100)
                .put("updatedAt", start).put("recordedAt", start).put("source", source))
            repeat(3) { day ->
                store.createOrder(order("live-$index-$day", "2026-10-${18 + day}T12:00:00.000Z"), source)
                clock += 86400000
                SyncEngine(db, { JSONObject().put("status", "not_configured") }, { _, _ -> error("Offline startup must not send") }, { clock }).drain()
            }
            store.recordCorrection(JSONObject().put("operationId", "cancel").put("originalOrderId", "live-$index-0")
                .put("type", "cancellation").put("reason", "Synthetic fixture").put("amountDeltaCents", -500)
                .put("recordedAt", "2026-10-21T12:00:00.000Z").put("source", source))
            store.closePeriod(JSONObject().put("operationId", "close").put("periodStart", start).put("periodEnd", finish)
                .put("recordedAt", finish).put("cashSessionId", "session").put("openingFloatCents", 100).put("source", source))
            val original = store.snapshot().toString()
            val chain = store.syncIdentity().chainId
            assertEquals(7, db.outboxDao().all(chain).size)
            val scope = bridge(JSONObject().put("action", "enroll").put("dossier", store.enrollmentDossier(terminal)))
            store.bindSyncChain(scope.getString("chainId"))
            var lose = true
            fun engine() = SyncEngine(db, { scope }, { endpoint, request ->
                val response = bridge(JSONObject().put("action", "send").put("chainId", chain)
                    .put("endpoint", endpoint.route).put("raw", request.toString()).put("loseAck", lose))
                lose = false
                if (response.getInt("status") in setOf(401,403)) throw TabletAuthFailure("authorization_denied")
                if (response.getInt("status") != 200) throw SyncHttpFailure(response.getInt("status"),
                    response.getJSONObject("data").optJSONObject("error")?.optString("code") ?: "HTTP_ERROR")
                response.getJSONObject("data")
            }, { clock }, { it })
            engine().drain() // Server has committed; deliberately withhold the response from SyncEngine.
            assertTrue(db.outboxDao().all(chain).all { it.status == "pending" && it.receiptId == null })
            assertEquals(original, store.snapshot().toString())
            db.close(); db = open(); store = RoomOrderStore(db)
            clock += 21600001
            engine().drain() // Same events/fingerprints, new proof, real already_present ACKs.
            val rows = db.outboxDao().all(chain)
            assertTrue(rows.all { it.status == "synced" && it.receiptId != null })
            assertEquals(original, store.snapshot().toString()) // Includes payment, numbers and unknown printing.
            val tuples = JSONArray()
            rows.forEach { row -> tuples.put(JSONObject().put("eventId", row.eventId).put("sequence", row.sequence)
                .put("hash", row.hash).put("previousHash", row.previousHash ?: JSONObject.NULL)
                .put("payloadCanonical", row.payloadCanonical).put("transportFingerprint", row.transportFingerprint)
                .put("receiptId", row.receiptId).put("serverReceivedAt", row.serverReceivedAt)) }
            assertTrue(bridge(JSONObject().put("action", "verify").put("chainId", chain).put("events", tuples)
                .put("localSnapshotHashBefore", SyncProtocol.sha(original))
                .put("localSnapshotHashAfter", SyncProtocol.sha(store.snapshot().toString()))).getBoolean("verified"))
            bridge(JSONObject().put("action", "revoke").put("chainId", chain))
            store.createOrder(order("live-$index-revoked", "2026-10-22T12:00:00.000Z"), source)
            engine().drain()
            assertEquals("paused_auth", db.outboxDao().find("sale:live-$index-revoked")!!.status)
            store.createOrder(order("live-$index-still-offline", "2026-10-22T13:00:00.000Z"), source)
            assertEquals(5, store.snapshot().getJSONArray("orders").length())
        } finally { db.close(); context.deleteDatabase(name) }
    }
}
