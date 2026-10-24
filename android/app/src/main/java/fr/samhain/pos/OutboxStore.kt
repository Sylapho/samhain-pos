package fr.samhain.pos

import java.util.UUID
import java.time.Instant
import java.util.concurrent.Callable
import org.json.JSONObject

internal class OutboxStore(private val database: SamhainPosDatabase, private val destination: String? = null) {
    private val dao = database.outboxDao()
    private fun <T> tx(block: () -> T): T = database.runInTransaction(Callable {
        if (destination != null) require((dao.backfill()?.destinationId ?: "supabase") == destination) { "DESTINATION_CHANGED" }
        block()
    })

    /** Switch the active delivery projection atomically; preserve every previous destination's evidence. */
    fun selectDestination(now: Long = System.currentTimeMillis()) = database.runInTransaction(Callable {
        val target = destination ?: return@Callable
        dao.initBackfill(OutboxBackfill())
        val state = dao.backfill()!!
        if (state.destinationId == target) return@Callable
        var cursor = ""
        while (true) {
            val page = dao.destinationPage(cursor)
            if (page.isEmpty()) break
            for (row in page) {
                require(row.status != "sending" || (row.leaseExpiresAt ?: Long.MAX_VALUE) <= now) { "DESTINATION_BUSY" }
                dao.saveDestination(OutboxDestination.from(state.destinationId, row))
                val previous = dao.destination(target, row.eventId)
                val fresh = row.copy(organizationId = null, festivalId = null, transportFingerprint = null,
                    status = if (row.status in setOf("quarantined", "needs_recovery")) row.status else "pending",
                    attemptCount = 0, lastAttemptAt = null, nextAttemptAt = 0,
                    lastError = if (row.status in setOf("quarantined", "needs_recovery")) row.lastError else null,
                    claimOwner = null, leaseExpiresAt = null, receiptId = null, serverReceivedAt = null, syncedAt = null)
                val restored = previous?.applyTo(row) ?: fresh
                // A claim from a retired destination/process cannot resume as a live lease.
                val ready = if (restored.status == "sending") restored.copy(status = "pending", claimOwner = null, leaseExpiresAt = null) else restored
                require(dao.update(ready) == 1)
            }
            cursor = page.last().eventId
        }
        require(dao.updateBackfill(state.copy(destinationId = target, ledgerCursor = 0, legacyCursor = "",
            legacyComplete = false, recoveryAttempts = 0, recoveryRequested = false)) == 1)
    })
    private fun identity(): SyncIdentityEntity {
        val identities = database.syncIdentityDao()
        identities.insertIfMissing(SyncIdentityEntity(chainId = UUID.randomUUID().toString()))
        return identities.get()!!
    }

    // Called inside the financial transaction; no Auth, scheduler or network here.
    fun capture(entry: SalesLedgerEntity) {
        val payload = JSONObject(entry.payloadJson)
        val profile = SyncProtocol.ledgerProfile(payload)
        insertIdentical(OutboxEntry(entry.id,identity().chainId,"ledger",entry.kind,
            entry.orderId ?: entry.id,entry.sourceTerminalId,entry.sequence,entry.hash,entry.previousHash,
            if(profile == "android-ledger-v1") CanonicalJson.stringify(payload) else SyncProtocol.canonical(payload),profile))
    }

    private fun captureLegacy(order: OrderEntity) {
        val payload = JSONObject(order.immutablePayloadJson).apply { remove("integrity"); remove("printing") }
        insertIdentical(OutboxEntry(order.id,identity().chainId,"legacy_order","legacy_order",order.id,
            order.terminalId,null,null,null,SyncProtocol.canonical(payload),null))
    }

    private fun insertIdentical(entry: OutboxEntry) {
        val existing = dao.find(entry.eventId)
        if(existing == null) dao.insert(entry)
        else require(existing.chainId == entry.chainId && existing.payloadCanonical == entry.payloadCanonical &&
            existing.hash == entry.hash && existing.sequence == entry.sequence && existing.ledgerCanonicalization == entry.ledgerCanonicalization) {
            "OUTBOX_CONTENT_CONFLICT"
        }
    }

    /** At most 100 source records per commit, including an immutable durable cursor. */
    fun backfillBatch(): Boolean = tx {
        dao.initBackfill(OutboxBackfill())
        var state = dao.backfill()!!
        var remaining = 100
        if(!state.legacyComplete) {
            val legacy = database.orderDao().legacyAfter(state.legacyCursor,remaining)
            legacy.forEach(::captureLegacy)
            remaining -= legacy.size
            state = state.copy(legacyCursor = legacy.lastOrNull()?.id ?: state.legacyCursor,legacyComplete = legacy.size < 100)
        }
        val entries = database.salesLedgerDao().batchAfter(state.ledgerCursor,remaining)
        entries.forEach(::capture)
        state = state.copy(ledgerCursor = entries.lastOrNull()?.sequence ?: state.ledgerCursor)
        val complete = state.legacyComplete && entries.size < remaining
        if (complete) {
            val expected = (database.metadataDao().get()?.nextJournalSequence ?: 1) - 1
            require(database.salesLedgerDao().count().toLong() == expected && state.ledgerCursor == expected) { "LOCAL_HISTORY_INCOMPLETE" }
            state = state.copy(captureError = null)
        }
        require(dao.updateBackfill(state) == 1)
        complete
    }

    fun recordCaptureFailure() = tx {
        dao.initBackfill(OutboxBackfill())
        require(dao.updateBackfill(dao.backfill()!!.copy(captureError = "LOCAL_HISTORY_INCOMPLETE")) == 1)
    }

    fun claim(scope: JSONObject, owner: String, now: Long, limit: Int = 100): List<OutboxEntry> = tx {
        val chain = identity().chainId
        require(scope.getString("chainId") == chain)
        dao.outstanding(chain,100).filter { it.lastAttemptAt != null && it.lastAttemptAt > now }.forEach {
            dao.update(it.copy(lastAttemptAt = now,nextAttemptAt = minOf(it.nextAttemptAt,now + 21600000),
                leaseExpiresAt = it.leaseExpiresAt?.let { expiry -> minOf(expiry,now + 120000) }))
        }
        dao.recoverExpired(chain,now)
        dao.resumeAuth(chain)
        if(dao.blockedCount(chain) > 0) return@tx emptyList()
        val candidates = dao.outstanding(chain,100)
        if(candidates.isEmpty()) return@tx emptyList()
        val first = candidates.first()
        if(first.status != "pending" || first.nextAttemptAt > now) return@tx emptyList()
        val claimed = mutableListOf<OutboxEntry>()
        for(row in candidates.take(minOf(limit,dao.backfill()?.batchLimit ?: 100))) {
            if(row.eventType != first.eventType || row.status != "pending" || row.nextAttemptAt > now) break
            if(row.sequence != null && claimed.isNotEmpty()) require(row.sequence == claimed.last().sequence!! + 1) { "MISSING_PREDECESSOR" }
            require(row.organizationId == null || (row.organizationId == scope.getString("organizationId") && row.festivalId == scope.getString("festivalId"))) { "SCOPE_CONFLICT" }
            val fingerprint = SyncProtocol.fingerprint(row,scope)
            require(row.transportFingerprint == null || row.transportFingerprint == fingerprint) { "FINGERPRINT_CONFLICT" }
            val bound = row.copy(organizationId = scope.getString("organizationId"),festivalId = scope.getString("festivalId"),
                transportFingerprint = fingerprint,status = "sending",claimOwner = owner,leaseExpiresAt = now + 120000,
                lastAttemptAt = now)
            require(dao.update(bound) == 1)
            claimed.add(bound)
        }
        claimed
    }

    fun renew(rows: List<OutboxEntry>, owner: String, now: Long) = tx {
        rows.forEach { row ->
            val current = dao.find(row.eventId)!!
            require(current.claimOwner == owner && current.status == "sending" && current.leaseExpiresAt!! > now)
            require(dao.update(current.copy(leaseExpiresAt = now + 120000)) == 1)
        }
    }

    fun markAttempt(rows: List<OutboxEntry>, owner: String, now: Long): List<OutboxEntry> = tx {
        rows.map { row ->
            val current = dao.find(row.eventId)!!
            require(current.claimOwner == owner && current.status == "sending")
            val attempted = current.copy(attemptCount = current.attemptCount + 1,lastAttemptAt = now)
            require(dao.update(attempted) == 1)
            attempted
        }
    }

    fun acknowledge(rows: List<OutboxEntry>, owner: String, request: JSONObject, response: JSONObject, now: Long) {
        val acks = SyncProtocol.validateAck(request,response)
        tx {
            if(rows.any { it.sequence != null }) dao.backfill()?.let { dao.updateBackfill(it.copy(recoveryAttempts = 0)) }
            rows.forEach { row ->
                val current = dao.find(row.eventId)!!
                require(current.status == "sending" && current.claimOwner == owner && current.transportFingerprint == row.transportFingerprint &&
                    current.payloadCanonical == row.payloadCanonical && current.chainId == row.chainId)
                val ack = acks[row.eventId]!!
                require(current.receiptId == null || (current.receiptId == ack.getString("receiptId") && current.serverReceivedAt == ack.getString("serverReceivedAt")))
                val confirmed = current.copy(status = "synced",attemptCount = 0,lastError = null,nextAttemptAt = 0,
                    claimOwner = null,leaseExpiresAt = null,receiptId = ack.getString("receiptId"),
                    serverReceivedAt = ack.getString("serverReceivedAt"),syncedAt = now)
                require(dao.update(confirmed) == 1)
                dao.saveDestination(OutboxDestination.from(dao.backfill()?.destinationId ?: "supabase", confirmed))
            }
        }
    }

    fun release(rows: List<OutboxEntry>, owner: String, status: String, code: String, next: Long) = tx {
        rows.forEach { row ->
            val current = dao.find(row.eventId)!!
            if(current.claimOwner == owner && current.status == "sending") {
                require(dao.update(current.copy(status = status,lastError = code,nextAttemptAt = next,claimOwner = null,leaseExpiresAt = null)) == 1)
            }
        }
    }

    fun setEnabled(enabled: Boolean) = tx {
        dao.initBackfill(OutboxBackfill())
        dao.updateBackfill(dao.backfill()!!.copy(enabled = enabled))
    }

    fun requestRecovery() = tx {
        dao.initBackfill(OutboxBackfill())
        val state = dao.backfill()!!
        dao.updateBackfill(state.copy(recoveryRequested = true,recoveryAttempts = 0))
    }

    // A manual wakeup never clears a conflict, a claim or a persisted backoff.
    fun canRetry(): Boolean = tx {
        val chain = identity().chainId
        dao.backfill()?.enabled != false && dao.backfill()?.captureError == null && dao.blockedCount(chain) == 0 &&
            dao.diagnosticEntries(chain).none { it.status == "sending" }
    }

    fun takeRecoveryRequest(): Boolean = tx {
        val state = dao.backfill() ?: return@tx false
        if(!state.recoveryRequested) return@tx false
        dao.updateBackfill(state.copy(recoveryRequested = false))
        true
    }

    fun allowAutomaticRecovery(): Boolean = tx {
        val state = dao.backfill()!!
        if(state.recoveryAttempts >= 1) return@tx false
        dao.updateBackfill(state.copy(recoveryAttempts = state.recoveryAttempts + 1))
        true
    }

    fun rewindBackfill() = tx {
        dao.initBackfill(OutboxBackfill())
        val state = dao.backfill()!!
        dao.updateBackfill(state.copy(ledgerCursor = 0,legacyCursor = "",legacyComplete = false))
    }

    fun resetBackfill() {
        dao.initBackfill(OutboxBackfill())
        val state = dao.backfill()!!
        require(dao.updateBackfill(state.copy(ledgerCursor = 0,legacyCursor = "",legacyComplete = false)) == 1)
    }

    fun bindPage(rows: List<OutboxEntry>, scope: JSONObject): List<OutboxEntry> = tx {
        rows.map { row ->
            val current = dao.find(row.eventId)!!
            require(current.organizationId == null || (current.organizationId == scope.getString("organizationId") && current.festivalId == scope.getString("festivalId")))
            val fingerprint = SyncProtocol.fingerprint(current,scope)
            require(current.transportFingerprint == null || current.transportFingerprint == fingerprint)
            val bound = current.copy(organizationId = scope.getString("organizationId"),festivalId = scope.getString("festivalId"),transportFingerprint = fingerprint)
            require(dao.update(bound) == 1)
            bound
        }
    }

    fun reduceBatch(chain: String): Boolean = tx {
        val state = dao.backfill()!!
        if(state.batchLimit <= 1) return@tx false
        dao.updateBackfill(state.copy(batchLimit = maxOf(1,state.batchLimit / 2)))
        dao.all(chain).filter { it.status == "needs_recovery" && it.lastError == "BATCH_TOO_LARGE" }.forEach {
            dao.update(it.copy(status = "pending",nextAttemptAt = 0))
        }
        true
    }

    fun blockChain(chain: String, status: String, code: String) = tx {
        val first = dao.outstanding(chain,1).firstOrNull()
        if(first != null && first.status != "sending") dao.update(first.copy(status = status,lastError = code))
    }

    fun requeueProvenPrefix(chain: String, includeLegacy: Boolean = false) = tx {
        dao.all(chain).filter { (it.sequence != null || includeLegacy) && it.status in setOf("synced","needs_recovery") }.forEach {
            // Diagnostic is not an ACK: replay and validate real receipts again.
            require(dao.update(it.copy(status = "pending",nextAttemptAt = 0,claimOwner = null,leaseExpiresAt = null)) == 1)
        }
    }

    fun diagnostics(): JSONObject = tx {
        val chain = identity()
        val rows = dao.diagnosticEntries(chain.chainId)
        val state = dao.backfill()
        val capturedLedger = rows.count { it.sequence != null }
        val capturedLegacy = rows.count { it.sequence == null }
        val backfillComplete = state?.legacyComplete == true && state.captureError == null && capturedLedger == database.salesLedgerDao().count() &&
            capturedLegacy == database.orderDao().legacyCount()
        val failures = rows.filter { it.status != "synced" &&
            (it.status in setOf("paused_auth","needs_recovery","quarantined") || (it.status == "pending" && it.lastError?.let { code -> code != "BATCH_DEFERRED" } == true)) }
        val errors = failures.size + if (state?.captureError != null) 1 else 0
        val lastFailure = failures.maxByOrNull { it.lastAttemptAt ?: 0 }
        val category = when {
            state?.captureError != null -> "conflict"
            failures.any { it.status in setOf("needs_recovery","quarantined") } -> "conflict"
            failures.any { it.status == "paused_auth" } -> "authentication"
            lastFailure?.lastError == "NETWORK_ERROR" -> "service_unreachable"
            failures.isNotEmpty() -> "temporary"
            else -> "none"
        }
        // Only receipts written by acknowledge() count, including historical receipts being replayed.
        val receipts = rows.filter { it.receiptId != null && it.syncedAt != null && it.serverReceivedAt != null }
        val received = receipts.maxByOrNull { Instant.parse(it.serverReceivedAt).toEpochMilli() }?.serverReceivedAt
        JSONObject().put("destinationId",state?.destinationId ?: "supabase").put("chainId",chain.chainId).put("enabled",state?.enabled ?: true).put("pendingEvents",rows.count { it.status != "synced" })
            .put("pending",rows.count { it.status == "pending" }).put("sending",rows.count { it.status == "sending" })
            .put("errors",errors).put("backfillComplete",backfillComplete)
            .put("continuity",if(!chain.restored && chain.bound && backfillComplete && errors == 0 && rows.all { it.status == "synced" && it.receiptId != null && it.syncedAt != null && it.serverReceivedAt != null }) "verified" else "unknown")
            .put("lastSuccessAt",receipts.mapNotNull { it.syncedAt }.maxOrNull() ?: JSONObject.NULL)
            .put("lastServerReceivedAt",received ?: JSONObject.NULL)
            .put("lastExchangeAt",JSONObject.NULL)
            .put("errorCategory",category)
            .put("lastError",state?.captureError ?: lastFailure?.lastError ?: JSONObject.NULL)
    }
}
