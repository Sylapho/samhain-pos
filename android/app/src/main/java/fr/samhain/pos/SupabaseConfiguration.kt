package fr.samhain.pos

import android.content.Context
import org.json.JSONObject
import java.net.URI

/** Public build configuration only. Auth/session storage belongs to #114, never to this asset. */
data class SupabaseConfiguration(
    val status: String,
    val environment: String? = null,
    val url: String? = null,
    val publishableKey: String? = null,
) {
    companion object {
        fun load(context: Context): SupabaseConfiguration = try {
            context.assets.open("public/samhain-build.json").bufferedReader().use { parse(it.readText()) }
        } catch (_: Exception) {
            SupabaseConfiguration("invalid")
        }

        internal fun parse(json: String): SupabaseConfiguration = try {
            val build = JSONObject(json)
            require(build.getInt("schemaVersion") == 1)
            val config = build.getJSONObject("supabase")
            when (config.getString("status")) {
                "not_configured" -> SupabaseConfiguration("not_configured")
                "configured" -> {
                    val environment = config.getString("environment")
                    require(environment == if (build.getString("mode") == "production") "production" else "test")
                    val url = config.getString("url")
                    val uri = URI(url)
                    require(uri.scheme == "https" && !uri.host.isNullOrEmpty())
                    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
                    require(uri.rawPath.isNullOrEmpty())
                    val key = config.getString("publishableKey")
                    require(Regex("^sb_publishable_[A-Za-z0-9_-]+$").matches(key))
                    SupabaseConfiguration("configured", environment, url, key)
                }
                else -> SupabaseConfiguration("invalid")
            }
        } catch (_: Exception) {
            // No raw configuration, URL, credential or parser exception in logs.
            SupabaseConfiguration("invalid")
        }
    }
}
