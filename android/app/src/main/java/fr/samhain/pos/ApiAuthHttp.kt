package fr.samhain.pos

import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

internal interface ApiAuthTransport {
    fun get(path: String, token: String? = null): JSONObject
    fun post(path: String, token: String?, body: JSONObject): JSONObject
    fun signed(path: String, token: String?, raw: String, nonce: String, signature: String): JSONObject
}

internal class ApiAuthHttp(private val config: ApiAuthConfiguration, private val open: (URL) -> HttpsURLConnection = { it.openConnection() as HttpsURLConnection }) : ApiAuthTransport {
    override fun get(path: String, token: String?) = request("GET",path,token,null,emptyMap())
    override fun post(path: String, token: String?, body: JSONObject) = request("POST",path,token,body.toString(),emptyMap())
    override fun signed(path: String, token: String?, raw: String, nonce: String, signature: String) = request("POST",path,token,raw,mapOf("X-Samhain-Nonce" to nonce,"X-Samhain-Signature" to signature))
    private fun request(method: String, path: String, token: String?, raw: String?, proof: Map<String,String>): JSONObject {
        require(config.status == "configured" && path.startsWith("/api/v1/") && !path.contains("..") && !path.contains('\n') && !path.contains('\r'))
        val connection = open(URL(config.origin + path))
        val timeout = TIMEOUTS.schedule({ connection.disconnect() },30,java.util.concurrent.TimeUnit.SECONDS)
        try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = method
            connection.connectTimeout = 15000; connection.readTimeout = 15000
            connection.setRequestProperty("Accept","application/json")
            token?.let { connection.setRequestProperty("Authorization","Bearer $it") }
            proof.forEach { (name,value) -> connection.setRequestProperty(name,value) }
            if (raw != null) {
                val bytes=raw.toByteArray(Charsets.UTF_8);require(bytes.size<=1048576)
                connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status=connection.responseCode
            if(status in 300..399)throw TabletAuthFailure("needs_recovery")
            if(connection.getHeaderField("X-Samhain-Destination")!=config.destinationId)throw TabletAuthFailure(if(status>=500)"server_unreachable" else "needs_recovery")
            val stream=if(status==200)connection.inputStream else connection.errorStream
            val bytes=stream?.use { input ->
                val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192)
                while(true){val count=input.read(buffer);if(count<0)break;require(output.size()+count<=1048576);output.write(buffer,0,count)}
                output.toByteArray()
            } ?: byteArrayOf()
            val decoded=Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).decode(java.nio.ByteBuffer.wrap(bytes)).toString()
            val result=try{StrictApiJson.parse(decoded)}catch(_:Exception){throw TabletAuthFailure(if(status>=500)"server_unreachable" else "needs_recovery")}
            if(status!=200){
                val code=result.optJSONObject("error")?.optString("code")
                val state=when(code){
                    "AUTH_REQUIRED" -> "session_expired"
                    "ACCESS_REVOKED", "INSTALLATION_RETIRED" -> "revoked"
                    "SCOPE_DENIED","REFRESH_REPLAY" -> "authorization_denied"
                    "ENROLLMENT_EXPIRED" -> "invitation_expired"
                    "INVITATION_INVALID" -> "invitation_invalid"
                    "INVITATION_UNAVAILABLE" -> "invitation_used"
                    "ATTEMPTS_EXCEEDED" -> "attempts_exceeded"
                    "REPLACEMENT_CONFLICT" -> "replacement_conflict"
                    "OIDC_NOT_CONFIGURED" -> "oidc_not_configured"
                    else -> if(status==401) "session_expired" else if(status==403) "authorization_denied" else if(status>=500||status==429||status==408)"server_unreachable" else "needs_recovery"
                }
                if (path.startsWith("/api/v1/ledger/") && status !in setOf(401,403)) {
                    val allowed = setOf("HEAD_MOVED","MISSING_PREDECESSOR","DEPENDENCY_MISSING","SEQUENCE_FORK",
                        "EVENT_CONTENT_CONFLICT","DUPLICATE_ORDER_OTHER_CHAIN","TRANSACTION_RETRY","SERVER_UNAVAILABLE",
                        "INTERNAL_ERROR","RATE_LIMITED","INVALID_ENVELOPE","INVALID_HASH","INVALID_FINGERPRINT",
                        "INVALID_PAYLOAD","BUSINESS_INCONSISTENCY","CANONICALIZATION_UNSUPPORTED","PROTOCOL_UNSUPPORTED",
                        "LEDGER_SCHEMA_UNSUPPORTED","BATCH_TOO_LARGE","EVENT_TOO_LARGE")
                    val retry = SyncEngine.retryAfter(connection.getHeaderField("Retry-After"),System.currentTimeMillis())?.coerceAtMost(21600000)
                    throw SyncHttpFailure(status,if(code in allowed) code!! else "HTTP_ERROR",retry)
                }
                throw TabletAuthFailure(state)
            }
            return result
        }catch(error:SyncHttpFailure){throw error}
        catch(error:TabletAuthFailure){throw error}
        catch(_:java.io.IOException){throw TabletAuthFailure("server_unreachable")}
        catch(_:Exception){throw TabletAuthFailure("needs_recovery")}
        finally{timeout.cancel(false);connection.disconnect()}
    }
    companion object { private val TIMEOUTS=java.util.concurrent.Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable,"samhain-api-timeout").apply{isDaemon=true} } }
}
