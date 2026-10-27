package __APP_PACKAGE__

import android.net.Uri
import android.os.Looper
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.GrantTypeValues
import net.openid.appauth.TokenRequest
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

internal data class ManagerTokens(val accessToken: String, val expiresAt: Long, val refreshToken: String?)

internal fun interface ManagerTokenRefresher {
    fun refresh(config: JSONObject, refreshToken: String): ManagerTokens
}

/** Called on a plugin worker; AppAuth delivers its result on the main thread. */
internal class AppAuthManagerTokenRefresher(private val service: AuthorizationService) : ManagerTokenRefresher {
    override fun refresh(config: JSONObject, refreshToken: String): ManagerTokens {
        check(Looper.myLooper() != Looper.getMainLooper())
        val result = AtomicReference<ManagerTokens>()
        val failure = AtomicReference<AuthorizationException>()
        val done = CountDownLatch(1)
        val request = TokenRequest.Builder(
            AuthorizationServiceConfiguration(Uri.parse(config.getString("authorizationEndpoint")), Uri.parse(config.getString("tokenEndpoint"))),
            config.getString("clientId"),
        ).setGrantType(GrantTypeValues.REFRESH_TOKEN).setRefreshToken(refreshToken).build()
        service.performTokenRequest(request) { tokens, error ->
            if (tokens?.accessToken != null && tokens.accessTokenExpirationTime != null)
                result.set(ManagerTokens(tokens.accessToken!!, tokens.accessTokenExpirationTime!!, tokens.refreshToken))
            failure.set(error)
            done.countDown()
        }
        if (!done.await(35, TimeUnit.SECONDS)) throw TabletAuthFailure("server_unreachable")
        // A network error must not erase a still usable refresh credential.
        if (failure.get()?.error == "invalid_grant") throw TabletAuthFailure("session_expired")
        return result.get() ?: throw TabletAuthFailure("server_unreachable")
    }
}
