package __APP_PACKAGE__

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.CodeVerifierUtil
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.AppAuthConfiguration
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/** Manager credentials stay in a separate Keystore-backed, non-backed-up vault. */
internal class ManagerOidcSession(
    context: Context,
    private val http: ApiAuthTransport,
    private val verificationExecutor: Executor,
    private val vault: CredentialVault = managerVault(context),
    private val now: () -> Long = { System.currentTimeMillis() },
    injectedRefresher: ManagerTokenRefresher? = null,
) {
    init { net.openid.appauth.internal.AppAuthLogPolicy.install() }
    private val service = AuthorizationService(context, AppAuthConfiguration.Builder().setConnectionBuilder(OidcConnectionBuilder).build())
    private var pending: AuthorizationRequest? = null
    private val refresher = injectedRefresher ?: AppAuthManagerTokenRefresher(service)
    private var loginConfig: JSONObject? = null
    private var pendingEpoch = 0L
    private var disposed = false
    @Synchronized fun begin(): Intent {
        val attemptEpoch = synchronized(STATE_LOCK) {
            if (disposed || pending != null) throw TabletAuthFailure("authorization_denied")
            epoch++; vault.clear(); epoch
        }
        val config = http.get("/api/v1/auth/oidc-config")
        validateConfig(config)
        Log.i("SamhainOidc", "stage=configuration_received")
        fun endpoint(name: String): Uri {
            val value = Uri.parse(config.getString(name))
            require(value.scheme == "https" && !value.host.isNullOrBlank() && value.userInfo == null && value.fragment == null)
            return value
        }
        val redirect = Uri.parse(config.getString("redirectUri"))
        require(redirect.toString() == "fr.samhain.witches:/oauth2redirect")
        val scopes = config.getJSONArray("scopes").let { values -> (0 until values.length()).map { values.getString(it) } }
        require("openid" in scopes)
        val request = AuthorizationRequest.Builder(
            AuthorizationServiceConfiguration(endpoint("authorizationEndpoint"), endpoint("tokenEndpoint")),
            config.getString("clientId"), ResponseTypeValues.CODE, redirect,
        ).setScopes(scopes).setCodeVerifier(CodeVerifierUtil.generateRandomCodeVerifier())
            .setNonce(java.util.UUID.randomUUID().toString()).build()
        synchronized(STATE_LOCK) {
            if (disposed || epoch != attemptEpoch) throw TabletAuthFailure("authorization_denied")
            pending = request; pendingEpoch = attemptEpoch; loginConfig = config
        }
        return service.getAuthorizationRequestIntent(request).also {
            Log.i("SamhainOidc", "stage=browser_intent_ready")
        }
    }
    fun complete(data: Intent?, done: (JSONObject) -> Unit) {
        val attempt = synchronized(STATE_LOCK) { Triple(pending, pendingEpoch, loginConfig).also { pending = null; loginConfig = null } }
        val original = attempt.first
        val cancelled = synchronized(STATE_LOCK) { disposed || epoch != attempt.second }
        val response = data?.let { AuthorizationResponse.fromIntent(it) }
        if (original == null || cancelled || response == null || response.state != original.state ||
            response.request.jsonSerializeString() != original.jsonSerializeString() || response.authorizationCode.isNullOrBlank()) {
            val reason = when {
                original == null -> "missing_request"
                cancelled -> "cancelled_request"
                response == null -> "missing_response"
                response.state != original.state -> "state_mismatch"
                response.request.jsonSerializeString() != original.jsonSerializeString() -> "request_mismatch"
                else -> "missing_code"
            }
            val error = data?.let { runCatching { AuthorizationException.fromIntent(it) }.getOrNull() }
            // Numeric SDK errors only: descriptions, intents and OAuth values can contain credentials.
            Log.w("SamhainOidc", "stage=callback_rejected reason=$reason sdkType=${error?.type} sdkCode=${error?.code}")
            done(JSONObject().put("status", "authorization_denied")); return
        }
        Log.i("SamhainOidc", "stage=token_exchange_started")
        service.performTokenRequest(response.createTokenExchangeRequest()) { tokens, error ->
            val token = tokens?.accessToken
            val expiry = tokens?.accessTokenExpirationTime
            if (error != null || token.isNullOrBlank() || expiry == null || expiry <= System.currentTimeMillis()) {
                Log.w("SamhainOidc", "stage=token_exchange_rejected sdkType=${error?.type} sdkCode=${error?.code}")
                done(JSONObject().put("status", "authorization_denied"))
            } else {
                val refresh = tokens.refreshToken
                val config = attempt.third
                if (refresh.isNullOrBlank() || config == null) {
                    done(JSONObject().put("status", "authorization_denied"))
                } else verifyManager(token, expiry, attempt.second,
                    JSONObject().put("config", config).put("refreshToken", refresh), done)
            }
        }
    }
    internal fun verifyManager(token: String, expiry: Long, attemptEpoch: Long, saved: JSONObject? = null, done: (JSONObject) -> Unit) {
        // AppAuth delivers token callbacks on the UI thread via AsyncTask.onPostExecute.
        // Use the owning plugin's network executor; never relax Android's network policy.
        try {
            verificationExecutor.execute {
                try {
                    if (synchronized(STATE_LOCK) { disposed || epoch != attemptEpoch } || expiry <= now()) {
                        done(JSONObject().put("status", "authorization_denied"))
                        return@execute
                    }
                    Log.i("SamhainOidc", "stage=manager_verification_started")
                    require(http.get("/api/v1/auth/manager", token).getBoolean("authenticated"))
                    val accepted = synchronized(STATE_LOCK) {
                        if(disposed || epoch != attemptEpoch || expiry <= now()) false
                        else {
                            vault.write((saved ?: JSONObject()).put("schemaVersion", 1)
                                .put("accessToken", token).put("expiresAt", expiry))
                            true
                        }
                    }
                    Log.i("SamhainOidc", "stage=manager_verification_finished accepted=$accepted")
                    done(JSONObject().put("status", if(accepted) "authenticated" else "authorization_denied"))
                } catch (_: Exception) {
                    Log.w("SamhainOidc", "stage=manager_verification_rejected")
                    done(JSONObject().put("status", "authorization_denied"))
                }
            }
        } catch (_: RejectedExecutionException) {
            done(JSONObject().put("status", "authorization_denied"))
        }
    }
    fun isAuthenticated(): Boolean = synchronized(STATE_LOCK) {
        // Local availability only; remote identity and grants are checked on each action.
        val stored = vault.read() ?: return@synchronized false
        stored.optLong("expiresAt") > now() || stored.optString("refreshToken").isNotBlank()
    }
    fun token(): String = synchronized(REFRESH_LOCK) {
        val attempt = synchronized(STATE_LOCK) {
            if (disposed) throw TabletAuthFailure("authorization_denied")
            Pair(vault.read() ?: throw TabletAuthFailure("authorization_denied"), epoch)
        }
        val stored = attempt.first
        if (stored.getLong("expiresAt") > now() + 60000) return@synchronized stored.getString("accessToken")
        if (stored.optString("refreshToken").isBlank()) throw TabletAuthFailure("session_expired")
        try {
            val config = http.get("/api/v1/auth/oidc-config")
            validateConfig(config)
            val previous = stored.getJSONObject("config")
            if (listOf("issuer", "clientId", "authorizationEndpoint", "tokenEndpoint", "redirectUri")
                .any { config.getString(it) != previous.getString(it) }) throw TabletAuthFailure("session_expired")
            val tokens = refresher.refresh(config, stored.getString("refreshToken"))
            require(tokens.accessToken.isNotBlank() && tokens.expiresAt > now())
            synchronized(STATE_LOCK) {
                if (epoch != attempt.second) throw TabletAuthFailure("authorization_denied")
                // Persist a rotated refresh token before any subsequent network operation.
                stored.put("accessToken", tokens.accessToken).put("expiresAt", tokens.expiresAt)
                tokens.refreshToken?.takeIf { it.isNotBlank() }?.let { stored.put("refreshToken", it) }
                vault.write(stored)
            }
            if (!http.get("/api/v1/auth/manager", tokens.accessToken).getBoolean("authenticated"))
                throw TabletAuthFailure("authorization_denied")
            synchronized(STATE_LOCK) {
                if (disposed || epoch != attempt.second) throw TabletAuthFailure("authorization_denied")
            }
            tokens.accessToken
        } catch (error: TabletAuthFailure) {
            if (error.code in setOf("session_expired", "authorization_denied", "revoked")) synchronized(STATE_LOCK) {
                if (!disposed && epoch == attempt.second) { epoch++; vault.clear() }
            }
            throw error
        }
    }
    fun logout() = synchronized(STATE_LOCK) { epoch++; vault.clear() }
    internal fun generation(): Long = synchronized(STATE_LOCK) { epoch }
    fun cancel() = synchronized(STATE_LOCK) { pending = null; loginConfig = null; logout() }
    fun dispose() { synchronized(STATE_LOCK) { disposed = true; pending = null }; service.dispose() }

    companion object {
        private val STATE_LOCK = Any()
        private val REFRESH_LOCK = Any()
        private var epoch = 0L
        private fun managerVault(context: Context): CredentialVault {
            val config = ApiAuthConfiguration.load(context)
            require(config.status == "configured")
            return TabletCredentialVault(context, destination = "manager-oidc-v1:${config.origin}:${config.destinationId}")
        }
        private fun validateConfig(config: JSONObject) {
            for (name in listOf("issuer", "authorizationEndpoint", "tokenEndpoint")) {
                val uri = Uri.parse(config.getString(name))
                require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null)
            }
            require(config.getString("clientId").isNotBlank())
            require(config.getString("redirectUri") == "fr.samhain.witches:/oauth2redirect")
        }
    }
}
