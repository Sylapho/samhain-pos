package __APP_PACKAGE__

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.KeyGenerator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ApiTabletAuthServiceTest {
    private class Vault : CredentialVault {
        var data: String? = null
        override fun read() = data?.let { JSONObject(it) }
        override fun write(value: JSONObject) { data = value.toString() }
        override fun clear() { data = null }
    }
    private val config = ApiAuthConfiguration("configured", "https://api.example.invalid", "11111111-1111-4111-8111-111111111111")
    private val signer = object : InstallationSigner {
        override fun publicKey() = "test-public"
        override fun sign(message: ByteArray) = "test-proof"
    }
    private fun session(expiry: Long = 1000, refresh: String = "api-refresh") = JSONObject().put("access_token", "api-access").put("refresh_token", refresh).put("expires_at", expiry).put("token_type", "bearer")
    private fun service(vault: Vault, http: ApiAuthTransport, previous: CredentialVault = Vault(), signer: InstallationSigner = this.signer, now: () -> Long = { 10 }) =
        ApiTabletAuthService(config, vault, previous, signer, http, {
            JSONObject().put("chainId", "chain").put("terminalId", it).put("restored", false).put("prefix", JSONArray()).put("legacyOrderIds", JSONArray())
        }, {}, now)
    private fun transport(vault: Vault, rotations: AtomicInteger = AtomicInteger()) = object : ApiAuthTransport {
        override fun get(path: String, token: String?) = JSONObject().put("protocolVersion", 1).put("destinationId", config.destinationId)
        override fun post(path: String, token: String?, body: JSONObject) = JSONObject().put("nonce", "test-nonce")
        override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject {
            assertEquals("test-proof", signature)
            return when {
                path.endsWith("/refresh") -> {
                    assertTrue(vault.read()!!.has("rotationPayload"))
                    assertTrue(vault.read()!!.has("rotationStartedAt"))
                    rotations.incrementAndGet(); session(3000, "api-rotated")
                }
                path.endsWith("/activate") -> JSONObject().put("status", "authorized").put("installationId", vault.read()!!.getString("installationId")).put("chainId", "chain").put("session", session())
                path.endsWith("/status") -> JSONObject().put("status", "authorized")
                else -> JSONObject().put("status", "pending").put("requestId", "request")
            }
        }
    }
    @Test fun migratesIdentityAndKeyWithoutCopyingSupabaseTokensOrMutatingPreviousVault() {
        val previous = Vault(); previous.write(JSONObject().put("installationId", "existing-installation").put("session", JSONObject().put("access_token", "old-supabase-secret")))
        val before = previous.data; val vault = Vault()
        val result = service(vault, transport(vault), previous).requestEnrollment("terminal")
        assertEquals("pending", result.getString("status"))
        assertEquals("existing-installation", result.getString("installationId"))
        assertEquals(before, previous.data)
        assertFalse(vault.data!!.contains("old-supabase-secret"))
        assertFalse(result.toString().contains("test-public"))
    }
    @Test fun missingExistingKeyFailsBeforePublicKeyGeneration() {
        val previous = Vault(); previous.write(JSONObject().put("installationId", "existing"))
        val broken = object : InstallationSigner {
            override fun publicKey(): String = error("must not generate")
            override fun sign(message: ByteArray): String = throw IllegalStateException("lost key")
        }
        val vault = Vault()
        assertEquals("needs_recovery", service(vault, transport(vault), previous, broken).requestEnrollment("terminal").getString("status"))
        assertNull(vault.data)
    }
    @Test fun changingApiDestinationKeepsIdentityFromItsSeparateEncryptedIdentityRecord() {
        val identity = Vault(); identity.write(JSONObject().put("installationId", "existing-api-installation").put("publicKey", "test-public"))
        val vault = Vault(); var bound = false
        val auth = ApiTabletAuthService(config, vault, Vault(), signer, transport(vault), {
            JSONObject().put("chainId", "existing-chain").put("terminalId", it).put("restored", false).put("prefix", JSONArray()).put("legacyOrderIds", JSONArray())
        }, { bound = true }, identityVault = identity)
        val result = auth.requestEnrollment("terminal")
        assertEquals("existing-api-installation", result.getString("installationId"))
        assertEquals("pending", result.getString("status"))
        assertFalse(bound)
        assertEquals("existing-chain", JSONObject(vault.read()!!.getString("enrollmentPayload")).getJSONObject("dossier").getString("chainId"))
    }
    @Test fun refreshSerializesAcrossNativeInstancesAndPersistsBeforeUse() {
        val vault = Vault(); val rotations = AtomicInteger(); val http = transport(vault, rotations)
        val auth = service(vault, http); auth.requestEnrollment("terminal"); auth.activate("test-invitation")
        val pool = Executors.newFixedThreadPool(4)
        try {
            val results = pool.invokeAll((1..4).map { Callable { service(vault, http, now = { 990 }).status(true) } })
            assertTrue(results.all { it.get().getString("status") == "authorized" })
            assertEquals(1, rotations.get())
            assertEquals("api-rotated", vault.read()!!.getJSONObject("session").getString("refresh_token"))
            assertFalse(results.any { it.get().toString().contains("api-access") })
        } finally { pool.shutdownNow() }
    }
    @Test fun lostRefreshResponseRetriesExactBytesOnceBoundedAndDoesNotEraseCredentials() {
        val vault = Vault(); val normal = transport(vault); val auth = service(vault, normal)
        auth.requestEnrollment("terminal"); auth.activate("test-invitation")
        var sent: String? = null
        val lost = object : ApiAuthTransport by normal {
            override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject {
                sent = raw; throw TabletAuthFailure("server_unreachable")
            }
        }
        assertEquals("server_unreachable", service(vault, lost, now = { 990 }).status(true).getString("status"))
        val pending = vault.read()!!.getString("rotationPayload")
        assertEquals(sent, pending)
        assertTrue(vault.read()!!.has("session"))
        assertEquals("session_expired", service(vault, lost, now = { 1051 }).status(true).getString("status"))
        assertEquals(pending, vault.read()!!.getString("rotationPayload"))
        assertEquals("authorized", service(vault, normal, now = { 1000 }).status(true).getString("status"))
    }
    @Test fun destinationVaultsSurviveRestartAndNeverOverwriteLegacyCredentials() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val legacy = TabletCredentialVault(context, { key })
        val first = TabletCredentialVault(context, { key }, "destination-one")
        val other = TabletCredentialVault(context, { key }, "destination-two")
        try {
            legacy.write(JSONObject().put("schemaVersion", 1).put("value", "legacy"))
            first.write(JSONObject().put("schemaVersion", 1).put("value", "api"))
            other.clear()
            assertNull(other.read())
            assertEquals("api", TabletCredentialVault(context, { key }, "destination-one").read()!!.getString("value"))
            assertEquals("legacy", legacy.read()!!.getString("value"))
        } finally { legacy.clear(); first.clear(); other.clear() }
    }
    @Test fun configurationRejectsHttpAndIncorrectDestination() {
        assertEquals("not_configured", ApiAuthConfiguration.parse("""{"schemaVersion":1,"mode":"test"}""").status)
        assertEquals("invalid", ApiAuthConfiguration.parse("""{"schemaVersion":1,"mode":"test","apiAuth":{"status":"configured","environment":"test","origin":"http://api.invalid","destinationId":"bad"}}""").status)
    }
}
