package __APP_PACKAGE__

import android.content.Context
import android.content.Intent
import android.net.Uri
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.CodeVerifierUtil
import net.openid.appauth.ResponseTypeValues
import net.openid.appauth.AppAuthConfiguration
import org.json.JSONObject

/** Ephemeral manager credentials. Neither tokens nor browser responses cross the bridge. */
internal class ManagerOidcSession(context: Context, private val http: ApiAuthTransport) {
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
        return service.getAuthorizationRequestIntent(request)
    }
    fun complete(data: Intent?, done: (JSONObject) -> Unit) {
        val attempt = synchronized(this) { Pair(pending, epoch).also { pending = null } }
        val original = attempt.first
        val response = data?.let { AuthorizationResponse.fromIntent(it) }
        if (original == null || response == null || response.state != original.state ||
            response.request.jsonSerializeString() != original.jsonSerializeString() || response.authorizationCode.isNullOrBlank()) {
            done(JSONObject().put("status", "authorization_denied")); return
        }
        service.performTokenRequest(response.createTokenExchangeRequest()) { tokens, error ->
            val token = tokens?.accessToken
            val expiry = tokens?.accessTokenExpirationTime
            if (error != null || token.isNullOrBlank() || expiry == null || expiry <= System.currentTimeMillis()) {
                done(JSONObject().put("status", "authorization_denied"))
            } else {
                // AppAuth callback is a background task; API independently validates iss/aud/signature/time.
                try {
                    require(http.get("/api/v1/auth/manager", token).getBoolean("authenticated"))
                    val accepted = synchronized(this) {
                        if(epoch != attempt.second) false else { credential = token; expiresAt = expiry; true }
                    }
                    done(JSONObject().put("status", if(accepted) "authenticated" else "authorization_denied"))
                } catch (_: Exception) { done(JSONObject().put("status", "authorization_denied")) }
            }
        }
    }
    @Synchronized fun token(): String {
        if (expiresAt <= System.currentTimeMillis()) logout()
        return credential ?: throw TabletAuthFailure("authorization_denied")
    }
    @Synchronized fun logout() { epoch++; credential = null; expiresAt = 0 }
    @Synchronized fun cancel() { pending = null; logout() }
    fun dispose() { synchronized(this) { pending = null; logout() }; service.dispose() }
}
