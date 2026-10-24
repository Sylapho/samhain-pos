package __APP_PACKAGE__

import android.content.Context
import java.security.MessageDigest
import java.util.UUID
import org.json.JSONObject

internal class ApiTabletAuthService(
    private val config: ApiAuthConfiguration,
    private val vault: CredentialVault,
    private val previousVault: CredentialVault,
    private val signer: InstallationSigner,
    private val http: ApiAuthTransport,
    private val dossier: (String)->JSONObject,
    private val bindChain: (String)->Unit,
    private val now: ()->Long = { System.currentTimeMillis()/1000 },
    private val needsRecovery: ()->Boolean = {false},
    private val confirmContinuity: ()->Unit = {},
    private val identityVault: CredentialVault? = null,
) {
    fun status(verify: Boolean=false): JSONObject {
        if(config.status!="configured")return state(if(config.status=="not_configured")"not_configured" else "needs_recovery")
        if(!verify)return try{vault.read()?.let{publicState(it)}?:state("not_enrolled")}catch(_:Exception){state("needs_recovery")}
        return synchronized(TabletAuthService.SESSION_LOCK){
            try{
                val stored=vault.read()?:return@synchronized state("not_enrolled")
                if(!stored.has("session")&&stored.has("activationPayload"))
                    return@synchronized activate(JSONObject(stored.getString("activationPayload")).getString("invitationCode"))
                val body=JSONObject().put("installationId",stored.getString("installationId"))
                val pending=!stored.has("session")
                if(pending)body.put("requestId",stored.getString("requestId"))
                val result=signed("/api/v1/tablets/status","status",body,if(pending)null else accessToken(),if(pending)stored.getString("requestId") else null)
                remember(result);publicState(vault.read()!!)
            }catch(error:TabletAuthFailure){failure(error.code)}catch(_:Exception){failure("needs_recovery")}
        }
    }
    fun requestEnrollment(terminalId:String,reconnect:Boolean=false):JSONObject=synchronized(TabletAuthService.SESSION_LOCK){
        if(config.status!="configured")return@synchronized state("not_configured")
        try{
            require(terminalId.isNotBlank())
            val destination=http.get("/api/v1/auth/config")
            require(destination.getInt("protocolVersion")==1&&destination.getString("destinationId")==config.destinationId)
            var stored=vault.read()
            if(stored==null){
                // Read failure is recovery, never evidence that a previous identity did not exist.
                val previous=previousVault.read() ?: identityVault?.read()
                if(previous!=null)signer.sign("samhain-api-identity-check".toByteArray(Charsets.UTF_8))
                val key=signer.publicKey()
                val previousKey=previous?.optJSONObject("dossier")?.optString("publicKey")?.takeIf{it.isNotBlank()}
                    ?: previous?.optString("publicKey")?.takeIf{it.isNotBlank()}
                if(previousKey!=null)require(previousKey==key)
                val id=previous?.getString("installationId")?:UUID.randomUUID().toString()
                stored=JSONObject().put("schemaVersion",1).put("destinationId",config.destinationId).put("installationId",id).put("publicKey",key).put("status","not_enrolled")
                vault.write(stored)
                identityVault?.write(JSONObject().put("schemaVersion",1).put("installationId",id).put("publicKey",key))
            }else{
                signer.sign("samhain-api-identity-check".toByteArray(Charsets.UTF_8))
                require(stored.getString("publicKey")==signer.publicKey())
            }
            if(reconnect||!stored.has("enrollmentPayload")){
                // Persist the operation before sending. No Room/outbox mutation and no legacy token copy.
                val body=JSONObject().put("operationRequestId",UUID.randomUUID().toString()).put("installationId",stored.getString("installationId")).put("publicKey",stored.getString("publicKey")).put("dossier",dossier(terminalId))
                stored.put("enrollmentPayload",body.toString()).put("status","pending")
                stored.remove("session");stored.remove("rotationPayload");stored.remove("activationPayload")
                vault.write(stored)
            }
            val body=JSONObject(stored.getString("enrollmentPayload"))
            val result=signed("/api/v1/tablet-enrollments","request",body,null)
            stored=vault.read()!!;stored.put("requestId",result.getString("requestId")).put("status",if(result.getString("status")=="rejected")"rejected" else "pending")
            vault.write(stored);publicState(stored)
        }catch(error:TabletAuthFailure){failure(error.code)}catch(_:Exception){failure("needs_recovery")}
    }
    fun activate(code:String):JSONObject=synchronized(TabletAuthService.SESSION_LOCK){
        try{
            val stored=vault.read()?:return@synchronized state("not_enrolled")
            val body=stored.optString("activationPayload").takeIf{it.isNotBlank()}?.let{JSONObject(it)}?:JSONObject().put("operationRequestId",UUID.randomUUID().toString()).put("installationId",stored.getString("installationId")).put("invitationCode",code)
            if(body.getString("invitationCode")!=code)body.put("operationRequestId",UUID.randomUUID().toString()).put("invitationCode",code)
            stored.put("activationPayload",body.toString());vault.write(stored)
            val result=signed("/api/v1/tablet-enrollments/${stored.getString("requestId")}/activate","activate",body,null,stored.getString("requestId"))
            remember(result)
            if(result.getString("status")=="authorized")confirmContinuity()
            publicState(vault.read()!!)
        }catch(error:TabletAuthFailure){failure(error.code)}catch(_:Exception){failure("needs_recovery")}
    }
    fun managerOperation(action:String,body:JSONObject,token:String):JSONObject=synchronized(TabletAuthService.SESSION_LOCK){
        require(action in setOf("approve","reject","revoke"))
        val stored=vault.read()?:throw TabletAuthFailure("not_enrolled")
        // Only the verified body is retained for an exact administrative retry. No manager credential is persisted.
        val value=JSONObject(body.toString());value.remove("requestId");value.remove("installationId")
        if(!value.has("operationRequestId"))value.put("operationRequestId",UUID.randomUUID().toString())
        val path=if(action=="revoke")"/api/v1/tablets/${body.getString("installationId")}/revoke" else "/api/v1/tablet-enrollments/${body.getString("requestId")}/decision"
        if(action!="revoke")value.put("decision",if(action=="approve")"approve" else "reject")
        val pending=stored.optJSONObject("managerOperation")
        val comparison=JSONObject(value.toString()).apply{remove("operationRequestId")}.toString()
        if(pending?.optString("path")==path&&pending.optString("comparison")==comparison)value.put("operationRequestId",pending.getString("operationRequestId"))
        else{stored.put("managerOperation",JSONObject().put("path",path).put("comparison",comparison).put("operationRequestId",value.getString("operationRequestId")));vault.write(stored)}
        val result=try { http.post(path,token,value) } catch(error:TabletAuthFailure) {
            if(error.code=="invitation_used") { stored.remove("managerOperation");vault.write(stored) }
            throw error
        }
        if(action=="approve"){
            require(body.getString("requestId")==stored.getString("requestId"))
            // The invitation is consumed natively; it is never returned through Capacitor.
            return@synchronized activate(result.getString("invitationCode"))
        }
        if(action=="reject"||body.optString("installationId")==stored.getString("installationId"))remember(JSONObject().put("status",if(action=="reject")"rejected" else "revoked"))
        publicState(vault.read()!!)
    }
    private fun accessToken():String{
        var stored=vault.read()?:throw TabletAuthFailure("session_expired")
        val current=stored.optJSONObject("session")?:throw TabletAuthFailure("session_expired")
        if(current.getLong("expires_at")>now()+60&&!stored.has("rotationPayload"))return current.getString("access_token")
        val body=stored.optString("rotationPayload").takeIf{it.isNotBlank()}?.let{JSONObject(it)}?:JSONObject().put("installationId",stored.getString("installationId")).put("refresh_token",current.getString("refresh_token")).put("rotationId",UUID.randomUUID().toString())
        if(!stored.has("rotationPayload")){stored.put("rotationPayload",body.toString()).put("rotationStartedAt",now());vault.write(stored)}
        if(now()-stored.getLong("rotationStartedAt")>60)throw TabletAuthFailure("session_expired")
        val result=signed("/api/v1/auth/refresh","refresh",body,null)
        validateSession(result);stored=vault.read()!!;stored.put("session",result);stored.remove("rotationPayload");stored.remove("rotationStartedAt")
        vault.write(stored)
        return result.getString("access_token")
    }
    private fun signed(path:String,action:String,body:JSONObject,token:String?,requestId:String?=null):JSONObject{
        val stored=vault.read()?:throw TabletAuthFailure("not_enrolled")
        val challenge=JSONObject().put("installationId",stored.getString("installationId")).put("publicKey",stored.getString("publicKey")).put("action",action)
        requestId?.let{challenge.put("requestId",it)}
        val nonce=http.post("/api/v1/auth/challenges",null,challenge).getString("nonce")
        val raw=body.toString()
        val message="samhain-auth/1\n${stored.getString("installationId")}\n$action\n$nonce\n${sha(raw)}"
        return http.signed(path,token,raw,nonce,signer.sign(message.toByteArray(Charsets.UTF_8)))
    }
    private fun remember(result:JSONObject){
        val stored=vault.read()?:throw TabletAuthFailure("needs_recovery")
        val status=result.getString("status")
        if(result.has("chainId")){
            require(result.getString("installationId")==stored.getString("installationId"))
            val expected=JSONObject(stored.getString("enrollmentPayload")).getJSONObject("dossier").getString("chainId")
            require(result.getString("chainId")==expected)
            bindChain(expected)
        }
        result.optJSONObject("session")?.let{validateSession(it);stored.put("session",it);stored.remove("activationPayload")}
        val binding=stored.optJSONObject("binding")?:JSONObject()
        for(field in PUBLIC_FIELDS)if(result.has(field))binding.put(field,result.get(field))
        stored.put("binding",binding).put("status",status).put("checkedAt",java.time.Instant.now().toString())
        vault.write(stored)
    }
    private fun publicState(stored:JSONObject):JSONObject{
        val result=JSONObject().put("status",stored.optString("status","not_enrolled")).put("installationId",stored.getString("installationId"))
        stored.optJSONObject("binding")?.let{binding->for(field in PUBLIC_FIELDS)if(binding.has(field))result.put(field,binding.get(field))}
        if(stored.has("requestId"))result.put("requestId",stored.getString("requestId"))
        if(stored.has("checkedAt"))result.put("checkedAt",stored.getString("checkedAt"))
        if(result.optString("status")=="authorized"){
            val session=stored.optJSONObject("session")
            if(needsRecovery()||session==null)result.put("status","needs_recovery")
            else if(session.optLong("expires_at",0)<=now())result.put("status","session_expired")
        }
        if(!result.has("chainId"))stored.optString("enrollmentPayload").takeIf{it.isNotBlank()}?.let{result.put("chainId",JSONObject(it).getJSONObject("dossier").getString("chainId"))}
        return result
    }
    private fun failure(code:String):JSONObject{
        try{vault.read()?.let{if(code in setOf("revoked","authorization_denied","needs_recovery","rejected","session_expired")){it.put("status",code);vault.write(it)}}}catch(_:Exception){}
        return try{vault.read()?.let{publicState(it).put("status",code)}?:state(code)}catch(_:Exception){state(code)}
    }
    private fun validateSession(value:JSONObject){require(value.getString("access_token").isNotBlank()&&value.getString("refresh_token").isNotBlank()&&value.getLong("expires_at")>now()&&value.getString("token_type")=="bearer")}
    companion object{
        private val PUBLIC_FIELDS=listOf("organizationId","festivalId","chainId","enrollmentGeneration","serverHead")
        private fun state(value:String)=JSONObject().put("status",value)
        private fun sha(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString(""){"%02x".format(it)}
        fun get(context:Context):ApiTabletAuthService{
            val config=ApiAuthConfiguration.load(context);val room=RoomOrderStore(SamhainPosDatabase.getInstance(context))
            return ApiTabletAuthService(config,TabletCredentialVault(context,destination=config.destinationId?:"disabled-api"),TabletCredentialVault(context),KeystoreInstallationSigner(),ApiAuthHttp(config),room::enrollmentDossier,room::bindSyncChain,needsRecovery={room.syncIdentity().restored},confirmContinuity=room::confirmSyncContinuity,identityVault=TabletCredentialVault(context,destination="api-installation-identity"))
        }
    }
}
