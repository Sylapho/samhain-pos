package fr.samhain.pos

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.ActivityCallback
import androidx.activity.result.ActivityResult
import java.util.concurrent.Executors
import org.json.JSONObject

@CapacitorPlugin(name = "TabletAuth")
class TabletAuthPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val auth by lazy { ApiTabletAuthService.get(context) }
    private val manager by lazy { ManagerOidcSession(context, ApiAuthHttp(ApiAuthConfiguration.load(context)), executor) }
    @PluginMethod fun getStatus(call: PluginCall) = execute(call) { auth.status(call.getBoolean("verify",false) ?: false) }
    @PluginMethod fun requestEnrollment(call: PluginCall) = execute(call) {
        auth.requestEnrollment(call.getString("terminalId") ?: error("missing"),call.getString("organizationId") ?: error("missing"),call.getString("festivalId") ?: error("missing"),call.getBoolean("reconnect",false) ?: false)
    }
    @PluginMethod fun activate(call: PluginCall) = execute(call) { auth.activate(call.getString("invitationCode") ?: error("missing")) }
    @PluginMethod fun managerOperation(call: PluginCall) = execute(call) {
        auth.managerOperation(call.getString("action") ?: error("missing"),call.getObject("body") ?: error("missing"),manager.token())
    }
    @PluginMethod fun managerLogin(call: PluginCall) {
        Log.i("SamhainOidc", "stage=login_requested")
        executor.execute {
            try {
                val intent = manager.begin()
                activity.runOnUiThread {
                    try {
                        startActivityForResult(call, intent, "managerResult")
                        Log.i("SamhainOidc", "stage=browser_activity_started")
                    }
                    catch (_: Exception) {
                        Log.w("SamhainOidc", "stage=browser_activity_failed")
                        manager.cancel(); call.resolve(JSObject().put("status", "authorization_denied"))
                    }
                }
            } catch (error: TabletAuthFailure) {
                Log.w("SamhainOidc", "stage=login_setup_failed kind=api")
                call.resolve(JSObject().put("status", error.code))
            }
            catch (_: Exception) {
                Log.w("SamhainOidc", "stage=login_setup_failed kind=native")
                call.resolve(JSObject().put("status", "authorization_denied"))
            }
        }
    }
    @ActivityCallback private fun managerResult(call: PluginCall?, result: ActivityResult) {
        Log.i("SamhainOidc", "stage=activity_result resultCode=${result.resultCode} callPresent=${call != null}")
        if (call == null) { manager.cancel(); return }
        manager.complete(result.data) { value -> call.resolve(JSObject(value.toString())) }
    }
    @PluginMethod fun managerStatus(call: PluginCall) = execute(call) {
        JSONObject().put("authenticated", manager.isAuthenticated())
    }
    @PluginMethod fun managerLogout(call: PluginCall) { manager.logout(); call.resolve() }
    @PluginMethod fun inspectEnrollment(call: PluginCall) = execute(call) {
        fun id(name: String): String {
            val value = call.getString(name) ?: error("missing")
            require(value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")))
            return value
        }
        val requestId = id("requestId")
        val result = ApiAuthHttp(ApiAuthConfiguration.load(context)).get(
            "/api/v1/tablet-enrollments/$requestId?organizationId=${id("organizationId")}&festivalId=${id("festivalId")}", manager.token())
        val dossier = result.getJSONObject("dossier")
        JSONObject().put("requestId", requestId).put("installationId", result.getString("installationId"))
            .put("chainId", dossier.getString("chainId")).put("terminalId", dossier.getString("terminalId"))
            .put("restored", dossier.getBoolean("restored")).put("prefixCount", dossier.getJSONArray("prefix").length())
            .put("legacyCount", dossier.getJSONArray("legacyOrderIds").length())
    }
    @PluginMethod fun prepareReplacement(call: PluginCall) = execute(call) {
        TabletAuthService.prepareReplacement(context)
    }
    private fun execute(call: PluginCall, operation: () -> JSONObject) {
        executor.execute {
            try { call.resolve(JSObject(operation().toString())) }
            catch (error: TabletAuthFailure) { call.resolve(JSObject(TabletAuthService.state(error.code).toString())) }
            catch (_: Exception) { call.reject("Vérification native impossible. Les données locales sont conservées.","TABLET_AUTH_RECOVERY_REQUIRED") }
        }
    }
    override fun handleOnDestroy() { manager.dispose(); executor.shutdown(); super.handleOnDestroy() }
}
