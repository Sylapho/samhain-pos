package fr.samhain.pos

import androidx.room.*

@Entity(tableName = "outbox", indices = [
    Index(value = ["chainId", "eventId"], unique = true),
    Index(value = ["chainId", "sequence"], unique = true),
    Index(value = ["status", "nextAttemptAt"]),
])
data class OutboxEntry(
    @PrimaryKey val eventId: String,
    val chainId: String,
    val eventType: String,
    val kind: String,
    val entityId: String,
    val sourceTerminalId: String?,
    val sequence: Long?,
    val hash: String?,
    val previousHash: String?,
    val payloadCanonical: String,
    val ledgerCanonicalization: String?,
    val organizationId: String? = null,
    val festivalId: String? = null,
    val transportFingerprint: String? = null,
    val status: String = "pending",
    val attemptCount: Int = 0,
    val lastAttemptAt: Long? = null,
    val nextAttemptAt: Long = 0,
    val lastError: String? = null,
    val claimOwner: String? = null,
    val leaseExpiresAt: Long? = null,
    val receiptId: String? = null,
    val serverReceivedAt: String? = null,
    val syncedAt: Long? = null,
)

@Entity(tableName = "outbox_backfill")
data class OutboxBackfill(
    @PrimaryKey val id: Int = 1,
    val ledgerCursor: Long = 0,
    val legacyCursor: String = "",
    val legacyComplete: Boolean = false,
    val batchLimit: Int = 100,
    val recoveryAttempts: Int = 0,
    val recoveryRequested: Boolean = false,
    val enabled: Boolean = true,
)

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insert(entry: OutboxEntry)
    @Update fun update(entry: OutboxEntry): Int
    @Query("SELECT * FROM outbox WHERE eventId = :id") fun find(id: String): OutboxEntry?
    @Query("SELECT * FROM outbox WHERE chainId = :chain ORDER BY sequence ASC, eventId ASC")
    fun all(chain: String): List<OutboxEntry>
    @Query("SELECT sequence, status, lastError, lastAttemptAt, receiptId, serverReceivedAt, syncedAt FROM outbox WHERE chainId = :chain")
    fun diagnosticEntries(chain: String): List<OutboxDiagnosticEntry>
    @Query("SELECT * FROM outbox WHERE chainId = :chain AND status != 'synced' ORDER BY sequence ASC, eventId ASC LIMIT :limit")
    fun outstanding(chain: String, limit: Int): List<OutboxEntry>
    @Query("SELECT * FROM outbox WHERE chainId = :chain AND sequence > :cursor ORDER BY sequence ASC LIMIT :limit")
    fun ledgerPage(chain: String, cursor: Long, limit: Int): List<OutboxEntry>
    @Query("SELECT COUNT(*) FROM outbox WHERE chainId = :chain AND status != 'synced'")
    fun outstandingCount(chain: String): Int
    @Query("SELECT COUNT(*) FROM outbox WHERE chainId = :chain AND status IN ('quarantined', 'needs_recovery')")
    fun blockedCount(chain: String): Int
    @Query("UPDATE outbox SET chainId = :chain WHERE transportFingerprint IS NULL")
    fun bindUnassigned(chain: String)
    @Query("UPDATE outbox SET status = 'pending', claimOwner = NULL, leaseExpiresAt = NULL WHERE chainId = :chain AND status = 'sending' AND leaseExpiresAt <= :now")
    fun recoverExpired(chain: String, now: Long)
    @Query("UPDATE outbox SET status = 'pending', nextAttemptAt = 0 WHERE chainId = :chain AND status = 'paused_auth'")
    fun resumeAuth(chain: String)
    @Query("SELECT MAX(syncedAt) FROM outbox WHERE chainId = :chain") fun lastSuccess(chain: String): Long?
    @Query("SELECT * FROM outbox WHERE chainId = :chain AND lastError IS NOT NULL ORDER BY lastAttemptAt DESC LIMIT 1")
    fun lastFailure(chain: String): OutboxEntry?
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun initBackfill(state: OutboxBackfill): Long
    @Update fun updateBackfill(state: OutboxBackfill): Int
    @Query("SELECT * FROM outbox_backfill WHERE id = 1") fun backfill(): OutboxBackfill?
}

// Polling the responsible screen must not load every immutable financial payload.
data class OutboxDiagnosticEntry(
    val sequence: Long?,
    val status: String,
    val lastError: String?,
    val lastAttemptAt: Long?,
    val receiptId: String?,
    val serverReceivedAt: String?,
    val syncedAt: Long?,
)
