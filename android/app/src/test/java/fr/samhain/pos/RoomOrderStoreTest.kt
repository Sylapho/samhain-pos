package fr.samhain.pos

import android.content.Context
import androidx.room.Room
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomOrderStoreTest {
    private lateinit var context: Context
    private lateinit var database: SamhainPosDatabase
    private lateinit var store: RoomOrderStore
    private val executor = Executors.newSingleThreadExecutor()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        store = RoomOrderStore(database)
    }

    @After
    fun tearDown() {
        database.close()
        executor.shutdownNow()
    }

    @Test
    fun createsReadsAndRollsBackSequencesWhenUuidIsDuplicated() = onDatabaseThread {
        val first = store.createOrder(request("same-id"), source())
        assertEquals("A-0001", first.getString("orderNumber"))

        assertThrows(Exception::class.java) {
            store.createOrder(request("same-id", paymentMethod = "card"), source())
        }

        val second = store.createOrder(request("next-id"), source())
        assertEquals("A-0002", second.getString("orderNumber"))
        assertEquals("R-A-20260901-0002", second.getString("receiptNumber"))
        assertEquals(2, store.snapshot().getJSONArray("orders").length())
    }

    @Test
    fun canonicalJsonMatchesTheTypeScriptHashContract() {
        val value = JSONObject().put("z", 2).put(
            "nested",
            JSONObject().put("b", true).put("a", "é"),
        )
        assertEquals("{\"nested\":{\"a\":\"é\",\"b\":true},\"z\":2}", CanonicalJson.stringify(value))
        assertEquals(
            "cf09fe475bf828b251d624c7cc80e10cf4e87f31f56a1f80107b242c4ed20c34",
            CanonicalJson.sha256(value),
        )
    }

    @Test
    fun rejectsNonIntegerFinancialValuesWithoutConsumingSequences() = onDatabaseThread {
        val invalid = request("invalid-number").put("totalCents", 12.5)
        assertThrows(Exception::class.java) { store.createOrder(invalid, source()) }
        assertEquals("A-0001", store.createOrder(request("valid-number"), source()).getString("orderNumber"))
    }

    @Test
    fun rejectsInvalidNewOrdersWithoutLeavingDataOrConsumingSequences() = onDatabaseThread {
        val invalidRequests =
            listOf(
                request("empty-items").apply {
                    put("items", JSONArray())
                    put("itemCount", 0)
                    put("totalCents", 0)
                },
                request("zero-quantity").mutateFirstItem("quantity", 0),
                request("negative-quantity").mutateFirstItem("quantity", -1),
                request("fractional-quantity").mutateFirstItem("quantity", 1.5),
                request("negative-price").mutateFirstItem("unitPriceCents", -1),
                request("unsafe-price").mutateFirstItem("unitPriceCents", 9_007_199_254_740_992.0),
                request("forged-count").put("itemCount", 2),
                request("forged-total").put("totalCents", 1),
                request("unknown-vat").mutateFirstItem("vatRate", 5),
                request("unknown-payment", paymentMethod = "bitcoin"),
                request("invalid-date").put("createdAt", "not-a-date"),
                request("invalid-terminal").apply {
                    getJSONObject("terminal").put("terminalCode", "Z")
                },
                request("duplicate-line").apply {
                    val items = getJSONArray("items")
                    items.put(JSONObject(items.getJSONObject(0).toString()))
                    put("itemCount", 2)
                    put("totalCents", 1_000)
                },
            )

        invalidRequests.forEach { invalid ->
            assertThrows(Exception::class.java) { store.createOrder(invalid, source()) }
        }

        val rejectedSnapshot = store.snapshot()
        assertEquals(0, rejectedSnapshot.getJSONArray("orders").length())
        assertEquals(0, rejectedSnapshot.getJSONArray("technicalStates").length())
        assertEquals(0, rejectedSnapshot.getJSONArray("entries").length())
        assertEquals(1L, rejectedSnapshot.getJSONObject("metadata").getLong("nextOrderSequence"))
        assertEquals(1L, rejectedSnapshot.getJSONObject("metadata").getLong("nextReceiptSequence"))
        assertEquals(1L, rejectedSnapshot.getJSONObject("metadata").getLong("nextJournalSequence"))

        val accepted = store.createOrder(request("accepted-after-rejections"), source())
        assertEquals("A-0001", accepted.getString("orderNumber"))
        assertEquals("R-A-20260901-0001", accepted.getString("receiptNumber"))
        val acceptedSnapshot = store.snapshot()
        assertEquals(1, acceptedSnapshot.getJSONArray("orders").length())
        assertEquals(1, acceptedSnapshot.getJSONArray("technicalStates").length())
        assertEquals(1, acceptedSnapshot.getJSONArray("entries").length())
        assertEquals(1L, acceptedSnapshot.getJSONArray("entries").getJSONObject(0).getLong("sequence"))
    }

    @Test
    fun checkoutIntentDoesNotConsumeSequencesAndFinalizesIdempotently() = onDatabaseThread {
        val created = store.createCheckoutIntent(checkoutIntent("intent-1"))
        assertEquals("pending_payment", created.getString("status"))
        val before = store.snapshot()
        assertEquals(0, before.getJSONArray("orders").length())
        assertEquals(0, before.getJSONArray("entries").length())
        assertEquals(1L, before.getJSONObject("metadata").getLong("nextOrderSequence"))
        assertEquals(1L, before.getJSONObject("metadata").getLong("nextReceiptSequence"))
        assertEquals(1L, before.getJSONObject("metadata").getLong("nextJournalSequence"))

        store.markCheckoutPaymentToVerify("intent-1", "2026-09-01T12:01:00.000Z")
        store.confirmCheckoutPayment("intent-1", "2026-09-01T12:02:00.000Z")
        val first = store.finalizeCheckoutIntent("intent-1", "2026-09-01T12:03:00.000Z")
        val repeated = store.finalizeCheckoutIntent("intent-1", "2026-09-01T12:04:00.000Z")
        assertEquals(first.getString("id"), repeated.getString("id"))
        assertEquals("A-0001", first.getString("orderNumber"))

        val after = store.snapshot()
        assertEquals(1, after.getJSONArray("orders").length())
        assertEquals(1, after.getJSONArray("entries").length())
        assertEquals(2L, after.getJSONObject("metadata").getLong("nextOrderSequence"))
        assertEquals(2L, after.getJSONObject("metadata").getLong("nextReceiptSequence"))
        assertEquals(2L, after.getJSONObject("metadata").getLong("nextJournalSequence"))
        assertEquals(
            "finalized",
            store.checkoutIntents().getJSONArray("intents").getJSONObject(0).getString("status"),
        )
    }

    @Test
    fun checkoutWithoutPreparationFinalizesWithNoRequestedDocument() = onDatabaseThread {
        val intent = checkoutIntent("no-preparation")
        intent.put("printCustomerReceipt", false)
        intent.getJSONArray("cartSnapshot").getJSONObject(0).put("requiresPreparation", false)
        store.createCheckoutIntent(intent)
        store.markCheckoutPaymentToVerify("no-preparation", "2026-09-01T12:01:00.000Z")
        store.confirmCheckoutPayment("no-preparation", "2026-09-01T12:02:00.000Z")

        val order =
            store.finalizeCheckoutIntent("no-preparation", "2026-09-01T12:03:00.000Z")
        val state = order.getJSONObject("printing")
        assertEquals("printed", state.getString("status"))
        assertEquals("not_requested", state.getString("customerReceipt"))
        assertEquals("not_requested", state.getString("preparationTicket"))
    }

    @Test
    fun abandonedCheckoutIntentCreatesNoFinancialRecord() = onDatabaseThread {
        store.createCheckoutIntent(checkoutIntent("abandoned-intent"))
        store.markCheckoutPaymentToVerify("abandoned-intent", "2026-09-01T12:01:00.000Z")
        store.abandonCheckoutIntent("abandoned-intent", "2026-09-01T12:02:00.000Z")
        val snapshot = store.snapshot()
        assertEquals(0, snapshot.getJSONArray("orders").length())
        assertEquals(0, snapshot.getJSONArray("entries").length())
        assertEquals(1L, snapshot.getJSONObject("metadata").getLong("nextOrderSequence"))
        assertEquals(1L, snapshot.getJSONObject("metadata").getLong("nextReceiptSequence"))
        assertEquals(1L, snapshot.getJSONObject("metadata").getLong("nextJournalSequence"))
    }

    @Test
    fun failedCheckoutFinalizationRollsBackAndRemainsRetryable() = onDatabaseThread {
        store.createCheckoutIntent(checkoutIntent("retryable-intent"))
        store.markCheckoutPaymentToVerify("retryable-intent", "2026-09-01T12:01:00.000Z")
        store.confirmCheckoutPayment("retryable-intent", "2026-09-01T12:02:00.000Z")
        store.snapshot()
        database.metadataDao().update(
            PosMetadataEntity(nextOrderSequence = 9_007_199_254_740_991L),
        )

        assertThrows(Exception::class.java) {
            store.finalizeCheckoutIntent("retryable-intent", "2026-09-01T12:03:00.000Z")
        }
        val failedSnapshot = store.snapshot()
        assertEquals(0, failedSnapshot.getJSONArray("orders").length())
        assertEquals(0, failedSnapshot.getJSONArray("entries").length())
        assertEquals(
            "payment_confirmed",
            store.checkoutIntents().getJSONArray("intents").getJSONObject(0).getString("status"),
        )

        database.metadataDao().update(PosMetadataEntity())
        val retried =
            store.finalizeCheckoutIntent("retryable-intent", "2026-09-01T12:04:00.000Z")
        assertEquals("A-0001", retried.getString("orderNumber"))
        assertEquals(1, store.snapshot().getJSONArray("orders").length())
    }

    @Test
    fun persistsAllPrintingRecoveryStatesWithCompareAndSet() = onDatabaseThread {
        val states = listOf("pending", "unknown", "printed", "partial", "failed")
        states.forEachIndexed { index, status ->
            val orderId = "print-$index"
            val created = store.createOrder(request(orderId), source())
            val current = created.getJSONObject("printing")
            val replacement =
                JSONObject(current.toString()).apply {
                    put("status", status)
                    put("customerReceipt", if (status == "printed") "printed" else "unknown")
                    put("preparationTicket", if (status == "printed") "printed" else "failed")
                    put("attempts", index + 1)
                }
            assertTrue(
                store.compareAndSetPrinting(orderId, current, replacement).getBoolean("updated"),
            )
            assertFalse(
                store.compareAndSetPrinting(orderId, current, replacement).getBoolean("updated"),
            )
        }
        val persisted = store.snapshot().getJSONArray("technicalStates")
        assertEquals(states.toSet(), (0 until persisted.length()).map {
            persisted.getJSONObject(it).getJSONObject("printing").getString("status")
        }.toSet())
    }

    @Test
    fun appendsCorrectionsAndClosuresToTheSameAtomicJournal() = onDatabaseThread {
        store.createOrder(request("ledger-order"), source())
        val correctionRequest =
            JSONObject().apply {
                put("operationId", "refund-1")
                put("originalOrderId", "ledger-order")
                put("type", "refund")
                put("reason", "Remboursement test")
                put("amountDeltaCents", -100)
                put("recordedAt", "2026-09-01T13:00:00.000Z")
                put("source", source())
            }
        val correction = store.recordCorrection(correctionRequest)
        assertEquals(2L, correction.getLong("sequence"))
        assertEquals(
            correction.getString("id"),
            store.recordCorrection(correctionRequest).getString("id"),
        )

        val closure =
            store.closePeriod(
                JSONObject().apply {
                    put("operationId", "closure-1")
                    put("periodStart", "2026-09-01T00:00:00.000Z")
                    put("periodEnd", "2026-09-02T00:00:00.000Z")
                    put("recordedAt", "2026-09-02T01:00:00.000Z")
                    put("source", source())
                },
            )
        assertEquals(3L, closure.getLong("sequence"))
        assertEquals(400L, closure.getJSONObject("closure").getJSONObject("totals").getLong("netTotalCents"))

        val snapshot = store.snapshot()
        assertEquals(4L, snapshot.getJSONObject("metadata").getLong("nextJournalSequence"))
        var previousHash: String? = null
        val entries = snapshot.getJSONArray("entries")
        for (index in 0 until entries.length()) {
            val entry = entries.getJSONObject(index)
            assertEquals(previousHash, if (entry.isNull("previousHash")) null else entry.getString("previousHash"))
            val hash = entry.getString("hash")
            entry.remove("hash")
            assertEquals(hash, CanonicalJson.sha256(entry))
            previousHash = hash
        }
    }

    @Test
    fun importsEmptyAndAdvancedLegacySnapshotsIdempotently() = onDatabaseThread {
        val snapshot = emptySnapshot(nextOrder = 8, nextReceipt = 12)
        val first = store.importLegacySnapshot(snapshot)
        assertEquals(0, first.getInt("totalOrders"))
        assertTrue(store.legacyMigrationStatus().getBoolean("completed"))

        val second = store.importLegacySnapshot(snapshot)
        assertEquals(0, second.getInt("importedOrders"))
        val created = store.createOrder(request("after-migration"), source())
        assertEquals("A-0008", created.getString("orderNumber"))
        assertEquals("R-A-20260901-0012", created.getString("receiptNumber"))
    }

    @Test
    fun restoresSnapshotMetadataWithoutReconstructingSequences() = onDatabaseThread {
        val sourceDatabase = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        try {
            val sourceStore = RoomOrderStore(sourceDatabase)
            sourceStore.createOrder(request("archived-order"), source())
            val snapshot = sourceStore.snapshot()
            snapshot.getJSONObject("metadata")
                .put("nextOrderSequence", 9)
                .put("nextReceiptSequence", 12)
                .put("nextJournalSequence", 2)

            val result = store.restoreSnapshot(snapshot)

            assertEquals(1, result.getInt("restoredOrders"))
            assertEquals(1, result.getInt("restoredEntries"))
            val restoredMetadata = store.snapshot().getJSONObject("metadata")
            assertEquals(9L, restoredMetadata.getLong("nextOrderSequence"))
            assertEquals(12L, restoredMetadata.getLong("nextReceiptSequence"))
            assertEquals(2L, restoredMetadata.getLong("nextJournalSequence"))
            assertEquals(
                snapshot.getJSONObject("metadata").getString("lastJournalHash"),
                restoredMetadata.getString("lastJournalHash"),
            )
        } finally {
            sourceDatabase.close()
        }
    }

    @Test
    fun restoreSnapshotRollsBackEveryTableAndMetadataOnMidRestoreFailure() = onDatabaseThread {
        val sourceDatabase = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        try {
            val sourceStore = RoomOrderStore(sourceDatabase)
            sourceStore.createOrder(request("duplicate-on-restore"), source())
            val brokenSnapshot = sourceStore.snapshot()
            val duplicate = JSONObject(brokenSnapshot.getJSONArray("orders").getJSONObject(0).toString())
            brokenSnapshot.getJSONArray("orders").put(duplicate)

            assertThrows(Exception::class.java) { store.restoreSnapshot(brokenSnapshot) }

            val afterFailure = store.snapshot()
            assertEquals(0, afterFailure.getJSONArray("orders").length())
            assertEquals(0, afterFailure.getJSONArray("technicalStates").length())
            assertEquals(0, afterFailure.getJSONArray("entries").length())
            val metadata = afterFailure.getJSONObject("metadata")
            assertEquals(1L, metadata.getLong("nextOrderSequence"))
            assertEquals(1L, metadata.getLong("nextReceiptSequence"))
            assertEquals(1L, metadata.getLong("nextJournalSequence"))
            assertTrue(metadata.isNull("lastJournalHash"))
        } finally {
            sourceDatabase.close()
        }
    }

    @Test
    fun importsSeveralOrdersAndAcceptsAnIdenticalExistingUuid() = onDatabaseThread {
        val legacyDb = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        try {
            val legacy = RoomOrderStore(legacyDb)
            legacy.createOrder(request("shared"), source())
            legacy.createOrder(request("legacy-only"), source())
            val snapshot = legacy.snapshot()

            store.createOrder(request("shared"), source())
            val result = store.importLegacySnapshot(snapshot)
            assertEquals(1, result.getInt("importedOrders"))
            assertEquals(2, result.getInt("totalOrders"))
            assertEquals(2, result.getInt("totalEntries"))
        } finally {
            legacyDb.close()
        }
    }

    @Test
    fun rejectsConflictingUuidAndLeavesMigrationRetryable() = onDatabaseThread {
        store.createOrder(request("conflict"), source())
        val legacyDb = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        try {
            val legacy = RoomOrderStore(legacyDb)
            legacy.createOrder(request("conflict", totalCents = 999), source())
            assertThrows(Exception::class.java) {
                store.importLegacySnapshot(legacy.snapshot())
            }
            assertFalse(store.legacyMigrationStatus().getBoolean("completed"))
            assertEquals(1, store.snapshot().getJSONArray("orders").length())
        } finally {
            legacyDb.close()
        }
    }

    @Test
    fun keepsOrdersAfterDatabaseCloseAndReopen() {
        database.close()
        val name = "room-reopen-${UUID.randomUUID()}.db"
        val first =
            Room.databaseBuilder(context, SamhainPosDatabase::class.java, name)
                .addMigrations(SamhainPosDatabase.MIGRATION_1_2)
                .build()
        onDatabaseThread {
            val firstStore = RoomOrderStore(first)
            firstStore.createOrder(request("durable"), source())
            firstStore.importLegacySnapshot(emptySnapshot())
        }
        first.close()

        val reopened =
            Room.databaseBuilder(context, SamhainPosDatabase::class.java, name)
                .addMigrations(SamhainPosDatabase.MIGRATION_1_2)
                .build()
        try {
            onDatabaseThread {
                assertEquals(
                    "durable",
                    RoomOrderStore(reopened).snapshot().getJSONArray("orders")
                        .getJSONObject(0).getString("id"),
                )
                assertTrue(RoomOrderStore(reopened).legacyMigrationStatus().getBoolean("completed"))
            }
        } finally {
            reopened.close()
            context.deleteDatabase(name)
            database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        }
    }

    @Test
    fun migrationOneToTwoPreservesRowsAndAddsSyncAndLegacyColumns() {
        database.close()
        val name = "migration-${UUID.randomUUID()}.db"
        val helper =
            FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                    .name(name)
                    .callback(
                        object : SupportSQLiteOpenHelper.Callback(1) {
                            override fun onCreate(db: SupportSQLiteDatabase) {
                                db.execSQL(
                                    "CREATE TABLE orders (id TEXT NOT NULL PRIMARY KEY, order_number TEXT NOT NULL, receipt_number TEXT NOT NULL)",
                                )
                                db.execSQL(
                                    "CREATE TABLE pos_metadata (id INTEGER NOT NULL PRIMARY KEY, next_order_sequence INTEGER NOT NULL, next_receipt_sequence INTEGER NOT NULL, next_journal_sequence INTEGER NOT NULL, last_journal_hash TEXT, last_closure_end TEXT)",
                                )
                                db.execSQL("INSERT INTO orders VALUES ('kept', 'A-0001', 'R-A-0001')")
                                db.execSQL("INSERT INTO pos_metadata VALUES (1, 2, 2, 1, NULL, NULL)")
                            }

                            override fun onUpgrade(
                                db: SupportSQLiteDatabase,
                                oldVersion: Int,
                                newVersion: Int,
                            ) = Unit
                        },
                    ).build(),
            )
        val sqlite = helper.writableDatabase
        SamhainPosDatabase.MIGRATION_1_2.migrate(sqlite)
        sqlite.query("SELECT id, sync_status, sync_attempts FROM orders").use {
            assertTrue(it.moveToFirst())
            assertEquals("kept", it.getString(0))
            assertEquals("pending", it.getString(1))
            assertEquals(0, it.getInt(2))
        }
        sqlite.query("SELECT legacy_migration_completed FROM pos_metadata").use {
            assertTrue(it.moveToFirst())
            assertEquals(0, it.getInt(0))
        }
        helper.close()
        context.deleteDatabase(name)
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
    }

    @Test
    fun migrationTwoToThreePreservesFinancialTablesAndCreatesCheckoutIntents() {
        database.close()
        val name = "migration-checkout-${UUID.randomUUID()}.db"
        val helper =
            FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                    .name(name)
                    .callback(
                        object : SupportSQLiteOpenHelper.Callback(2) {
                            override fun onCreate(db: SupportSQLiteDatabase) {
                                db.execSQL("CREATE TABLE orders (id TEXT NOT NULL PRIMARY KEY)")
                                db.execSQL("CREATE TABLE order_printing (order_id TEXT NOT NULL PRIMARY KEY)")
                                db.execSQL("CREATE TABLE sales_ledger (id TEXT NOT NULL PRIMARY KEY)")
                                db.execSQL("CREATE TABLE pos_metadata (id INTEGER NOT NULL PRIMARY KEY)")
                                db.execSQL("INSERT INTO orders VALUES ('kept-order')")
                                db.execSQL("INSERT INTO order_printing VALUES ('kept-order')")
                                db.execSQL("INSERT INTO sales_ledger VALUES ('sale:kept-order')")
                                db.execSQL("INSERT INTO pos_metadata VALUES (1)")
                            }

                            override fun onUpgrade(
                                db: SupportSQLiteDatabase,
                                oldVersion: Int,
                                newVersion: Int,
                            ) = Unit
                        },
                    ).build(),
            )
        val sqlite = helper.writableDatabase
        SamhainPosDatabase.MIGRATION_2_3.migrate(sqlite)
        for (table in listOf("orders", "order_printing", "sales_ledger", "pos_metadata")) {
            sqlite.query("SELECT COUNT(*) FROM $table").use {
                assertTrue(it.moveToFirst())
                assertEquals(1, it.getInt(0))
            }
        }
        sqlite.query("SELECT COUNT(*) FROM checkout_intents").use {
            assertTrue(it.moveToFirst())
            assertEquals(0, it.getInt(0))
        }
        helper.close()
        context.deleteDatabase(name)
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
    }

    @Test
    fun migrationThreeToFourAddsConservativePickupState() {
        database.close()
        val name = "migration-pickup-${UUID.randomUUID()}.db"
        val helper =
            FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                    .name(name)
                    .callback(
                        object : SupportSQLiteOpenHelper.Callback(3) {
                            override fun onCreate(db: SupportSQLiteDatabase) {
                                db.execSQL(
                                    """
                                    CREATE TABLE order_printing (
                                        order_id TEXT NOT NULL PRIMARY KEY,
                                        status TEXT NOT NULL,
                                        customer_receipt TEXT NOT NULL,
                                        preparation_ticket TEXT NOT NULL,
                                        attempts INTEGER NOT NULL,
                                        updated_at TEXT NOT NULL,
                                        last_error TEXT
                                    )
                                    """.trimIndent(),
                                )
                                db.execSQL(
                                    "INSERT INTO order_printing VALUES ('legacy', 'printed', 'printed', 'printed', 1, '2026-09-01T10:00:00.000Z', NULL)",
                                )
                            }

                            override fun onUpgrade(
                                db: SupportSQLiteDatabase,
                                oldVersion: Int,
                                newVersion: Int,
                            ) = Unit
                        },
                    ).build(),
            )
        val sqlite = helper.writableDatabase
        SamhainPosDatabase.MIGRATION_3_4.migrate(sqlite)
        sqlite.query("SELECT pickup_ticket FROM order_printing WHERE order_id = 'legacy'").use {
            assertTrue(it.moveToFirst())
            assertEquals("unknown", it.getString(0))
        }
        helper.close()
        context.deleteDatabase(name)
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
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

    private fun JSONObject.mutateFirstItem(key: String, value: Any): JSONObject =
        apply { getJSONArray("items").getJSONObject(0).put(key, value) }

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

    private fun emptySnapshot(nextOrder: Long = 1, nextReceipt: Long = 1): JSONObject =
        JSONObject().apply {
            put(
                "metadata",
                JSONObject().put("nextOrderSequence", nextOrder)
                    .put("nextReceiptSequence", nextReceipt)
                    .put("nextJournalSequence", 1).put("lastJournalHash", JSONObject.NULL),
            )
            put("orders", JSONArray())
            put("technicalStates", JSONArray())
            put("entries", JSONArray())
        }

    private fun <T> onDatabaseThread(block: () -> T): T = executor.submit<T> { block() }.get()
}
