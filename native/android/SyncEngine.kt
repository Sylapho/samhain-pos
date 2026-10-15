package __APP_PACKAGE__

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject

internal class SyncEngine(
    private val database: SamhainPosDatabase,
    private val authState: () -> JSONObject,
    private val send: (ProtectedSyncEndpoint, JSONObject) -> JSONObject,
    private val now: () -> Long = System::currentTimeMillis,
    private val jitter: (Long) -> Long = { Random.nextLong(it + 1) },
) {
    private val store = OutboxStore(database)

    /** Returns the earliest useful next wakeup, or null when drained/blocked. */
    fun drain(): Long? {
        // Backfill is local and also runs without configuration or enrollment.
        repeat(10) { if(store.backfillBatch()) return drainReady() }
        return now() + 1000
    }

    private fun drainReady(): Long? {
        if(database.outboxDao().backfill()?.enabled == false) return null
        val scope = authState()
        if(scope.optString("status") == "needs_recovery" && store.takeRecoveryRequest()) {
            if(scope.has("organizationId")) recover(scope)
            return null
        }
        if(scope.optString("status") !in setOf("authorized","session_expired")) return null
        if(store.takeRecoveryRequest()) {
            val blocked = database.outboxDao().outstanding(scope.getString("chainId"),1).firstOrNull()
            if(blocked?.status == "needs_recovery" && blocked.lastError in setOf("HEAD_MOVED","MISSING_PREDECESSOR","DEPENDENCY_MISSING")) recover(scope,blocked.lastError == "DEPENDENCY_MISSING")
        }
        val owner = UUID.randomUUID().toString()
        val chain = scope.getString("chainId")
        var rows: List<OutboxEntry> = emptyList()
        try {
            rows = store.claim(scope,owner,now())
            if(rows.isEmpty()) return nextWake(chain)
            val selected = mutableListOf<OutboxEntry>()
            val request = SyncProtocol.envelope(scope,UUID.randomUUID().toString())
            val events = JSONArray()
            request.put("events",events)
            if(rows.first().sequence != null) request.put("expectedHead",JSONObject()
                .put("sequence",rows.first().sequence!! - 1).put("hash",rows.first().previousHash ?: JSONObject.NULL))
            for(row in rows) {
                if(row.payloadCanonical.toByteArray(Charsets.UTF_8).size > SyncProtocol.MAX_PAYLOAD) {
                    if(selected.isEmpty()) throw SyncHttpFailure(422,"EVENT_TOO_LARGE")
                    break
                }
                events.put(SyncProtocol.event(row))
                if(request.toString().toByteArray(Charsets.UTF_8).size > SyncProtocol.MAX_BODY) {
                    events.remove(events.length() - 1)
                    if(selected.isEmpty()) throw SyncHttpFailure(422,"EVENT_TOO_LARGE")
                    break
                }
                selected.add(row)
            }
            store.release(rows.drop(selected.size),owner,"pending","BATCH_DEFERRED",0)
            rows = selected
            store.renew(rows,owner,now())
            rows = store.markAttempt(rows,owner,now())
            val response = send(if(rows.first().sequence == null) ProtectedSyncEndpoint.LEGACY else ProtectedSyncEndpoint.LEDGER,request)
            try { store.acknowledge(rows,owner,request,response,now()) }
            catch (_: Exception) {
                store.release(rows,owner,"pending","INVALID_ACK",now() + backoff(rows.first().attemptCount,jitter))
                return nextWake(chain)
            }
        } catch(error: TabletAuthFailure) {
            val temporary = error.code == "server_unreachable"
            val recovery = error.code == "needs_recovery"
            store.release(rows,owner,if(temporary) "pending" else if(recovery) "needs_recovery" else "paused_auth",
                if(temporary) "NETWORK_ERROR" else if(recovery) "AUTH_RECOVERY_REQUIRED" else "AUTH_REQUIRED",
                if(temporary) now() + backoff(rows.firstOrNull()?.attemptCount ?: 1,jitter) else 0)
        } catch(error: SyncHttpFailure) {
            val temporary = error.httpStatus in setOf(408,429) || error.httpStatus >= 500
            val recovery = error.errorCode in setOf("HEAD_MOVED","MISSING_PREDECESSOR","DEPENDENCY_MISSING",
                "PROTOCOL_UNSUPPORTED","LEDGER_SCHEMA_UNSUPPORTED","BATCH_TOO_LARGE")
            store.release(rows,owner,if(temporary) "pending" else if(recovery) "needs_recovery" else "quarantined",error.errorCode,
                if(temporary) now() + maxOf(backoff(rows.firstOrNull()?.attemptCount ?: 1,jitter),error.retryAfterMillis ?: 0) else 0)
            if(error.errorCode in setOf("HEAD_MOVED","MISSING_PREDECESSOR","DEPENDENCY_MISSING")) {
                if(store.allowAutomaticRecovery() && recover(scope,error.errorCode == "DEPENDENCY_MISSING")) return now() + 1000
            }
            if(error.errorCode == "BATCH_TOO_LARGE") {
                // Local byte limit is authoritative; use a smaller persisted group on retry.
                if(rows.size > 1 && store.reduceBatch(chain)) return now() + 1000
                store.blockChain(chain,"quarantined","EVENT_TOO_LARGE")
            }
        } catch (_: Exception) {
            // Never leak payloads/credentials through exception messages.
            store.release(rows,owner,"needs_recovery","LOCAL_SYNC_INCONSISTENCY",0)
            if(rows.isEmpty()) store.blockChain(chain,"needs_recovery","LOCAL_SYNC_INCONSISTENCY")
        }
        return nextWake(chain)
    }

    /** Every local tuple is compared; the remote head alone is insufficient. */
    fun recover(scope: JSONObject, includeLegacy: Boolean = false): Boolean {
        val chain = scope.getString("chainId")
        val localHead = database.salesLedgerDao().batchAfter(0,1).firstOrNull()
        if(localHead == null) return false
        var cursor = 0L
        val maxSequence = database.metadataDao().get()!!.nextJournalSequence - 1
        try {
            store.rewindBackfill()
            while(!store.backfillBatch()) { /* Recover missing capture, preserving every original tuple. */ }
            while(true) {
                val unbound = database.outboxDao().ledgerPage(chain,cursor,100)
                if(unbound.isEmpty()) break
                if(unbound.any { it.status == "quarantined" }) return false
                val page = store.bindPage(unbound,scope)
                val request = SyncProtocol.envelope(scope,UUID.randomUUID().toString()).put("events",JSONArray().also { events ->
                    page.forEach { row -> events.put(JSONObject().put("sequence",row.sequence).put("eventId",row.eventId)
                        .put("hash",row.hash).put("transportFingerprint",row.transportFingerprint)) }
                })
                val response = send(ProtectedSyncEndpoint.PREFIX,request)
                SyncProtocol.validateContext(request,response)
                val head = response.getJSONObject("serverHead")
                SyncProtocol.validateHead(head)
                if(head.getLong("sequence") > maxSequence) return false
                val results = response.getJSONArray("results")
                require(results.length() == page.size)
                val seen = mutableSetOf<String>()
                for(i in 0 until results.length()) {
                    val result = results.getJSONObject(i)
                    val row = page.firstOrNull { it.eventId == result.getString("eventId") } ?: error("INVALID_PREFIX")
                    require(seen.add(row.eventId))
                    require(result.getLong("sequence") == row.sequence && result.getString("hash") == row.hash &&
                        result.getString("transportFingerprint") == row.transportFingerprint)
                    if(result.getString("status") == "conflict") {
                        store.blockChain(chain,"quarantined","PREFIX_CONFLICT")
                        return false
                    }
                    require(result.getString("status") in setOf("match","absent"))
                }
                cursor = page.last().sequence!!
            }
            store.requeueProvenPrefix(chain,includeLegacy)
            return true
        } catch (_: Exception) { return false }
    }

    private fun nextWake(chain: String): Long? {
        if(database.outboxDao().blockedCount(chain) > 0) return null
        val first = database.outboxDao().outstanding(chain,1).firstOrNull() ?: return null
        return when(first.status) {
            "pending" -> maxOf(now() + 1000,first.nextAttemptAt)
            "sending" -> maxOf(now() + 1000,first.leaseExpiresAt ?: now() + 120000)
            else -> null
        }
    }

    companion object {
        fun backoff(attempt: Int, jitter: (Long) -> Long): Long = jitter(minOf(21600000L,5000L * (1L shl (attempt - 1).coerceIn(0,23))))
        fun retryAfter(value: String?, now: Long): Long? {
            if(value == null) return null
            value.toLongOrNull()?.takeIf { it in 0..2147483647 }?.let { return it * 1000 }
            return try { (ZonedDateTime.parse(value,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - now).coerceAtLeast(0) }
            catch (_: Exception) { null }
        }
    }
}
