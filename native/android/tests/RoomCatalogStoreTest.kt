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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RoomCatalogStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var database: SamhainPosDatabase
    private lateinit var store: RoomCatalogStore

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        store = RoomCatalogStore(database)
    }

    @After
    fun tearDown() {
        database.close()
        executor.shutdownNow()
    }

    @Test
    fun stagesAndActivatesWithAtomicRevisionAndKeepsLocalWrites() = onDatabaseThread {
        store.initialize(JSONArray().put(product("seed", "Initial", 500)))
        val first = store.snapshot()
        val state = JSONObject().put("legacyMigrated", true).put("conflicts", JSONArray()).put("decisions", JSONArray())
        first.put("distribution", state)
        store.commit(first)
        val stale = store.snapshot()
        store.update(product("seed", "Local", 650))
        try { store.commit(stale); org.junit.Assert.fail("Stale commit accepted") }
        catch (expected: IllegalArgumentException) { assertTrue(expected.message!!.contains("CATALOG_CHANGED")) }
        assertEquals(650, store.getAll().getJSONArray("products").getJSONObject(0).getInt("priceCents"))

        val next = store.snapshot()
        next.put("activation", true)
        next.getJSONArray("products").getJSONObject(0).put("priceCents", 800)
        next.getJSONObject("distribution").put("activationMarker", "revision-2")
        store.commit(next)
        assertEquals(800, store.snapshot().getJSONArray("products").getJSONObject(0).getInt("priceCents"))
        assertEquals("revision-2", store.snapshot().getJSONObject("distribution").getString("activationMarker"))
    }

    @Test
    fun pendingPaymentBlocksTheWholeActivationTransaction() = onDatabaseThread {
        store.initialize(JSONArray().put(product("seed", "Initial", 500)))
        val snapshot = store.snapshot().put("distribution", JSONObject()).put("activation", true)
        snapshot.getJSONArray("products").getJSONObject(0).put("priceCents", 800)
        database.checkoutIntentDao().insert(CheckoutIntentEntity("payment", "payment_confirmed", "now", "now", "card", 500, null, "{}"))
        try { store.commit(snapshot); org.junit.Assert.fail("Pending payment ignored") }
        catch (expected: IllegalArgumentException) { assertTrue(expected.message!!.contains("paiement")) }
        assertEquals(500, store.snapshot().getJSONArray("products").getJSONObject(0).getInt("priceCents"))
        assertEquals(snapshot.getLong("revision"), store.snapshot().getLong("revision"))
        database.checkoutIntentDao().update(database.checkoutIntentDao().findById("payment")!!.copy(status = "finalized"))
        store.commit(snapshot)
        assertEquals(800, store.snapshot().getJSONArray("products").getJSONObject(0).getInt("priceCents"))
    }

    @Test
    fun rollbackRestoresCategoriesProductsAndVersionAfterMidCommitFailure() = onDatabaseThread {
        store.initialize(JSONArray().put(product("seed", "Initial", 500)))
        val before = store.snapshot()
        val snapshot = JSONObject(before.toString()).put("distribution", JSONObject())
        val rows = snapshot.getJSONArray("categories")
        rows.getJSONObject(0).put("label", "Changed before failure")
        rows.getJSONObject(1).put("label", "Changed before failure")
        snapshot.getJSONArray("products").getJSONObject(0).put("priceCents", 800)
        try { store.commit(snapshot); org.junit.Assert.fail("Duplicate label accepted") }
        catch (_: android.database.sqlite.SQLiteConstraintException) { }
        assertEquals(before.toString(), store.snapshot().toString())
    }

    @Test
    fun migrationEightToNineKeepsCatalogAndFinancialRows() {
        database.close()
        val name = "catalog-v9-${UUID.randomUUID()}.db"
        val helper = FrameworkSQLiteOpenHelperFactory().create(SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(name).callback(object : SupportSQLiteOpenHelper.Callback(8) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL("CREATE TABLE products (id TEXT NOT NULL PRIMARY KEY, payload TEXT)")
                    db.execSQL("INSERT INTO products VALUES ('kept','unchanged')")
                    db.execSQL("CREATE TABLE orders (id TEXT NOT NULL PRIMARY KEY)")
                    db.execSQL("INSERT INTO orders VALUES ('historic')")
                }
                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            }).build())
        try {
            val sqlite = helper.writableDatabase
            SamhainPosDatabase.MIGRATION_8_9.migrate(sqlite)
            sqlite.query("SELECT payload FROM products").use { assertTrue(it.moveToFirst()); assertEquals("unchanged", it.getString(0)) }
            sqlite.query("SELECT id FROM orders").use { assertTrue(it.moveToFirst()); assertEquals("historic", it.getString(0)) }
            sqlite.query("SELECT COUNT(*) FROM catalog_distribution").use { assertTrue(it.moveToFirst()); assertEquals(0, it.getInt(0)) }
        } finally {
            helper.close(); context.deleteDatabase(name)
            database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        }
    }

    @Test
    fun seedsOnlyOnceAndKeepsAdministrativeChanges() = onDatabaseThread {
        val first = store.initialize(JSONArray().put(product("seed", "Produit initial", 500)))
        assertTrue(first.getBoolean("initialized"))
        store.update(product("seed", "Produit modifié", 650))

        val second = store.initialize(JSONArray().put(product("other", "Écrasement", 999)))
        assertFalse(second.getBoolean("initialized"))
        assertEquals(1, second.getJSONArray("products").length())
        assertEquals("Produit modifié", second.getJSONArray("products").getJSONObject(0).getString("name"))
    }

    @Test
    fun createsUpdatesDisablesAndReactivatesAProduct() = onDatabaseThread {
        store.initialize(JSONArray())
        store.create(product("created", "Créé", 450))
        assertEquals(450, store.getAll().getJSONArray("products").getJSONObject(0).getInt("priceCents"))

        val disabled = product("created", "Modifié", 500).put("active", false)
        assertFalse(store.update(disabled).getBoolean("active"))
        assertFalse(store.getAll().getJSONArray("products").getJSONObject(0).getBoolean("active"))
        assertEquals(0, store.getSellable().getJSONArray("products").length())

        disabled.put("active", true)
        assertTrue(store.update(disabled).getBoolean("active"))
        assertEquals(1, store.getSellable().getJSONArray("products").length())
    }

    @Test
    fun catalogSurvivesDatabaseCloseAndReopen() {
        database.close()
        val name = "catalog-reopen-${UUID.randomUUID()}.db"
        val first =
            Room.databaseBuilder(context, SamhainPosDatabase::class.java, name)
                .addMigrations(
                    SamhainPosDatabase.MIGRATION_1_2,
                    SamhainPosDatabase.MIGRATION_2_3,
                    SamhainPosDatabase.MIGRATION_3_4,
                    SamhainPosDatabase.MIGRATION_4_5,
                ).build()
        onDatabaseThread {
            val durableStore = RoomCatalogStore(first)
            durableStore.initialize(JSONArray().put(product("durable", "Durable", 300)))
            val snapshot = durableStore.snapshot()
            val payload = "{\"revision\":1}"
            val hash = java.security.MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            snapshot.put("distribution", JSONObject().put("pending", JSONObject().put("payload", payload).put("sha256", hash)))
            durableStore.commit(snapshot)
        }
        first.close()

        val reopened =
            Room.databaseBuilder(context, SamhainPosDatabase::class.java, name)
                .addMigrations(
                    SamhainPosDatabase.MIGRATION_1_2,
                    SamhainPosDatabase.MIGRATION_2_3,
                    SamhainPosDatabase.MIGRATION_3_4,
                    SamhainPosDatabase.MIGRATION_4_5,
                ).build()
        try {
            onDatabaseThread {
                val durableStore = RoomCatalogStore(reopened)
                assertTrue(durableStore.snapshot().getJSONObject("distribution").has("pending"))
                assertEquals(300, durableStore.snapshot().getJSONArray("products").getJSONObject(0).getInt("priceCents"))
                val activation = durableStore.snapshot().put("activation", true)
                val state = activation.getJSONObject("distribution")
                state.put("active", state.getJSONObject("pending")); state.remove("pending")
                activation.getJSONArray("products").getJSONObject(0).put("priceCents", 800)
                durableStore.commit(activation)
                assertEquals(
                    "durable",
                    RoomCatalogStore(reopened).getAll().getJSONArray("products")
                        .getJSONObject(0).getString("id"),
                )
            }
            reopened.close()
            val afterActivation = Room.databaseBuilder(context, SamhainPosDatabase::class.java, name).build()
            try {
                onDatabaseThread {
                    val snapshot = RoomCatalogStore(afterActivation).snapshot()
                    assertTrue(snapshot.getJSONObject("distribution").has("active"))
                    assertFalse(snapshot.getJSONObject("distribution").has("pending"))
                    assertEquals(800, snapshot.getJSONArray("products").getJSONObject(0).getInt("priceCents"))
                }
            } finally { afterActivation.close() }
        } finally {
            reopened.close()
            context.deleteDatabase(name)
            database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        }
    }

    @Test
    fun migrationFourToFivePreservesExistingTablesAndCreatesCatalogTables() {
        database.close()
        val name = "migration-catalog-${UUID.randomUUID()}.db"
        val helper =
            FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                    .name(name)
                    .callback(
                        object : SupportSQLiteOpenHelper.Callback(4) {
                            override fun onCreate(db: SupportSQLiteDatabase) {
                                db.execSQL("CREATE TABLE orders (id TEXT NOT NULL PRIMARY KEY)")
                                db.execSQL("INSERT INTO orders VALUES ('kept-order')")
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
        SamhainPosDatabase.MIGRATION_4_5.migrate(sqlite)
        sqlite.query("SELECT id FROM orders").use {
            assertTrue(it.moveToFirst())
            assertEquals("kept-order", it.getString(0))
        }
        sqlite.query("SELECT COUNT(*) FROM products").use {
            assertTrue(it.moveToFirst())
            assertEquals(0, it.getInt(0))
        }
        sqlite.query("SELECT COUNT(*) FROM catalog_metadata").use {
            assertTrue(it.moveToFirst())
            assertEquals(0, it.getInt(0))
        }
        helper.close()
        context.deleteDatabase(name)
        database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
    }

    private fun product(id: String, name: String, priceCents: Int): JSONObject =
        JSONObject().apply {
            put("id", id)
            put("name", name)
            put("categoryId", "assiettes")
            put("active", true)
            put("displayOrder", 0)
            put("requiresPreparation", true)
            put("availability", "available")
            put("priceCents", priceCents)
            put("vatRate", 10)
        }

    private fun <T> onDatabaseThread(block: () -> T): T = executor.submit<T> { block() }.get()
}
