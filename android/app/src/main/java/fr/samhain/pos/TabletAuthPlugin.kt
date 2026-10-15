package fr.samhain.pos

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import org.json.JSONObject

@CapacitorPlugin(name = "TabletAuth")
class TabletAuthPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val auth by lazy { TabletAuthService.get(context) }
    @PluginMethod fun getStatus(call: PluginCall) = execute(call) { auth.status(call.getBoolean("verify",false) ?: false) }
    @PluginMethod fun requestEnrollment(call: PluginCall) = execute(call) {
        auth.requestEnrollment(call.getString("terminalId") ?: error("missing"),call.getBoolean("reconnect",false) ?: false)
    }
    @PluginMethod fun activate(call: PluginCall) = execute(call) { auth.activate(call.getString("invitationCode") ?: error("missing")) }
    @PluginMethod fun managerOperation(call: PluginCall) = execute(call) {
        auth.managerOperation(call.getString("action") ?: error("missing"),call.getString("email") ?: error("missing"),
            call.getString("password") ?: error("missing"),call.getObject("body") ?: error("missing"))
    }
    @PluginMethod fun prepareReplacement(call: PluginCall) = execute(call) {
        TabletAuthService.prepareReplacement(context)
    }
    private fun execute(call: PluginCall, operation: () -> JSONObject) {
        executor.execute {
            try { call.resolve(JSObject(operation().toString())); OutboxScheduler.schedule(context) }
            catch (error: TabletAuthFailure) { call.resolve(JSObject(TabletAuthService.state(error.code).toString())) }
            catch (_: Exception) { call.reject("Vérification native impossible. Les données locales sont conservées.","TABLET_AUTH_RECOVERY_REQUIRED") }
        }
    }
    override fun handleOnDestroy() { executor.shutdown(); super.handleOnDestroy() }
}
