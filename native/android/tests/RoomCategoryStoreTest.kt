package __APP_PACKAGE__

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import java.util.UUID
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RoomCategoryStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test fun categoryCrudAndProductsSurviveRestartWithoutReseedingChanges() {
        val name = "categories-${UUID.randomUUID()}.db"
        val executor = Executors.newSingleThreadExecutor()
        var database = Room.databaseBuilder(context, SamhainPosDatabase::class.java, name).build()
        try {
            executor.submit {
                val store = RoomCatalogStore(database)
                store.initialize(JSONArray())
                store.createCategory(JSONObject().put("id", "new-category").put("label", "  Spécialités  "))
                assertThrows(IllegalArgumentException::class.java) { store.createCategory(JSONObject().put("id", "empty").put("label", "   ")) }
                assertThrows(IllegalArgumentException::class.java) { store.createCategory(JSONObject().put("id", "duplicate").put("label", "SPECIALITES")) }
                store.create(product("one", "new-category"))
                store.setCategoryActive("new-category", false)
                assertThrows(IllegalArgumentException::class.java) { store.create(product("two", "new-category")) }
                assertThrows(IllegalArgumentException::class.java) { store.create(product("unknown", "missing")) }
                assertThrows(IllegalArgumentException::class.java) { store.update(product("one", "missing")) }
                store.update(product("one", "new-category").put("name", "Produit renommé"))
                store.updateCategory("new-category", "Du jour")
                assertThrows(IllegalArgumentException::class.java) { store.updateCategory("menus", "DU JOUR") }
                val ids = database.categoryDao().getAll().map { it.id }.reversed()
                store.reorderCategories(JSONArray(ids))
                val before = store.getCategories().toString()
                assertThrows(IllegalArgumentException::class.java) { store.reorderCategories(JSONArray().put("menus")) }
                assertEquals(before, store.getCategories().toString())
            }.get()
            database.close()
            database = Room.databaseBuilder(context, SamhainPosDatabase::class.java, name).build()
            executor.submit {
                val store = RoomCatalogStore(database)
                store.initialize(JSONArray())
                val first = store.getCategories().getJSONArray("categories").getJSONObject(0)
                assertEquals("new-category", first.getString("id"))
                assertEquals("Du jour", first.getString("label"))
                assertFalse(first.getBoolean("active"))
                assertEquals(0, first.getInt("displayOrder"))
                assertEquals(7, store.getCategories().getJSONArray("categories").length())
                assertEquals("new-category", store.getAll().getJSONArray("products").getJSONObject(0).getString("categoryId"))
                store.setCategoryActive("new-category", true)
                store.create(product("two", "new-category"))
            }.get()
        } finally { database.close(); executor.shutdownNow(); context.deleteDatabase(name) }
    }

    @Test fun failedReorderAndInitializationRollBackAllWrites() {
        val database = Room.inMemoryDatabaseBuilder(context, SamhainPosDatabase::class.java).build()
        val executor = Executors.newSingleThreadExecutor()
        try {
            executor.submit {
                val store = RoomCatalogStore(database)
                assertThrows(Exception::class.java) { store.initialize(JSONArray().put(product("duplicate", "menus")).put(product("duplicate", "menus"))) }
                assertEquals(0, database.productDao().count())
                assertNull(database.catalogMetadataDao().get())
                store.initialize(JSONArray())
                val before = store.getCategories().toString()
                val sqlite = database.openHelper.writableDatabase
                sqlite.execSQL("CREATE TRIGGER fail_category_update BEFORE UPDATE ON categories WHEN NEW.id = 'bieres' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
                assertThrows(Exception::class.java) { store.reorderCategories(JSONArray(database.categoryDao().getAll().map { it.id }.reversed())) }
                assertEquals(before, store.getCategories().toString())
            }.get()
        } finally { database.close(); executor.shutdownNow() }
    }

    private fun product(id: String, category: String) = JSONObject()
        .put("id", id).put("name", "Produit test").put("categoryId", category)
        .put("active", true).put("displayOrder", 0).put("requiresPreparation", false)
        .put("availability", "available").put("priceCents", 500).put("vatRate", 10)
}
