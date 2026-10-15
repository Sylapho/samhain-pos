package fr.samhain.pos

import android.content.Context
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

internal class SyncHttpFailure(val httpStatus: Int, val errorCode: String, val retryAfterMillis: Long? = null) : Exception(errorCode)

internal class TabletAuthFailure(val code: String) : Exception(code)

internal fun interface TabletAuthHttp {
    fun post(path: String, token: String?, body: JSONObject): JSONObject
    fun postProtectedRaw(path: String, token: String, payload: String, nonce: String, signature: String): JSONObject =
        postProtected(path, token, JSONObject(payload), nonce, signature)
    fun postProtected(path: String, token: String, body: JSONObject, nonce: String, signature: String): JSONObject {
        throw UnsupportedOperationException("Protected sync transport unavailable")
    }
}

internal enum class ProtectedSyncEndpoint(val route: String) {
    LEDGER("ledger-ingest-v1"), LEGACY("legacy-import-v1"), PREFIX("ledger-prefix-v1")
}

internal class SupabaseAuthHttp(
    private val config: SupabaseConfiguration,
    private val open: (URL) -> HttpsURLConnection = { it.openConnection() as HttpsURLConnection },
) : TabletAuthHttp {
    override fun post(path: String, token: String?, body: JSONObject): JSONObject = request(path,token,body,emptyMap())
    override fun postProtected(path: String, token: String, body: JSONObject, nonce: String, signature: String): JSONObject =
        request(path,token,body,mapOf("X-Samhain-Nonce" to nonce,"X-Samhain-Signature" to signature))

    override fun postProtectedRaw(path: String, token: String, payload: String, nonce: String, signature: String): JSONObject =
        request(path,token,JSONObject(payload),mapOf("X-Samhain-Nonce" to nonce,"X-Samhain-Signature" to signature),payload)

    private fun readBounded(stream: java.io.InputStream): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while(true) {
            val count = stream.read(buffer)
            if(count < 0) break
            require(output.size() + count <= 1048576)
            output.write(buffer,0,count)
        }
        return output.toByteArray()
    }

    private fun request(path: String, token: String?, body: JSONObject, proofHeaders: Map<String,String>, rawPayload: String = body.toString()): JSONObject {
        require(config.status == "configured")
        val connection = open(URL(config.url + path))
        val timeout = TIMEOUTS.schedule({ connection.disconnect() },30,java.util.concurrent.TimeUnit.SECONDS)
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = 30000
            connection.readTimeout = 30000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type","application/json")
            connection.setRequestProperty("apikey",config.publishableKey)
            token?.let { connection.setRequestProperty("Authorization","Bearer $it") }
            proofHeaders.forEach { (name,value) -> connection.setRequestProperty(name,value) }
            val bytes = rawPayload.toByteArray(Charsets.UTF_8)
            require(bytes.size <= 1048576)
            connection.outputStream.use { it.write(bytes) }
            val status = connection.responseCode
            if (status == 401) throw TabletAuthFailure("session_expired")
            if (status == 403) throw TabletAuthFailure("authorization_denied")
            if (proofHeaders.isNotEmpty() && status in 201..299) throw SyncHttpFailure(408,"INVALID_ACK")
            if (proofHeaders.isNotEmpty() && status != 200) {
                val response = connection.errorStream?.use { stream -> String(readBounded(stream),Charsets.UTF_8) }
                val error = try { JSONObject(response ?: "{}").getJSONObject("error") } catch (_: Exception) { JSONObject() }
                val code = error.optString("code","HTTP_ERROR")
                val allowed = setOf("HEAD_MOVED","MISSING_PREDECESSOR","DEPENDENCY_MISSING","SEQUENCE_FORK",
                    "EVENT_CONTENT_CONFLICT","DUPLICATE_ORDER_OTHER_CHAIN","TRANSACTION_RETRY","SERVER_UNAVAILABLE",
                    "INTERNAL_ERROR","RATE_LIMITED","INVALID_ENVELOPE","INVALID_HASH","INVALID_FINGERPRINT",
                    "INVALID_PAYLOAD","BUSINESS_INCONSISTENCY","CANONICALIZATION_UNSUPPORTED","PROTOCOL_UNSUPPORTED",
                    "LEDGER_SCHEMA_UNSUPPORTED","BATCH_TOO_LARGE","EVENT_TOO_LARGE")
                val retryAfter = SyncEngine.retryAfter(connection.getHeaderField("Retry-After"),System.currentTimeMillis())
                    ?: error.optLong("retryAfterSeconds",-1).takeIf { it in 0..2147483647 }?.let { it * 1000 }
                throw SyncHttpFailure(status,if(code in allowed) code else "HTTP_ERROR",retryAfter)
            }
            if (status !in 200..299) throw TabletAuthFailure(if (status >= 500 || status == 429 || status == 408) "server_unreachable" else "needs_recovery")
            val response = connection.inputStream.use { String(readBounded(it),Charsets.UTF_8) }
            require(response.toByteArray(Charsets.UTF_8).size <= 1048576)
            return JSONObject(response)
        } catch (error: TabletAuthFailure) { throw error }
        catch (_: org.json.JSONException) {
            if(proofHeaders.isNotEmpty()) throw SyncHttpFailure(408,"INVALID_ACK")
            throw TabletAuthFailure("needs_recovery")
        }
        catch (_: IllegalArgumentException) {
            if(proofHeaders.isNotEmpty()) throw SyncHttpFailure(408,"INVALID_ACK")
            throw TabletAuthFailure("needs_recovery")
        }
        catch (_: java.io.IOException) { throw TabletAuthFailure("server_unreachable") }
        finally { timeout.cancel(false); connection.disconnect() }
    }
    companion object {
        private val TIMEOUTS = java.util.concurrent.Executors.newScheduledThreadPool(1) { runnable ->
            Thread(runnable,"samhain-http-timeout").apply { isDaemon = true }
        }
    }
}

/** Process-wide serialization includes UI + future WorkManager workers, outside WebView. */
internal class TabletAuthService(
    private val config: SupabaseConfiguration,
    private val vault: CredentialVault,
    private val signer: InstallationSigner,
    private val http: TabletAuthHttp,
    private val dossier: (String) -> JSONObject,
    private val bindChain: (String) -> Unit,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val needsLocalRecovery: () -> Boolean = { false },
    private val continuityVerified: () -> Unit = {},
) {
    fun status(verify: Boolean = false): JSONObject = synchronized(SESSION_LOCK) {
        if (config.status != "configured") return@synchronized state(if(config.status == "not_configured") "not_configured" else "needs_recovery")
        val stored = try { vault.read() } catch (_: Exception) { return@synchronized state("needs_recovery") }
        if (stored == null) return@synchronized state("not_enrolled")
        if (stored.optString("status") == "authorized" && needsLocalRecovery()) return@synchronized publicState(stored).put("status","needs_recovery")
        if (!verify) {
            val result = publicState(stored)
            if (stored.optJSONObject("session")?.optLong("expires_at",0)?.let { it <= now() } == true && result.getString("status") !in setOf("revoked","needs_recovery")) result.put("status","session_expired")
            return@synchronized result
        }
        try {
            val result = deviceRequest("status", JSONObject().put("installationId",stored.getString("installationId")))
            rememberResult(result)
            publicState(vault.read()!!)
        } catch (error: TabletAuthFailure) { failureState(error.code) }
        catch (_: Exception) { failureState("needs_recovery") }
    }

    fun requestEnrollment(terminalId: String, reconnect: Boolean = false): JSONObject = synchronized(SESSION_LOCK) {
        if (config.status != "configured") return@synchronized state("not_configured")
        require(terminalId.isNotBlank())
        try {
            if (reconnect) vault.clear() // Explicitly authorized reauthentication; never changes Room.
            var stored = vault.read()
            if (stored == null) {
                val session = http.post("/auth/v1/signup",null,JSONObject())
                validateSession(session)
                val installationId = UUID.randomUUID().toString()
                val requestDossier = dossier(terminalId).put("installationId",installationId).put("publicKey",signer.publicKey())
                stored = JSONObject().put("schemaVersion",1).put("installationId",installationId)
                    .put("session",session).put("dossier",requestDossier).put("status","pending")
                vault.write(stored)
            }
            val result = edge("request",stored.getJSONObject("dossier"),accessToken())
            stored = vault.read()!!
            stored.put("requestId",result.getString("requestId")).put("status","pending")
            vault.write(stored)
            publicState(stored)
        } catch (error: TabletAuthFailure) { failureState(error.code) }
        catch (_: Exception) { failureState("needs_recovery") }
    }

    fun activate(code: String): JSONObject = synchronized(SESSION_LOCK) {
        try {
            val stored = vault.read() ?: return@synchronized state("not_enrolled")
            val result = deviceRequest("activate",JSONObject().put("installationId",stored.getString("installationId")).put("invitationCode",code))
            if (result.getString("status") in setOf("authorized","needs_recovery")) {
                rememberResult(result)
                if (result.getString("status") == "authorized") continuityVerified()
                return@synchronized publicState(vault.read()!!)
            }
            else if (result.getString("status") == "invitation_used") return@synchronized status(true) // Lost activation response.
            publicState(stored).put("status",result.getString("status"))
        } catch (error: TabletAuthFailure) { failureState(error.code) }
        catch (_: Exception) { failureState("needs_recovery") }
    }

    fun managerOperation(action: String, email: String, password: String, body: JSONObject): JSONObject = synchronized(SESSION_LOCK) {
        require(action in setOf("approve","revoke"))
        // The manager session is temporary native memory, never written to the vault.
        val session = http.post("/auth/v1/token?grant_type=password",null,JSONObject().put("email",email).put("password",password))
        validateSession(session)
        val token = session.getString("access_token")
        val result = try { edge(action,body,token) }
        finally { try { http.post("/auth/v1/logout?scope=local",token,JSONObject()) } catch (_: Exception) { /* Expiry remains bounded; no log of credentials. */ } }
        if (action == "revoke" && result.optString("status") == "revoked" && vault.read()?.optString("installationId") == body.optString("installationId")) {
            rememberResult(result)
            return@synchronized publicState(vault.read()!!)
        }
        result
    }

    // No Capacitor token getter. #35 uses this method to build a signed request natively.
    fun deviceRequest(action: String, body: JSONObject): JSONObject = synchronized(SESSION_LOCK) {
        signedRequest(action,"tablet-auth-v1",body)
    }

    // Real native transport seam for #35/#36, never exposed to JavaScript.
    fun sendSync(endpoint: ProtectedSyncEndpoint, body: JSONObject): JSONObject = synchronized(SESSION_LOCK) {
        if (needsLocalRecovery() && endpoint != ProtectedSyncEndpoint.PREFIX) throw TabletAuthFailure("needs_recovery")
        val current = publicState(vault.read() ?: throw TabletAuthFailure("not_enrolled"))
        if (current.getString("status") != "authorized" && !(endpoint == ProtectedSyncEndpoint.PREFIX && current.getString("status") == "needs_recovery")) throw TabletAuthFailure(current.getString("status"))
        for (field in listOf("organizationId","festivalId","chainId","installationId","enrollmentGeneration")) {
            require(body.get(field).toString() == current.get(field).toString())
        }
        val wasExpired = vault.read()!!.getJSONObject("session").getLong("expires_at") <= now() + 60
        try { signedRequest(endpoint.route,endpoint.route,body) }
        catch (error: TabletAuthFailure) {
            if(error.code != "session_expired" || wasExpired) { failureState(error.code); throw error }
            val stored = vault.read() ?: throw error
            stored.getJSONObject("session").put("expires_at",0)
            vault.write(stored)
            try { signedRequest(endpoint.route,endpoint.route,body) }
            catch (retryError: TabletAuthFailure) { failureState(retryError.code); throw retryError }
        }
    }

    private fun signedRequest(action: String, route: String, body: JSONObject): JSONObject {
        val token = accessToken()
        val nonce = edge("challenge",JSONObject().put("installationId",body.getString("installationId")),token).getString("nonce")
        val payload = body.toString()
        val hash = MessageDigest.getInstance("SHA-256").digest(payload.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val message = "samhain-auth/1\n${body.getString("installationId")}\n$action\n$nonce\n$hash"
        val signature = signer.sign(message.toByteArray(Charsets.UTF_8))
        if (route != "tablet-auth-v1") return http.postProtectedRaw("/functions/v1/$route",token,payload,nonce,signature)
        return http.post("/functions/v1/$route",token,JSONObject().put("action",action).put("payload",payload)
            .put("nonce",nonce).put("signature",signature))
    }

    private fun accessToken(): String {
        val stored = vault.read() ?: throw TabletAuthFailure("session_expired")
        var session = stored.getJSONObject("session")
        if (session.getLong("expires_at") <= now() + 60) {
            // Reload inside the common lock: concurrent callers cannot rotate the same refresh token.
            session = http.post("/auth/v1/token?grant_type=refresh_token",null,JSONObject().put("refresh_token",session.getString("refresh_token")))
            validateSession(session)
            stored.put("session",session)
            vault.write(stored) // Persistence failure stops all requests; no stale credential retry.
        }
        return session.getString("access_token")
    }

    private fun edge(action: String, body: JSONObject, token: String): JSONObject = http.post("/functions/v1/tablet-auth-v1",token,JSONObject().put("action",action).put("body",body))

    private fun rememberResult(result: JSONObject) {
        val stored = vault.read() ?: throw TabletAuthFailure("needs_recovery")
        if (result.has("chainId")) bindChain(result.getString("chainId"))
        if (result.has("chainId")) stored.put("binding",result)
        stored.put("authorization",result).put("status",result.getString("status"))
        vault.write(stored)
    }

    private fun failureState(code: String): JSONObject {
        if (code in setOf("session_expired","authorization_denied")) {
            try { vault.read()?.let { it.put("status",code); vault.write(it) } } catch (_: Exception) { }
        }
        return try { vault.read()?.let { publicState(it).put("status",code) } ?: state(code) }
        catch (_: Exception) { state(code) }
    }

    private fun publicState(stored: JSONObject): JSONObject {
        val result = JSONObject(stored.optJSONObject("binding")?.toString() ?: "{}")
        stored.optJSONObject("authorization")?.let { auth -> auth.keys().forEach { field -> result.put(field,auth.get(field)) } }
        result.put("status",stored.optString("status","not_enrolled"))
        result.put("installationId",stored.getString("installationId"))
        stored.optString("requestId").takeIf { it.isNotBlank() }?.let { result.put("requestId",it) }
        stored.optJSONObject("dossier")?.optString("chainId")?.let { if(!result.has("chainId")) result.put("chainId",it) }
        return result
    }

    private fun validateSession(session: JSONObject) {
        require(session.getString("access_token").isNotBlank() && session.getString("refresh_token").isNotBlank())
        if (!session.has("expires_at")) session.put("expires_at",now() + session.getLong("expires_in"))
        require(session.getLong("expires_at") > now())
    }

    companion object {
        private val SESSION_LOCK = Any()
        fun state(status: String): JSONObject = JSONObject().put("status",status)
        fun prepareReplacement(context: Context): JSONObject = synchronized(SESSION_LOCK) {
            // Offline restoration does not initialize Auth, HTTPS or Keystore signing.
            TabletCredentialVault(context).clear()
            RoomOrderStore(SamhainPosDatabase.getInstance(context)).prepareSyncReplacement()
            state("needs_recovery").put("prepared",true)
        }
        fun get(context: Context): TabletAuthService {
            val config = SupabaseConfiguration.load(context)
            val room = RoomOrderStore(SamhainPosDatabase.getInstance(context))
            return TabletAuthService(config,TabletCredentialVault(context),KeystoreInstallationSigner(),SupabaseAuthHttp(config),room::enrollmentDossier,room::bindSyncChain,
                needsLocalRecovery = { room.syncIdentity().restored },continuityVerified = room::confirmSyncContinuity)
        }
    }
}
