package __APP_PACKAGE__

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ManagerPersistentSessionTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val config get() = JSONObject().put("issuer", "https://identity.example/realms/pos")
        .put("clientId", "pos-android").put("authorizationEndpoint", "https://identity.example/auth")
        .put("tokenEndpoint", "https://identity.example/token").put("redirectUri", "fr.samhain.pos:/oauth2redirect")
    private val now = 1000000L
    private fun vault(): CredentialVault {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        return TabletCredentialVault(context, { key }, "manager-test-${UUID.randomUUID()}")
    }
    private fun seed(vault: CredentialVault, expiry: Long = now - 1) {
        vault.write(JSONObject().put("schemaVersion", 1).put("config", config)
            .put("accessToken", "old-access").put("expiresAt", expiry).put("refreshToken", "old-refresh"))
    }
    private class Transport(val config: () -> JSONObject, val verify: (String?) -> JSONObject = { JSONObject().put("authenticated", true) }) : ApiAuthTransport {
        override fun get(path: String, token: String?): JSONObject = when(path) {
            "/api/v1/auth/oidc-config" -> config()
            "/api/v1/auth/manager" -> verify(token)
            else -> error("unexpected path")
        }
        override fun post(path: String, token: String?, body: JSONObject): JSONObject = error("unexpected POST")
        override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject = error("unexpected signature")
    }
    private fun session(vault: CredentialVault, refresh: ManagerTokenRefresher, transport: ApiAuthTransport = Transport({ config })) =
        ManagerOidcSession(context, transport, java.util.concurrent.Executor { it.run() }, vault, { now }, refresh)

    @Test fun encryptedSessionSurvivesPluginDestructionAndRefreshesOnNextUse() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val namespace = "manager-reopen-${UUID.randomUUID()}"
        val stored = TabletCredentialVault(context, { key }, namespace)
        seed(stored)
        val first = session(stored, ManagerTokenRefresher { _, _ -> error("status must not call the provider") })
        assertTrue(first.isAuthenticated())
        first.dispose()
        val reopened = TabletCredentialVault(context, { key }, namespace)
        val next = session(reopened, ManagerTokenRefresher { actual, refresh ->
            assertEquals(config.toString(), actual.toString())
            assertEquals("old-refresh", refresh)
            ManagerTokens("new-access", now + 300000, "rotated-refresh")
        }, Transport({ config }) { token ->
            assertEquals("new-access", token)
            assertEquals("rotated-refresh", reopened.read()!!.getString("refreshToken"))
            JSONObject().put("authenticated", true)
        })
        try {
            assertEquals("new-access", next.token())
            val files = context.noBackupFilesDir.listFiles()!!.filter { it.name.startsWith("tablet-auth-api-") }
            assertTrue(files.isNotEmpty())
            assertFalse(files.any { it.readBytes().toString(Charsets.UTF_8).contains("rotated-refresh") })
            next.logout()
            assertNull(reopened.read())
        } finally { next.dispose() }
    }

    @Test fun transientNetworkFailurePreservesRefreshTokenForRetry() {
        val stored = vault(); seed(stored)
        val calls = AtomicInteger()
        val manager = session(stored, ManagerTokenRefresher { _, _ ->
            if (calls.incrementAndGet() == 1) throw TabletAuthFailure("server_unreachable")
            ManagerTokens("new-access", now + 300000, null)
        })
        try {
            assertEquals("server_unreachable", assertThrows(TabletAuthFailure::class.java) { manager.token() }.code)
            assertTrue(manager.isAuthenticated())
            assertEquals("new-access", manager.token())
            assertEquals("old-refresh", stored.read()!!.getString("refreshToken"))
        } finally { manager.dispose(); stored.clear() }
    }

    @Test fun initialVerifiedLoginPersistsRefreshCredentialAndReturnsOnlyPublicStatus() {
        val stored = vault()
        val manager = session(stored, ManagerTokenRefresher { _, _ -> error("no refresh expected") })
        try {
            manager.verifyManager("new-access", now + 300000, manager.generation(),
                JSONObject().put("config", config).put("refreshToken", "initial-refresh")) { result ->
                assertEquals("{\"status\":\"authenticated\"}", result.toString())
            }
            assertEquals("initial-refresh", stored.read()!!.getString("refreshToken"))
            assertEquals("new-access", manager.token())
        } finally { manager.dispose(); stored.clear() }
    }

    @Test fun rotatedCredentialSurvivesNetworkFailureDuringApiVerification() {
        val stored = vault(); seed(stored)
        val manager = session(stored, ManagerTokenRefresher { _, _ -> ManagerTokens("new-access", now + 300000, "rotated-refresh") },
            Transport({ config }) { throw TabletAuthFailure("server_unreachable") })
        try {
            assertEquals("server_unreachable", assertThrows(TabletAuthFailure::class.java) { manager.token() }.code)
            assertEquals("rotated-refresh", stored.read()!!.getString("refreshToken"))
            assertTrue(manager.isAuthenticated())
        } finally { manager.dispose(); stored.clear() }
    }

    @Test fun apiRejectionClearsRenewedIdentity() {
        val stored = vault(); seed(stored)
        val manager = session(stored, ManagerTokenRefresher { _, _ -> ManagerTokens("new-access", now + 300000, "rotated-refresh") },
            Transport({ config }) { JSONObject().put("authenticated", false) })
        try {
            assertEquals("authorization_denied", assertThrows(TabletAuthFailure::class.java) { manager.token() }.code)
            assertFalse(manager.isAuthenticated())
        } finally { manager.dispose() }
    }

    @Test fun expiredOrRevokedProviderSessionRequiresLoginAgain() {
        val stored = vault(); seed(stored)
        val manager = session(stored, ManagerTokenRefresher { _, _ -> throw TabletAuthFailure("session_expired") })
        try {
            assertThrows(TabletAuthFailure::class.java) { manager.token() }
            assertFalse(manager.isAuthenticated())
            assertNull(stored.read())
        } finally { manager.dispose() }
    }

    @Test fun changedProviderNeverReceivesStoredRefreshToken() {
        val stored = vault(); seed(stored)
        val manager = session(stored, ManagerTokenRefresher { _, _ -> error("credential must not be sent") },
            Transport({ config.put("issuer", "https://other.example/realm") }))
        try {
            assertEquals("session_expired", assertThrows(TabletAuthFailure::class.java) { manager.token() }.code)
            assertNull(stored.read())
        } finally { manager.dispose() }
    }

    @Test fun concurrentPluginsRotateOnlyOnceAndLogoutClearsBoth() {
        val stored = vault(); seed(stored)
        val rotations = AtomicInteger()
        val refresh = ManagerTokenRefresher { _, _ ->
            rotations.incrementAndGet()
            ManagerTokens("new-access", now + 300000, "rotated-refresh")
        }
        val first = session(stored, refresh); val second = session(stored, refresh)
        val workers = Executors.newFixedThreadPool(2)
        try {
            val one = workers.submit<String> { first.token() }
            val two = workers.submit<String> { second.token() }
            assertEquals("new-access", one.get(5, TimeUnit.SECONDS))
            assertEquals("new-access", two.get(5, TimeUnit.SECONDS))
            assertEquals(1, rotations.get())
            first.logout()
            assertFalse(second.isAuthenticated())
            assertThrows(TabletAuthFailure::class.java) { second.token() }
        } finally { first.dispose(); second.dispose(); workers.shutdownNow() }
    }

    @Test fun logoutDuringRefreshPreventsLateResponseFromRestoringSession() {
        val stored = vault(); seed(stored)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val manager = session(stored, ManagerTokenRefresher { _, _ ->
            entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
            ManagerTokens("late-access", now + 300000, "late-refresh")
        })
        val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<Boolean> { try { manager.token(); false } catch (_: TabletAuthFailure) { true } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(manager.isAuthenticated())
            manager.logout(); release.countDown()
            assertTrue(result.get(5, TimeUnit.SECONDS))
            assertNull(stored.read())
        } finally { release.countDown(); manager.dispose(); worker.shutdownNow() }
    }

    @Test fun pluginDestructionDuringRefreshPreservesRotationForNextInstance() {
        val stored = vault(); seed(stored)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val manager = session(stored, ManagerTokenRefresher { _, _ ->
            entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
            ManagerTokens("next-access", now + 300000, "next-refresh")
        })
        val worker = Executors.newSingleThreadExecutor()
        try {
            val result = worker.submit<Boolean> { try { manager.token(); false } catch (_: TabletAuthFailure) { true } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            manager.dispose(); release.countDown()
            assertTrue(result.get(5, TimeUnit.SECONDS))
            assertEquals("next-refresh", stored.read()!!.getString("refreshToken"))
            val reopened = session(stored, ManagerTokenRefresher { _, _ -> error("fresh token should be reused") })
            try { assertEquals("next-access", reopened.token()) } finally { reopened.dispose() }
        } finally { release.countDown(); stored.clear(); worker.shutdownNow() }
    }
}
