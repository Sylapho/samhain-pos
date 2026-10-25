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
    @Test fun catalogDownloadUsesApiProofAndRejectsCorruptionForeignScopeAndDisconnect() {
        val vault = Vault()
        val binding = JSONObject().put("organizationId","org").put("festivalId","festival").put("chainId","chain").put("enrollmentGeneration",1)
        vault.write(JSONObject().put("installationId","installation").put("publicKey","test-public").put("status","authorized").put("binding",binding).put("session",session()))
        val payload = JSONObject().put("organizationId","org").put("festivalId","festival").put("schemaVersion",1).put("revision",1).put("name","é / test").toString()
        var result = JSONObject().put("organizationId","org").put("festivalId","festival").put("version",JSONObject().put("payload",payload).put("sha256",SyncProtocol.sha(payload)))
        var disconnected = false
        val http = object : ApiAuthTransport {
            override fun get(path:String, token:String?) = error("unexpected GET")
            override fun post(path:String, token:String?, body:JSONObject):JSONObject {
                assertEquals("/api/v1/auth/challenges",path)
                assertEquals("catalog-v1",body.getString("action"))
                return JSONObject().put("nonce","nonce")
            }
            override fun signed(path:String, token:String?, raw:String, nonce:String, signature:String):JSONObject {
                assertEquals("/api/v1/catalog/active",path); assertEquals("api-access",token)
                assertEquals("installation",JSONObject(raw).getString("installationId"))
                if(disconnected) throw TabletAuthFailure("server_unreachable")
                return result
            }
        }
        val auth = service(vault,http)
        assertEquals(payload,auth.downloadCatalog().getJSONObject("version").getString("payload"))
        result.getJSONObject("version").put("sha256","bad")
        assertThrows(Exception::class.java) { auth.downloadCatalog() }
        result.getJSONObject("version").put("sha256",SyncProtocol.sha(payload)); result.put("festivalId","foreign")
        assertThrows(Exception::class.java) { auth.downloadCatalog() }
        disconnected = true
        assertThrows(TabletAuthFailure::class.java) { auth.downloadCatalog() }
        assertEquals("authorized",auth.status().getString("status"))
        result = JSONObject().put("organizationId","org").put("festivalId","festival").put("version",JSONObject.NULL)
        disconnected = false
        assertTrue(auth.downloadCatalog().isNull("version"))
    }
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

    @Test fun configurationChecksTestProductionOriginAndMissingValues() {
        for (mode in listOf("android-test","production")) {
            val environment = if (mode == "production") "production" else "test"
            val api = JSONObject().put("status","configured").put("environment",environment)
                .put("origin",config.origin).put("destinationId",config.destinationId)
            val build = JSONObject().put("schemaVersion",1).put("mode",mode).put("apiAuth",api)
            assertEquals("configured",ApiAuthConfiguration.parse(build.toString()).status)
            api.put("environment",if(environment == "test") "production" else "test")
            assertEquals("invalid",ApiAuthConfiguration.parse(build.toString()).status)
            api.put("environment",environment)
            for (origin in listOf("http://api.invalid","https://api.invalid:70000","https://user:pass@api.invalid","https://api.invalid/path","https://api.invalid?query=1","https://api.invalid#fragment")) {
                api.put("origin",origin)
                assertEquals("invalid",ApiAuthConfiguration.parse(build.toString()).status)
            }
        }
    }

    @Test fun financial401RotatesOnceAndNeverRetriesARevokedOrUnrefreshableSession() {
        val vault = Vault()
        val binding = JSONObject().put("organizationId","org").put("festivalId","festival")
            .put("chainId","chain").put("enrollmentGeneration",1)
        vault.write(JSONObject().put("installationId","installation").put("publicKey","test-public")
            .put("status","authorized").put("binding",binding).put("session",session()))
        val body = JSONObject(binding.toString()).put("installationId","installation")
        var uploads = 0
        var rotations = 0
        val http = object : ApiAuthTransport {
            override fun get(path: String, token: String?) = error("unexpected GET")
            override fun post(path: String, token: String?, body: JSONObject) = JSONObject().put("nonce","nonce")
            override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject {
                if (path.endsWith("/refresh")) { rotations++; return session(2000,"rotated") }
                uploads++
                if (uploads == 1) throw TabletAuthFailure("session_expired")
                return JSONObject().put("committed",true)
            }
        }
        assertTrue(service(vault,http).sendSync(ProtectedSyncEndpoint.LEDGER,body).getBoolean("committed"))
        assertEquals(1,rotations); assertEquals(2,uploads)
        assertEquals("rotated",vault.read()!!.getJSONObject("session").getString("refresh_token"))
        assertEquals("authorized",service(vault,http).status().getString("status"))
        val refused = object : ApiAuthTransport by http {
            override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject = throw TabletAuthFailure("session_expired")
        }
        assertThrows(TabletAuthFailure::class.java) { service(vault,refused).sendSync(ProtectedSyncEndpoint.LEDGER,body) }
        assertEquals("session_expired",vault.read()!!.getString("status"))
    }

    @Test fun financialTransportUsesApiCredentialsExactBodyProofAndNativeScope() {
        val vault = Vault()
        val binding = JSONObject().put("organizationId","org").put("festivalId","festival")
            .put("chainId","chain").put("enrollmentGeneration",1)
        vault.write(JSONObject().put("installationId","installation").put("publicKey","test-public")
            .put("status","authorized").put("binding",binding).put("session",session()))
        val body = JSONObject(binding.toString()).put("installationId","installation")
            .put("protocolVersion",1).put("requestId","request").put("events",JSONArray())
        var signedMessage = ""
        var sends = 0
        val proofSigner = object : InstallationSigner {
            override fun publicKey() = "test-public"
            override fun sign(message: ByteArray): String { signedMessage = message.toString(Charsets.UTF_8); return "proof" }
        }
        val http = object : ApiAuthTransport {
            override fun get(path: String, token: String?) = error("unexpected GET")
            override fun post(path: String, token: String?, body: JSONObject): JSONObject {
                assertEquals("/api/v1/auth/challenges",path)
                assertEquals("ledger-ingest-v1",body.getString("action"))
                assertEquals("installation",body.getString("installationId"))
                assertNull(token)
                return JSONObject().put("nonce","nonce")
            }
            override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject {
                sends++
                assertEquals("/api/v1/ledger/ingest",path); assertEquals("api-access",token)
                assertEquals(body.toString(),raw); assertEquals("nonce",nonce); assertEquals("proof",signature)
                assertEquals("samhain-auth/1\ninstallation\nledger-ingest-v1\nnonce\n${SyncProtocol.sha(raw)}",signedMessage)
                return JSONObject().put("committed",true)
            }
        }
        val auth = service(vault,http,signer = proofSigner)
        assertTrue(auth.sendSync(ProtectedSyncEndpoint.LEDGER,body).getBoolean("committed"))
        assertThrows(Exception::class.java) { auth.sendSync(ProtectedSyncEndpoint.LEDGER,JSONObject(body.toString()).put("festivalId","foreign")) }
        assertEquals(1,sends)
        val revoked = object : ApiAuthTransport by http {
            override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject = throw TabletAuthFailure("revoked")
        }
        assertThrows(TabletAuthFailure::class.java) { service(vault,revoked).sendSync(ProtectedSyncEndpoint.LEDGER,body) }
        assertEquals("revoked",vault.read()!!.getString("status"))
        assertThrows(TabletAuthFailure::class.java) { auth.sendSync(ProtectedSyncEndpoint.LEDGER,body) }
        assertEquals(1,sends)
    }
}
