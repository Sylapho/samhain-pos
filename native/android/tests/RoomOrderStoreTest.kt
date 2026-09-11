package __APP_PACKAGE__

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
            put("items", JSONArray())
            put("itemCount", 0)
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
