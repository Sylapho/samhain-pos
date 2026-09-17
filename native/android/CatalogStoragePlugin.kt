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
    private val store: RoomCatalogStore by lazy { RoomCatalogStore(SamhainPosDatabase.getInstance(context)) }

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
        super.handleOnDestroy()
    }
}
