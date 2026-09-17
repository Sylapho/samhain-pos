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
            RoomCatalogStore(first).initialize(JSONArray().put(product("durable", "Durable", 300)))
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
                assertEquals(
                    "durable",
                    RoomCatalogStore(reopened).getAll().getJSONArray("products")
                        .getJSONObject(0).getString("id"),
                )
            }
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
