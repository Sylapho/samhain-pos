package __APP_PACKAGE__

import androidx.room.*

/** Durable remote evidence; immutable financial tuples remain in outbox and the ledger. */
@Entity(tableName = "outbox_destinations", primaryKeys = ["destinationId", "eventId"])
data class OutboxDestination(
    val destinationId: String,
    val eventId: String,
    val chainId: String,
    val eventType: String,
    val organizationId: String?,
    val festivalId: String?,
    val transportFingerprint: String?,
    val status: String,
    val attemptCount: Int,
    val lastAttemptAt: Long?,
    val nextAttemptAt: Long,
    val lastError: String?,
    val claimOwner: String?,
    val leaseExpiresAt: Long?,
    val receiptId: String?,
    val serverReceivedAt: String?,
    val syncedAt: Long?,
) {
    fun applyTo(row: OutboxEntry): OutboxEntry {
        require(row.eventId == eventId && row.chainId == chainId && row.eventType == eventType)
        return row.copy(
            organizationId = organizationId,
            festivalId = festivalId,
            transportFingerprint = transportFingerprint,
            status = status,
            attemptCount = attemptCount,
            lastAttemptAt = lastAttemptAt,
            nextAttemptAt = nextAttemptAt,
            lastError = lastError,
            claimOwner = claimOwner,
            leaseExpiresAt = leaseExpiresAt,
            receiptId = receiptId,
            serverReceivedAt = serverReceivedAt,
            syncedAt = syncedAt,
        )
    }
    companion object {
        fun from(destination: String, row: OutboxEntry) = OutboxDestination(destination, row.eventId, row.chainId, row.eventType,
            row.organizationId,
            row.festivalId,
            row.transportFingerprint,
            row.status,
            row.attemptCount,
            row.lastAttemptAt,
            row.nextAttemptAt,
            row.lastError,
            row.claimOwner,
            row.leaseExpiresAt,
            row.receiptId,
            row.serverReceivedAt,
            row.syncedAt,
        )
    }
}
