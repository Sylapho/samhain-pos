package __APP_PACKAGE__

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

@CapacitorPlugin(name = "CatalogStorage")
class CatalogStoragePlugin : Plugin() {
    private val databaseExecutor = Executors.newSingleThreadExecutor()
    private val networkExecutor = Executors.newSingleThreadExecutor()
    private val store: RoomCatalogStore by lazy { RoomCatalogStore(SamhainPosDatabase.getInstance(context)) }

    @PluginMethod
    fun getCatalogSnapshot(call: PluginCall) = execute(call) { store.snapshot() }

    @PluginMethod
    fun commitCatalogSnapshot(call: PluginCall) = execute(call) { store.commit(call.requiredObject("snapshot")) }

    // Network work cannot occupy the Room administration executor.
    @PluginMethod
    fun downloadCatalog(call: PluginCall) {
        networkExecutor.execute {
            try { call.resolve(JSObject(TabletAuthService.get(context).downloadCatalog().toString())) }
            catch (_: Exception) { call.reject("Catalogue distant inaccessible. Le catalogue local reste disponible.", "CATALOG_SYNC_ERROR") }
        }
    }

    @PluginMethod
    fun publishCatalog(call: PluginCall) {
        networkExecutor.execute {
            try {
                call.resolve(JSObject(TabletAuthService.get(context).publishCatalog(
                    call.getString("email") ?: error("Compte requis"), call.getString("password") ?: error("Compte requis"), call.requiredObject("body")
                ).toString()))
            } catch (_: Exception) { call.reject("Publication refusée ou révision dépassée. Rechargez la version publiée.", "CATALOG_PUBLISH_ERROR") }
        }
    }

    @PluginMethod
    fun initializeCatalog(call: PluginCall) = execute(call) { store.initialize(call.requiredArray("products")) }

    @PluginMethod
    fun getCatalogProducts(call: PluginCall) = execute(call) { store.getAll() }

    @PluginMethod
    fun getSellableCatalogProducts(call: PluginCall) = execute(call) { store.getSellable() }

    @PluginMethod
    fun createCatalogProduct(call: PluginCall) = execute(call) { store.create(call.requiredObject("product")) }

    @PluginMethod
    fun updateCatalogProduct(call: PluginCall) = execute(call) { store.update(call.requiredObject("product")) }

    @PluginMethod
    fun getCatalogCategories(call: PluginCall) = execute(call) { store.getCategories() }

    @PluginMethod
    fun createCatalogCategory(call: PluginCall) = execute(call) { store.createCategory(call.requiredObject("category")) }

    @PluginMethod
    fun updateCatalogCategory(call: PluginCall) = execute(call) {
        store.updateCategory(call.getString("id") ?: error("Identifiant requis."), call.getString("label") ?: error("Nom requis."))
    }

    @PluginMethod
    fun setCatalogCategoryActive(call: PluginCall) = execute(call) {
        store.setCategoryActive(call.getString("id") ?: error("Identifiant requis."), call.getBoolean("active") ?: error("Statut requis."))
    }

    @PluginMethod
    fun reorderCatalogCategories(call: PluginCall) = execute(call) { store.reorderCategories(call.requiredArray("ids")) }

    private fun execute(call: PluginCall, operation: () -> JSONObject) {
        databaseExecutor.execute {
            try {
                call.resolve(JSObject(operation().toString()))
            } catch (error: Exception) {
                call.reject(error.message ?: "Erreur de persistance du catalogue.", "CATALOG_PERSISTENCE_ERROR", error)
            }
        }
    }

    private fun PluginCall.requiredObject(name: String): JSONObject =
        getObject(name) ?: throw IllegalArgumentException("Le champ $name est requis.")

    private fun PluginCall.requiredArray(name: String): JSONArray =
        getArray(name) ?: throw IllegalArgumentException("Le champ $name est requis.")

    override fun handleOnDestroy() {
        databaseExecutor.shutdown()
        networkExecutor.shutdown()
        super.handleOnDestroy()
    }
}
