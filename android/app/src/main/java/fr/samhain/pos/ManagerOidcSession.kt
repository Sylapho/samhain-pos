package fr.samhain.pos

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

/** Ephemeral manager credentials. Neither tokens nor browser responses cross the bridge. */
internal class ManagerOidcSession(
    context: Context,
    private val http: ApiAuthTransport,
    private val verificationExecutor: Executor,
) {
    init { net.openid.appauth.internal.AppAuthLogPolicy.install() }
    private val service = AuthorizationService(context, AppAuthConfiguration.Builder().setConnectionBuilder(OidcConnectionBuilder).build())
    private var pending: AuthorizationRequest? = null
    private var credential: String? = null
    private var expiresAt = 0L
    private var epoch = 0L
    @Synchronized fun begin(): Intent {
        if (pending != null) throw TabletAuthFailure("authorization_denied")
        logout()
        val config = http.get("/api/v1/auth/oidc-config")
        Log.i("SamhainOidc", "stage=configuration_received")
        fun endpoint(name: String): Uri {
            val value = Uri.parse(config.getString(name))
            require(value.scheme == "https" && !value.host.isNullOrBlank() && value.userInfo == null && value.fragment == null)
            return value
        }
        val redirect = Uri.parse(config.getString("redirectUri"))
        require(redirect.toString() == "fr.samhain.pos:/oauth2redirect")
        val scopes = config.getJSONArray("scopes").let { values -> (0 until values.length()).map { values.getString(it) } }
        require("openid" in scopes)
        val request = AuthorizationRequest.Builder(
            AuthorizationServiceConfiguration(endpoint("authorizationEndpoint"), endpoint("tokenEndpoint")),
            config.getString("clientId"), ResponseTypeValues.CODE, redirect,
        ).setScopes(scopes).setCodeVerifier(CodeVerifierUtil.generateRandomCodeVerifier())
            .setNonce(java.util.UUID.randomUUID().toString()).build()
        pending = request
        return service.getAuthorizationRequestIntent(request).also {
            Log.i("SamhainOidc", "stage=browser_intent_ready")
        }
    }
    fun complete(data: Intent?, done: (JSONObject) -> Unit) {
        val attempt = synchronized(this) { Pair(pending, epoch).also { pending = null } }
        val original = attempt.first
        val response = data?.let { AuthorizationResponse.fromIntent(it) }
        if (original == null || response == null || response.state != original.state ||
            response.request.jsonSerializeString() != original.jsonSerializeString() || response.authorizationCode.isNullOrBlank()) {
            val reason = when {
                original == null -> "missing_request"
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
                verifyManager(token, expiry, attempt.second, done)
            }
        }
    }
    internal fun verifyManager(token: String, expiry: Long, attemptEpoch: Long, done: (JSONObject) -> Unit) {
        // AppAuth delivers token callbacks on the UI thread via AsyncTask.onPostExecute.
        // Use the owning plugin's network executor; never relax Android's network policy.
        try {
            verificationExecutor.execute {
                try {
                    if (synchronized(this) { epoch != attemptEpoch } || expiry <= System.currentTimeMillis()) {
                        done(JSONObject().put("status", "authorization_denied"))
                        return@execute
                    }
                    Log.i("SamhainOidc", "stage=manager_verification_started")
                    require(http.get("/api/v1/auth/manager", token).getBoolean("authenticated"))
                    val accepted = synchronized(this) {
                        if(epoch != attemptEpoch || expiry <= System.currentTimeMillis()) false
                        else { credential = token; expiresAt = expiry; true }
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
    @Synchronized fun isAuthenticated(): Boolean {
        if (credential != null && expiresAt <= System.currentTimeMillis()) logout()
        return credential != null
    }
    @Synchronized fun token(): String {
        if (expiresAt <= System.currentTimeMillis()) logout()
        return credential ?: throw TabletAuthFailure("authorization_denied")
    }
    @Synchronized fun logout() { epoch++; credential = null; expiresAt = 0 }
    @Synchronized fun cancel() { pending = null; logout() }
    fun dispose() { synchronized(this) { pending = null; logout() }; service.dispose() }
}
