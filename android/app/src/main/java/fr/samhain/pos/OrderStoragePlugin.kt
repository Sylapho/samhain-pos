package fr.samhain.pos

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import org.json.JSONObject

@CapacitorPlugin(name = "OrderStorage")
class OrderStoragePlugin : Plugin() {
    private val databaseExecutor = Executors.newSingleThreadExecutor()

    private val store: RoomOrderStore by lazy {
        RoomOrderStore(SamhainPosDatabase.getInstance(context))
    }

    @PluginMethod
    fun getLegacyMigrationStatus(call: PluginCall) =
        execute(call) { store.legacyMigrationStatus() }

    @PluginMethod
    fun importLegacySnapshot(call: PluginCall) =
        execute(call) { store.importLegacySnapshot(call.requiredObject("snapshot")) }

    @PluginMethod
    fun createOrder(call: PluginCall) =
        execute(call) {
            store.createOrder(
                call.requiredObject("request"),
                call.requiredObject("source"),
            )
        }

    @PluginMethod
    fun createCheckoutIntent(call: PluginCall) =
        execute(call) { store.createCheckoutIntent(call.requiredObject("intent")) }

    @PluginMethod
    fun getCheckoutIntents(call: PluginCall) = execute(call) { store.checkoutIntents() }

    @PluginMethod
    fun markCheckoutPaymentToVerify(call: PluginCall) =
        execute(call) {
            store.markCheckoutPaymentToVerify(call.requiredString("id"), call.requiredString("updatedAt"))
        }

    @PluginMethod
    fun confirmCheckoutPayment(call: PluginCall) =
        execute(call) {
            store.confirmCheckoutPayment(call.requiredString("id"), call.requiredString("confirmedAt"))
        }

    @PluginMethod
    fun abandonCheckoutIntent(call: PluginCall) =
        execute(call) {
            store.abandonCheckoutIntent(call.requiredString("id"), call.requiredString("abandonedAt"))
        }

    @PluginMethod
    fun finalizeCheckoutIntent(call: PluginCall) =
        execute(call) {
            store.finalizeCheckoutIntent(call.requiredString("id"), call.requiredString("updatedAt"))
        }

    @PluginMethod
    fun getSnapshot(call: PluginCall) = execute(call) { store.snapshot() }

    @PluginMethod
    fun compareAndSetPrinting(call: PluginCall) =
        execute(call) {
            store.compareAndSetPrinting(
                call.getString("orderId")
                    ?: throw IllegalArgumentException("L’identifiant de commande est requis."),
                call.requiredObject("expected"),
                call.requiredObject("printing"),
            )
        }

    @PluginMethod
    fun recordCorrection(call: PluginCall) =
        execute(call) { store.recordCorrection(call.requiredObject("request")) }

    @PluginMethod
    fun closePeriod(call: PluginCall) =
        execute(call) { store.closePeriod(call.requiredObject("request")) }

    @PluginMethod
    fun restoreSnapshot(call: PluginCall) =
        execute(call) { store.restoreSnapshot(call.requiredObject("snapshot")) }

    private fun execute(call: PluginCall, operation: () -> JSONObject) {
        databaseExecutor.execute {
            try {
                call.resolve(JSObject(operation().toString()))
            } catch (error: Exception) {
                call.reject(
                    error.message ?: "Erreur de persistance Room/SQLite.",
                    "ROOM_PERSISTENCE_ERROR",
                    error,
                )
            }
        }
    }

    private fun PluginCall.requiredObject(name: String): JSONObject =
        getObject(name) ?: throw IllegalArgumentException("Le champ $name est requis.")

    private fun PluginCall.requiredString(name: String): String =
        getString(name)?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("Le champ $name est requis.")

    override fun handleOnDestroy() {
        databaseExecutor.shutdown()
        super.handleOnDestroy()
    }
}
