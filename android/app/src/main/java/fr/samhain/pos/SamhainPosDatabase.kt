package fr.samhain.pos

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(
    tableName = "orders",
    indices = [
        Index(value = ["order_number"], unique = true),
        Index(value = ["receipt_number"], unique = true),
        Index(value = ["created_at"]),
        Index(value = ["paid_at"]),
        Index(value = ["terminal_id"]),
        Index(value = ["payment_status"]),
        Index(value = ["sync_status"]),
    ],
)
data class OrderEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "order_number") val orderNumber: String,
    @ColumnInfo(name = "receipt_number") val receiptNumber: String,
    @ColumnInfo(name = "terminal_id") val terminalId: String?,
    @ColumnInfo(name = "terminal_code") val terminalCode: String?,
    @ColumnInfo(name = "terminal_name") val terminalName: String?,
    @ColumnInfo(name = "register_name") val registerName: String?,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "paid_at") val paidAt: String,
    @ColumnInfo(name = "payment_method") val paymentMethod: String,
    @ColumnInfo(name = "payment_status") val paymentStatus: String,
    @ColumnInfo(name = "item_count") val itemCount: Int,
    @ColumnInfo(name = "total_cents") val totalCents: Long,
    val status: String,
    @ColumnInfo(name = "items_json") val itemsJson: String,
    @ColumnInfo(name = "immutable_payload_json") val immutablePayloadJson: String,
    @ColumnInfo(name = "integrity_algorithm") val integrityAlgorithm: String?,
    @ColumnInfo(name = "integrity_entry_id") val integrityEntryId: String?,
    @ColumnInfo(name = "integrity_sequence") val integritySequence: Long?,
    @ColumnInfo(name = "integrity_hash") val integrityHash: String?,
    @ColumnInfo(name = "sync_status") val syncStatus: String = "pending",
    @ColumnInfo(name = "sync_attempts") val syncAttempts: Int = 0,
    @ColumnInfo(name = "sync_last_error") val syncLastError: String? = null,
    @ColumnInfo(name = "synced_at") val syncedAt: String? = null,
)

@Entity(
    tableName = "order_printing",
    foreignKeys = [
        ForeignKey(
            entity = OrderEntity::class,
            parentColumns = ["id"],
            childColumns = ["order_id"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["status"]), Index(value = ["updated_at"])],
)
data class OrderPrintingEntity(
    @PrimaryKey @ColumnInfo(name = "order_id") val orderId: String,
    val status: String,
    @ColumnInfo(name = "customer_receipt") val customerReceipt: String,
    @ColumnInfo(name = "preparation_ticket") val preparationTicket: String,
    val attempts: Int,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "last_error") val lastError: String?,
)

@Entity(
    tableName = "sales_ledger",
    indices = [
        Index(value = ["sequence"], unique = true),
        Index(value = ["kind"]),
        Index(value = ["recorded_at"]),
        Index(value = ["order_id"]),
        Index(value = ["source_terminal_id"]),
        Index(value = ["hash"], unique = true),
    ],
)
data class SalesLedgerEntity(
    @PrimaryKey val id: String,
    val sequence: Long,
    val kind: String,
    @ColumnInfo(name = "recorded_at") val recordedAt: String,
    @ColumnInfo(name = "previous_hash") val previousHash: String?,
    @ColumnInfo(name = "source_terminal_id") val sourceTerminalId: String?,
    @ColumnInfo(name = "order_id") val orderId: String?,
    val hash: String,
    @ColumnInfo(name = "payload_json") val payloadJson: String,
)

@Entity(tableName = "pos_metadata")
data class PosMetadataEntity(
    @PrimaryKey val id: Int = SINGLETON_ID,
    @ColumnInfo(name = "next_order_sequence") val nextOrderSequence: Long = 1,
    @ColumnInfo(name = "next_receipt_sequence") val nextReceiptSequence: Long = 1,
    @ColumnInfo(name = "next_journal_sequence") val nextJournalSequence: Long = 1,
    @ColumnInfo(name = "last_journal_hash") val lastJournalHash: String? = null,
    @ColumnInfo(name = "last_closure_end") val lastClosureEnd: String? = null,
    @ColumnInfo(name = "legacy_migration_completed") val legacyMigrationCompleted: Boolean = false,
    @ColumnInfo(name = "legacy_migration_completed_at") val legacyMigrationCompletedAt: String? = null,
) {
    companion object {
        const val SINGLETON_ID = 1
    }
}

@Dao
interface OrderDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(order: OrderEntity)

    @Query("SELECT * FROM orders WHERE id = :id")
    fun findById(id: String): OrderEntity?

    @Query("SELECT * FROM orders ORDER BY created_at ASC, id ASC")
    fun getAll(): List<OrderEntity>

    @Query("SELECT COUNT(*) FROM orders")
    fun count(): Int
}

@Dao
interface OrderPrintingDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(printing: OrderPrintingEntity)

    @Update
    fun update(printing: OrderPrintingEntity): Int

    @Query("SELECT * FROM order_printing WHERE order_id = :orderId")
    fun findByOrderId(orderId: String): OrderPrintingEntity?

    @Query("SELECT * FROM order_printing ORDER BY order_id ASC")
    fun getAll(): List<OrderPrintingEntity>
}

@Dao
interface SalesLedgerDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(entry: SalesLedgerEntity)

    @Query("SELECT * FROM sales_ledger WHERE id = :id")
    fun findById(id: String): SalesLedgerEntity?

    @Query("SELECT * FROM sales_ledger WHERE sequence = :sequence")
    fun findBySequence(sequence: Long): SalesLedgerEntity?

    @Query("SELECT * FROM sales_ledger ORDER BY sequence ASC")
    fun getAll(): List<SalesLedgerEntity>

    @Query("SELECT COUNT(*) FROM sales_ledger")
    fun count(): Int
}

@Dao
interface PosMetadataDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertIfMissing(metadata: PosMetadataEntity): Long

    @Update
    fun update(metadata: PosMetadataEntity): Int

    @Query("SELECT * FROM pos_metadata WHERE id = 1")
    fun get(): PosMetadataEntity?
}

@Database(
    entities = [
        OrderEntity::class,
        OrderPrintingEntity::class,
        SalesLedgerEntity::class,
        PosMetadataEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
abstract class SamhainPosDatabase : RoomDatabase() {
    abstract fun orderDao(): OrderDao

    abstract fun orderPrintingDao(): OrderPrintingDao

    abstract fun salesLedgerDao(): SalesLedgerDao

    abstract fun metadataDao(): PosMetadataDao

    companion object {
        const val DATABASE_NAME = "samhain-pos-room.db"

        val MIGRATION_1_2 =
            object : Migration(1, 2) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        "ALTER TABLE orders ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'",
                    )
                    db.execSQL(
                        "ALTER TABLE orders ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0",
                    )
                    db.execSQL("ALTER TABLE orders ADD COLUMN sync_last_error TEXT")
                    db.execSQL("ALTER TABLE orders ADD COLUMN synced_at TEXT")
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_orders_sync_status ON orders(sync_status)",
                    )
                    db.execSQL(
                        "ALTER TABLE pos_metadata ADD COLUMN legacy_migration_completed INTEGER NOT NULL DEFAULT 0",
                    )
                    db.execSQL(
                        "ALTER TABLE pos_metadata ADD COLUMN legacy_migration_completed_at TEXT",
                    )
                }
            }

        @Volatile private var instance: SamhainPosDatabase? = null

        fun getInstance(context: Context): SamhainPosDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    SamhainPosDatabase::class.java,
                    DATABASE_NAME,
                ).addMigrations(MIGRATION_1_2)
                    .build()
                    .also { instance = it }
            }
    }
}

