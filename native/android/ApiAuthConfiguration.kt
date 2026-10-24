package __APP_PACKAGE__

import android.content.Context
import java.net.URI
import org.json.JSONObject

internal data class ApiAuthConfiguration(val status: String, val origin: String? = null, val destinationId: String? = null) {
    companion object {
        fun load(context: Context): ApiAuthConfiguration = try {
            context.assets.open("public/samhain-build.json").bufferedReader().use { parse(it.readText()) }
        } catch (_: Exception) { ApiAuthConfiguration("invalid") }
        internal fun parse(text: String): ApiAuthConfiguration = try {
            val build = JSONObject(text)
            require(SyncProtocol.safeSequence(build.get("schemaVersion")) == 1L)
            val api = build.optJSONObject("apiAuth") ?: JSONObject().put("status", "not_configured")
            when (api.getString("status")) {
                "not_configured" -> ApiAuthConfiguration("not_configured")
                "configured" -> {
                    require(api.getString("environment") == if (build.getString("mode") == "production") "production" else "test")
                    val origin = api.getString("origin"); val parsed = URI(origin)
                    require(parsed.scheme == "https" && !parsed.host.isNullOrBlank() && parsed.rawUserInfo == null && parsed.rawQuery == null && parsed.rawFragment == null && parsed.rawPath.isNullOrBlank())
                    require(parsed.port == -1 || parsed.port in 1..65535)
                    val destination = api.getString("destinationId")
                    require(destination.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")))
                    ApiAuthConfiguration("configured",origin,destination)
                }
                else -> ApiAuthConfiguration("invalid")
            }
        } catch (_: Exception) { ApiAuthConfiguration("invalid") }
    }
}
