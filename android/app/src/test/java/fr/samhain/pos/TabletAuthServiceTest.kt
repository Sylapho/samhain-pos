package fr.samhain.pos

import javax.crypto.KeyGenerator
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.CapConfig
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TabletAuthServiceTest {
    private class MemoryVault : CredentialVault {
        var data: String? = null
        override fun read(): JSONObject? = data?.let { JSONObject(it) }
        override fun write(value: JSONObject) { data = value.toString() }
        override fun clear() { data = null }
    }
    private val signer = object : InstallationSigner {
        override fun publicKey() = "public-test-key"
        override fun sign(message: ByteArray) = "signature-test-only"
    }
    private val config = SupabaseConfiguration("configured","test","https://project.invalid","sb_publishable_test")
    private fun session(expiry: Long = 1000) = JSONObject().put("access_token","access-test-only").put("refresh_token","refresh-test-only").put("expires_at",expiry)
    private fun service(vault: CredentialVault, http: TabletAuthHttp, now: () -> Long = { 10 }) = TabletAuthService(config,vault,signer,http,
        { JSONObject().put("chainId","chain-test-only").put("prefix",org.json.JSONArray()).put("restored",false).put("terminalId",it) },{},now)
    private fun http(refreshes: AtomicInteger = AtomicInteger(), revoked: Boolean = false) = TabletAuthHttp { path, _, body ->
        when {
            path.contains("refresh_token") -> { refreshes.incrementAndGet(); session(2000) }
            path.contains("signup") -> session()
            body.optString("action") == "request" -> JSONObject().put("status","pending").put("requestId","request-test-only")
            body.optString("action") == "challenge" -> JSONObject().put("nonce","nonce-test-only")
            else -> JSONObject().put("status",if(revoked) "revoked" else "authorized")
        }
    }
    @Test fun persistsSessionAcrossServiceAndWorkerRecreationWithoutJavascriptTokens() {
        val vault = MemoryVault()
        val first = service(vault,http())
        first.requestEnrollment("terminal")
        val publicStatus = service(vault,http()).status(true).toString()
        assertTrue(publicStatus.contains("authorized"))
        assertFalse(publicStatus.contains("access-test-only"))
        assertFalse(publicStatus.contains("refresh-test-only"))
    }
    @Test fun encryptedCredentialsSurviveDiskReopenAndNeverLeaveNoBackupStorage() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val firstVault = TabletCredentialVault(context,{ key })
        firstVault.clear()
        try {
            service(firstVault,http()).requestEnrollment("terminal")
            val file = File(context.noBackupFilesDir,"tablet-auth-v1.enc")
            assertTrue(file.exists())
            assertFalse(file.readBytes().toString(Charsets.UTF_8).contains("refresh-test-only"))
            val restarted = TabletCredentialVault(context,{ key })
            assertEquals("authorized",service(restarted,http()).status(true).getString("status"))
            file.writeBytes(byteArrayOf(0,1,2))
            assertEquals("needs_recovery",service(restarted,http()).status().getString("status"))
        } finally { firstVault.clear() }
    }
    @Test fun serializesRefreshAcrossMultipleServiceInstancesAndWorkers() {
        val vault = MemoryVault()
        service(vault,http()).requestEnrollment("terminal")
        val refreshes = AtomicInteger()
        val pool = Executors.newFixedThreadPool(8)
        try {
            val tasks = (1..8).map { Callable { service(vault,http(refreshes),{ 990 }).status(true).getString("status") } }
            assertTrue(pool.invokeAll(tasks).all { it.get() == "authorized" })
            assertEquals(1,refreshes.get())
            assertEquals("refresh-test-only",vault.read()!!.getJSONObject("session").getString("refresh_token"))
        } finally { pool.shutdownNow() }
    }
    @Test fun corruptedVaultAndMissingCredentialsFailSafely() {
        val vault = MemoryVault()
        assertEquals("not_enrolled",service(vault,http()).status().getString("status"))
        vault.data = "corrupt"
        assertEquals("needs_recovery",service(vault,http()).status().getString("status"))
    }
    @Test fun refreshFailureDoesNotEraseCredentialsOrPretendSuccess() {
        val vault = MemoryVault()
        service(vault,http()).requestEnrollment("terminal")
        val auth = service(vault,TabletAuthHttp { _,_,_ -> throw TabletAuthFailure("session_expired") },{ 990 })
        assertEquals("session_expired",auth.status(true).getString("status"))
        assertTrue(vault.data!!.contains("refresh-test-only"))
    }
    @Test fun revocationAndNetworkFailuresOnlyAffectAuthorization() {
        val vault = MemoryVault()
        service(vault,http()).requestEnrollment("terminal")
        assertEquals("revoked",service(vault,http(revoked = true)).status(true).getString("status"))
        assertEquals("revoked",service(vault,http()).status().getString("status"))
        assertEquals("server_unreachable",service(vault,TabletAuthHttp { _,_,_ -> throw TabletAuthFailure("server_unreachable") }).status(true).getString("status"))
        assertTrue(vault.data!!.contains("refresh-test-only"))
    }
    @Test fun workerTransportPreservesSyncEnvelopeAndRejectsAnotherScopeAndRevokedState() {
        val vault = MemoryVault()
        var revoked = false
        var sent = 0
        val transport = object : TabletAuthHttp {
            override fun post(path: String, token: String?, body: JSONObject): JSONObject {
                if (body.optString("action") == "status") {
                    return JSONObject().put("status",if(revoked) "revoked" else "authorized")
                        .put("chainId","chain").put("organizationId","organization").put("festivalId","festival")
                        .put("installationId",vault.read()!!.getString("installationId")).put("enrollmentGeneration",1)
                }
                return http().post(path,token,body)
            }
            override fun postProtected(path: String, token: String, body: JSONObject, nonce: String, signature: String): JSONObject {
                sent++
                assertEquals("/functions/v1/ledger-ingest-v1",path)
                assertTrue(body.has("events"))
                assertFalse(body.has("payload"))
                assertFalse(body.has("access_token"))
                assertEquals("nonce-test-only",nonce)
                assertEquals("signature-test-only",signature)
                return JSONObject().put("committed",true)
            }
        }
        val worker = service(vault,transport)
        worker.requestEnrollment("terminal")
        val context = worker.status(true)
        val envelope = JSONObject(context.toString()).put("protocolVersion",1).put("events",org.json.JSONArray())
        assertTrue(worker.sendSync(ProtectedSyncEndpoint.LEDGER,envelope).getBoolean("committed"))
        envelope.put("organizationId","forged")
        assertThrows(Exception::class.java) { worker.sendSync(ProtectedSyncEndpoint.LEDGER,envelope) }
        revoked = true
        worker.status(true)
        assertThrows(TabletAuthFailure::class.java) { worker.sendSync(ProtectedSyncEndpoint.LEDGER,envelope) }
        assertEquals(1,sent)
    }
    @Test fun restoredLocalDatabaseCannotReuseAnOldAuthorizationUntilNewActivation() {
        val vault = MemoryVault()
        var restored = false
        val auth = TabletAuthService(config,vault,signer,http(),{ JSONObject().put("terminalId",it).put("prefix",org.json.JSONArray()) },{},
            now = { 10 },
            needsLocalRecovery = { restored },continuityVerified = { restored = false })
        auth.requestEnrollment("terminal")
        auth.activate("code-test-only")
        restored = true
        assertEquals("needs_recovery",auth.status(true).getString("status"))
        assertThrows(TabletAuthFailure::class.java) { auth.sendSync(ProtectedSyncEndpoint.LEDGER,JSONObject()) }
        auth.requestEnrollment("terminal",true)
        auth.activate("new-code-test-only")
        assertFalse(restored)
    }
    @Test fun authenticatedEncryptionRejectsTamperingAndLostKeyAndUsesDistinctIvs() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val gcm = GcmCredentials { key }
        val plain = "native-private-session".toByteArray()
        val encrypted = gcm.encrypt(plain)
        assertArrayEquals(plain,gcm.decrypt(encrypted))
        assertFalse(encrypted.contentEquals(gcm.encrypt(plain)))
        encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { gcm.decrypt(encrypted) }
        val wrongKey = GcmCredentials { KeyGenerator.getInstance("AES").apply { init(256) }.generateKey() }
        assertThrows(Exception::class.java) { wrongKey.decrypt(gcm.encrypt(plain)) }
    }
    @Test fun capacitorBridgeLoggingCannotExposePasswordsOrInvitationCodesEvenInDebug() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertFalse(CapConfig.loadDefault(context).isLoggingEnabled)
    }
}
