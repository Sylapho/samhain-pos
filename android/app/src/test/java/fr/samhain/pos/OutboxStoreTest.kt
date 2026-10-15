package fr.samhain.pos

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OutboxStoreTest {
    private lateinit var db: SamhainPosDatabase
    private lateinit var orders: RoomOrderStore
    private lateinit var outbox: OutboxStore
    private val executor = Executors.newFixedThreadPool(2)
    private var clock = 1000000L
    @Before fun setup() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(),SamhainPosDatabase::class.java).build()
        orders = RoomOrderStore(db); outbox = OutboxStore(db)
    }
    @After fun cleanup() { db.close(); executor.shutdownNow() }
    private fun <T> run(block: () -> T): T = executor.submit<T> { block() }.get()
    private fun scope(): JSONObject = JSONObject().put("status","authorized")
        .put("organizationId","33333333-3333-4333-8333-333333333333")
        .put("festivalId","44444444-4444-4444-8444-444444444444")
        .put("chainId",orders.syncIdentity().chainId)
        .put("installationId","77777777-7777-4777-8777-777777777777").put("enrollmentGeneration",1)
    private fun response(request: JSONObject): JSONObject = JSONObject().apply {
        listOf("protocolVersion","requestId","organizationId","festivalId","chainId").forEach { put(it,request.get(it)) }
        put("committed",true)
        val events = request.getJSONArray("events")
        val last = events.getJSONObject(events.length()-1)
        put("serverHead",JSONObject().put("sequence",if(last.isNull("sequence")) 0 else last.getLong("sequence"))
            .put("hash",last.get("hash")))
        put("acknowledgements",JSONArray().also { acks ->
            for(i in 0 until events.length()) {
                val event = events.getJSONObject(i)
                acks.put(JSONObject().apply {
                    listOf("eventId","sequence","hash","transportFingerprint").forEach { put(it,event.get(it)) }
                    put("status","accepted"); put("receiptId",UUID.randomUUID().toString())
                    put("serverReceivedAt","2026-10-15T09:00:00.000Z")
                })
            }
        })
    }
    private fun engine(send: (ProtectedSyncEndpoint,JSONObject) -> JSONObject, auth: () -> JSONObject = ::scope) =
        SyncEngine(db,auth,send,{ clock },{ it })

    @Test fun captureAndOutboxFailureRollbackAllFinancialState() = run {
        orders.createOrder(request("first"),source())
        val before = orders.snapshot().toString()
        val dao = db.outboxDao()
        val row = dao.find("sale:first")!!
        dao.insert(row.copy(eventId = "sale:blocked",sequence = 2,hash = "b".repeat(64)))
        assertThrows(Exception::class.java) { orders.createOrder(request("blocked"),source()) }
        assertEquals(before,orders.snapshot().toString())
        assertEquals(2,dao.all(row.chainId).size)
    }
    @Test fun doubleFinalizeCapturesExactlyOnceAndPrintingIsUnchanged() = run {
        orders.createCheckoutIntent(checkoutIntent("intent"))
        orders.markCheckoutPaymentToVerify("intent","2026-09-01T12:01:00.000Z")
        orders.confirmCheckoutPayment("intent","2026-09-01T12:02:00.000Z")
        val first = orders.finalizeCheckoutIntent("intent","2026-09-01T12:03:00.000Z")
        assertEquals(first.toString(),orders.finalizeCheckoutIntent("intent","2026-09-01T12:04:00.000Z").toString())
        val before = orders.snapshot().toString()
        engine({ _, body -> response(body) }).drain()
        assertEquals(before,orders.snapshot().toString())
        assertEquals("synced",db.outboxDao().find("sale:intent")!!.status)
    }
    @Test fun allFiveKindsCapturedWithoutAnyConfiguration() = run {
        orders.openCashSession(JSONObject().put("sessionId","session").put("openingFloatCents",0).put("periodStart","2026-09-01T09:00:00.000Z")
            .put("createdAt","2026-09-01T09:00:00.000Z").put("recordedAt","2026-09-01T09:00:00.000Z").put("source",source()))
        orders.updateCashFloat(JSONObject().put("operationId","float").put("sessionId","session")
            .put("previousOpeningFloatCents",0).put("newOpeningFloatCents",100)
            .put("updatedAt","2026-09-01T10:00:00.000Z").put("recordedAt","2026-09-01T10:00:00.000Z").put("source",source()))
        orders.createOrder(request("sale"),source())
        orders.recordCorrection(JSONObject().put("operationId","cancel").put("originalOrderId","sale")
            .put("type","cancellation").put("reason","test").put("amountDeltaCents",-500)
            .put("recordedAt","2026-09-01T13:00:00.000Z").put("source",source()))
        orders.closePeriod(JSONObject().put("operationId","close").put("periodStart","2026-09-01T09:00:00.000Z")
            .put("periodEnd","2026-09-01T18:00:00.000Z").put("recordedAt","2026-09-01T18:01:00.000Z")
            .put("cashSessionId","session").put("openingFloatCents",100).put("source",source()))
        repeat(5) { clock += 86400000; engine({ _, _ -> error("must not contact server") },{ JSONObject().put("status","not_configured") }).drain() }
        val rows = db.outboxDao().all(orders.syncIdentity().chainId)
        assertEquals(setOf("sale","correction","closure","cash_session_opened","cash_float_updated"),rows.map { it.kind }.toSet())
        assertTrue(rows.all { it.status == "pending" && it.transportFingerprint == null })
    }
    @Test fun durableClaimSerializesAndRecoversExpiredCrash() = run {
        orders.createOrder(request("sale"),source())
        val a = outbox.claim(scope(),"worker-a",clock)
        assertEquals(1,a.size)
        assertTrue(outbox.claim(scope(),"worker-b",clock).isEmpty())
        clock += 120001
        val b = OutboxStore(db).claim(scope(),"worker-b",clock)
        assertEquals(1,b.size)
        val body = SyncProtocol.envelope(scope(),UUID.randomUUID().toString()).put("events",JSONArray().put(SyncProtocol.event(a[0])))
        assertThrows(Exception::class.java) { outbox.acknowledge(a,"worker-a",body,response(body),clock) }
        assertEquals("worker-b",db.outboxDao().find("sale:sale")!!.claimOwner)
    }
    @Test fun responseLostRetriesSameEventAndFingerprintWithNewRequestId() = run {
        orders.createOrder(request("sale"),source())
        var first: JSONObject? = null
        engine({ _, body -> first = JSONObject(body.toString()); throw TabletAuthFailure("server_unreachable") }).drain()
        assertEquals("pending",db.outboxDao().find("sale:sale")!!.status)
        clock += 5001
        engine({ _, body ->
            assertNotEquals(first!!.getString("requestId"),body.getString("requestId"))
            assertEquals(first!!.getJSONArray("events").toString(),body.getJSONArray("events").toString())
            response(body).apply { getJSONArray("acknowledgements").getJSONObject(0).put("status","already_present") }
        }).drain()
        assertEquals("synced",db.outboxDao().find("sale:sale")!!.status)
    }
    @Test fun invalidPartialForeignDuplicateAndWrongHashAcksNeverCommit() = run {
        orders.createOrder(request("one"),source()); orders.createOrder(request("two"),source())
        val invalid: List<(JSONObject) -> Unit> = listOf(
            { it.put("requestId",UUID.randomUUID().toString()) },
            { it.put("organizationId",UUID.randomUUID().toString()) },
            { it.put("protocolVersion",1.5) },
            { it.put("committed",false) },
            { it.getJSONArray("acknowledgements").remove(1) },
            { it.getJSONArray("acknowledgements").getJSONObject(0).put("eventId","foreign") },
            { it.getJSONArray("acknowledgements").put(1,it.getJSONArray("acknowledgements").get(0)) },
            { it.getJSONArray("acknowledgements").getJSONObject(0).put("hash","a".repeat(64)) },
            { it.getJSONArray("acknowledgements").getJSONObject(0).put("receiptId","bad") },
            { it.getJSONObject("serverHead").put("sequence",0) },
        )
        invalid.forEach { mutate ->
            engine({ _, body -> response(body).also(mutate) }).drain()
            assertTrue(db.outboxDao().all(orders.syncIdentity().chainId).all { it.status == "pending" && it.receiptId == null })
            clock += 21600001
        }
    }
    @Test fun temporaryHttpErrorsPersistBackoffAndAuthPauseDoesNotBlockSales() = run {
        orders.createOrder(request("one"),source())
        for(code in listOf(429,500,503)) {
            engine({ _, _ -> throw SyncHttpFailure(code,"SERVER_UNAVAILABLE",60000) }).drain()
            val row = db.outboxDao().find("sale:one")!!
            assertEquals("pending",row.status); assertTrue(row.nextAttemptAt >= clock + 60000)
            clock = row.nextAttemptAt + 1
        }
        engine({ _, _ -> throw TabletAuthFailure("authorization_denied") }).drain()
        assertEquals("paused_auth",db.outboxDao().find("sale:one")!!.status)
        orders.createOrder(request("two"),source())
        assertEquals(2,orders.snapshot().getJSONArray("orders").length())
    }
    @Test fun permanentConflictStopsSuccessorsButAllowsLocalSales() = run {
        orders.createOrder(request("one"),source())
        engine({ _, _ -> throw SyncHttpFailure(409,"SEQUENCE_FORK") }).drain()
        orders.createOrder(request("two"),source())
        engine({ _, _ -> error("quarantined chain must not send") }).drain()
        assertEquals("quarantined",db.outboxDao().find("sale:one")!!.status)
        assertEquals("pending",db.outboxDao().find("sale:two")!!.status)
    }
    @Test fun backfillIsBoundedResumableAndCoexistsWithNewSales() = run {
        repeat(205) { orders.createOrder(request("historical-$it"),source()) }
        db.openHelper.writableDatabase.execSQL("DELETE FROM outbox") // Simulate pre-v7, never a production operation.
        val before = orders.snapshot().toString()
        assertFalse(outbox.backfillBatch())
        assertEquals(100,db.outboxDao().all(orders.syncIdentity().chainId).size)
        orders.createOrder(request("new-sale"),source())
        assertFalse(OutboxStore(db).backfillBatch())
        assertTrue(OutboxStore(db).backfillBatch())
        assertEquals(206,db.outboxDao().all(orders.syncIdentity().chainId).size)
        assertTrue(outbox.backfillBatch())
        assertEquals(before,JSONObject(orders.snapshot().toString()).apply {
            getJSONArray("orders").remove(205); getJSONArray("technicalStates").remove(205); getJSONArray("entries").remove(205)
            put("metadata",JSONObject(before).getJSONObject("metadata"))
        }.toString())
    }
    @Test fun backoffAndRetryAfterAreBoundedAndReproducible() {
        assertEquals(5000L,SyncEngine.backoff(1) { it })
        assertEquals(21600000L,SyncEngine.backoff(99) { it })
        assertEquals(0L,SyncEngine.backoff(99) { 0 })
        assertEquals(60000L,SyncEngine.retryAfter("60",0))
        assertNull(SyncEngine.retryAfter("invalid",0))
    }
    @Test fun disabledSyncStillCapturesAndCanResumeWithoutConcurrentQueue() = run {
        outbox.setEnabled(false)
        orders.createOrder(request("disabled"),source())
        engine({ _, _ -> error("sync disabled") }).drain()
        assertEquals("pending",db.outboxDao().find("sale:disabled")!!.status)
        assertFalse(outbox.diagnostics().getBoolean("enabled"))
        outbox.setEnabled(true)
        engine({ _, body -> response(body) }).drain()
        assertEquals("synced",db.outboxDao().find("sale:disabled")!!.status)
    }
    @Test fun serverBatchLimitShrinksDurablyAndOversizeSingletonIsQuarantined() = run {
        repeat(4) { orders.createOrder(request("batch-$it"),source()) }
        val refusing = engine({ _, _ -> throw SyncHttpFailure(413,"BATCH_TOO_LARGE") })
        refusing.drain()
        assertEquals(50,db.outboxDao().backfill()!!.batchLimit)
        repeat(6) { refusing.drain() }
        assertEquals("quarantined",db.outboxDao().all(orders.syncIdentity().chainId).first().status)
        assertEquals("EVENT_TOO_LARGE",db.outboxDao().all(orders.syncIdentity().chainId).first().lastError)
    }
    @Test fun legacyImportedBeforeLedgerAndRestorationDoesNotPrintOrInventHashes() = run {
        orders.createOrder(request("legacy"),source())
        val snapshot = orders.snapshot()
        val legacy = snapshot.getJSONArray("orders").getJSONObject(0).apply { remove("integrity") }
        val immutable = JSONObject(legacy.toString()).apply { remove("printing") }
        // Restore a real historical unsealed record on a fresh database.
        db.close()
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(),SamhainPosDatabase::class.java).build()
        orders = RoomOrderStore(db); outbox = OutboxStore(db)
        snapshot.put("entries",JSONArray()).getJSONObject("metadata").put("nextJournalSequence",1).put("lastJournalHash",JSONObject.NULL)
        orders.restoreSnapshot(snapshot)
        orders.confirmSyncContinuity()
        orders.createOrder(request("sealed"),source())
        val before = orders.snapshot().toString()
        val endpoints = mutableListOf<ProtectedSyncEndpoint>()
        val worker = engine({ endpoint, body ->
            endpoints.add(endpoint)
            if(endpoint == ProtectedSyncEndpoint.LEGACY) {
                val sent = body.getJSONArray("events").getJSONObject(0)
                assertEquals("legacy",sent.getString("eventId"))
                assertTrue(sent.isNull("sequence") && sent.isNull("hash"))
                assertFalse(body.has("expectedHead"))
                assertEquals(SyncProtocol.canonical(immutable),sent.getString("payloadCanonical"))
            }
            response(body)
        })
        worker.drain(); worker.drain()
        assertEquals(listOf(ProtectedSyncEndpoint.LEGACY,ProtectedSyncEndpoint.LEDGER),endpoints)
        assertEquals(before,orders.snapshot().toString())
        assertEquals(2,db.outboxDao().all(orders.syncIdentity().chainId).size)
    }
    @Test fun prefixRecoveryRepairsMissingCaptureAndDoesNotTreatDiagnosticAsAck() = run {
        repeat(3) { orders.createOrder(request("sale-$it"),source()) }
        outbox.backfillBatch()
        val chain = orders.syncIdentity().chainId
        db.openHelper.writableDatabase.execSQL("DELETE FROM outbox WHERE sequence = 1")
        var prefixCalls = 0
        engine({ endpoint, body ->
            if(endpoint == ProtectedSyncEndpoint.LEDGER) throw SyncHttpFailure(409,"MISSING_PREDECESSOR")
            prefixCalls++
            val result = response(body).apply {
                remove("committed"); remove("acknowledgements")
                put("serverHead",JSONObject().put("sequence",0).put("hash",JSONObject.NULL))
                put("results",JSONArray().also { results ->
                    val events = body.getJSONArray("events")
                    for(i in 0 until events.length()) results.put(JSONObject(events.getJSONObject(i).toString()).put("status","absent"))
                })
            }
            result
        }).drain()
        assertEquals(1,prefixCalls)
        assertEquals(listOf(1L,2L,3L),db.outboxDao().all(chain).map { it.sequence })
        assertTrue(db.outboxDao().all(chain).all { it.status == "pending" && it.receiptId == null })
        engine({ _, body -> response(body) }).drain()
        assertTrue(db.outboxDao().all(chain).all { it.status == "synced" })
    }
    @Test fun concurrentDrainsOnlySendOneUsefulBatch() = run {
        orders.createOrder(request("one"),source())
        var sent = 0
        engine({ _, body ->
            sent++
            val competing = executor.submit<Long?> { engine({ _, _ -> error("concurrent send") }).drain() }
            assertNotNull(competing.get())
            response(body)
        }).drain()
        assertEquals(1,sent)
        assertEquals("synced",db.outboxDao().find("sale:one")!!.status)
    }
    @Test fun explicitMigrationSixToSevenAndDiskRestartPreserveClaimAndBackfill() = run {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val name = "outbox-v6-${UUID.randomUUID()}.db"
        var durable = Room.databaseBuilder(context,SamhainPosDatabase::class.java,name).build()
        var financial: String
        val originalChain: String
        try {
            val financialStore = RoomOrderStore(durable)
            financialStore.createOrder(request("disk-sale"),source())
            financial = financialStore.snapshot().toString()
            originalChain = financialStore.syncIdentity().chainId
            val path = "schemas/fr.samhain.pos.SamhainPosDatabase/6.json"
            val schema = listOf(java.io.File(path),java.io.File("app/$path"),java.io.File("android/app/$path")).first { it.exists() }
            val hash = JSONObject(schema.readText()).getJSONObject("database").getString("identityHash")
            val sqlite = durable.openHelper.writableDatabase
            sqlite.execSQL("DROP TABLE outbox"); sqlite.execSQL("DROP TABLE outbox_backfill")
            sqlite.execSQL("UPDATE room_master_table SET identity_hash = ? WHERE id=42",arrayOf(hash)); sqlite.version = 6
        } finally { durable.close() }
        durable = Room.databaseBuilder(context,SamhainPosDatabase::class.java,name).addMigrations(SamhainPosDatabase.MIGRATION_6_7).build()
        try {
            assertEquals(financial,RoomOrderStore(durable).snapshot().toString())
            val restored = OutboxStore(durable)
            assertTrue(restored.backfillBatch())
            assertEquals(originalChain,RoomOrderStore(durable).syncIdentity().chainId)
            val binding = scope().put("chainId",originalChain)
            assertEquals(1,restored.claim(binding,"crashed-before-network",clock).size)
        } finally { durable.close() }
        durable = Room.databaseBuilder(context,SamhainPosDatabase::class.java,name).build()
        try {
            assertEquals("sending",durable.outboxDao().find("sale:disk-sale")!!.status)
            assertEquals(1L,durable.outboxDao().backfill()!!.ledgerCursor)
            clock += 120001
            val worker = SyncEngine(durable,{ scope().put("chainId",originalChain) },{ _, body -> response(body) },{ clock },{ it })
            worker.drain()
            assertEquals("synced",durable.outboxDao().find("sale:disk-sale")!!.status)
            assertEquals(financial,RoomOrderStore(durable).snapshot().toString())
        } finally { durable.close(); context.deleteDatabase(name) }
    }
    private fun request(
        id: String,
        paymentMethod: String = "cash",
        totalCents: Long = 500,
    ): JSONObject =
        JSONObject().apply {
            put("id", id)
            put("orderNumberPrefix", "A")
            put("receiptNumberPrefix", "R-A-20260901")
            put(
                "terminal",
                JSONObject().put("terminalId", "terminal-a").put("terminalCode", "A")
                    .put("displayName", "Caisse A"),
            )
            put("paymentMethod", paymentMethod)
            put("paymentStatus", "paid")
            put("paidAt", "2026-09-01T12:00:00.000Z")
            put(
                "items",
                JSONArray().put(
                    JSONObject().put("lineId", "line-1").put("productId", "product-1")
                        .put("name", "Produit test").put("quantity", 1)
                        .put("unitPriceCents", totalCents).put("vatRate", 10),
                ),
            )
            put("itemCount", 1)
            put("totalCents", totalCents)
            put("createdAt", "2026-09-01T12:00:00.000Z")
            put("status", "confirmed")
            put(
                "printing",
                JSONObject().put("status", "pending").put("customerReceipt", "pending")
                    .put("preparationTicket", "pending").put("attempts", 0)
                    .put("updatedAt", "2026-09-01T12:00:00.000Z"),
            )
        }

    private fun checkoutIntent(id: String): JSONObject {
        val order = request(id)
        return JSONObject().apply {
            put("id", id)
            put("cartSnapshot", JSONArray(order.getJSONArray("items").toString()))
            put("itemCount", order.getLong("itemCount"))
            put("totalCents", order.getLong("totalCents"))
            put("paymentMethod", order.getString("paymentMethod"))
            put("status", "pending_payment")
            put("terminal", JSONObject(order.getJSONObject("terminal").toString()))
            put("ledgerSource", source())
            put("orderNumberPrefix", order.getString("orderNumberPrefix"))
            put("receiptNumberPrefix", order.getString("receiptNumberPrefix"))
            put("printCustomerReceipt", true)
            put("createdAt", order.getString("createdAt"))
            put("updatedAt", order.getString("createdAt"))
        }
    }


    private fun source(): JSONObject =
        JSONObject().apply {
            put("softwareVersion", "test")
            put("buildMode", "test")
            put(
                "terminal",
                JSONObject().put("terminalId", "terminal-a").put("terminalCode", "A")
                    .put("displayName", "Caisse A"),
            )
            put("organization", JSONObject().put("organizationName", "Test"))
        }


}
