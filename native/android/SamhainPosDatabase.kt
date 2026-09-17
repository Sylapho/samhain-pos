package __APP_PACKAGE__

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
    @ColumnInfo(name = "pickup_ticket") val pickupTicket: String,
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

@Entity(
    tableName = "checkout_intents",
    indices = [
        Index(value = ["status"]),
        Index(value = ["created_at"]),
        Index(value = ["updated_at"]),
        Index(value = ["finalized_order_id"], unique = true),
    ],
)
data class CheckoutIntentEntity(
    @PrimaryKey val id: String,
    val status: String,
    @ColumnInfo(name = "created_at") val createdAt: String,
    @ColumnInfo(name = "updated_at") val updatedAt: String,
    @ColumnInfo(name = "payment_method") val paymentMethod: String,
    @ColumnInfo(name = "total_cents") val totalCents: Long,
    @ColumnInfo(name = "finalized_order_id") val finalizedOrderId: String?,
    @ColumnInfo(name = "payload_json") val payloadJson: String,
)

@Entity(
    tableName = "products",
    indices = [
        Index(value = ["active"]),
        Index(value = ["category_id"]),
        Index(value = ["display_order"]),
    ],
)
data class ProductEntity(
    @PrimaryKey val id: String,
    val name: String,
    @ColumnInfo(name = "category_id") val categoryId: String,
    @ColumnInfo(name = "price_cents") val priceCents: Long?,
    @ColumnInfo(name = "vat_rate") val vatRate: Int,
    val availability: String,
    val active: Boolean,
    @ColumnInfo(name = "display_order") val displayOrder: Int,
    @ColumnInfo(name = "product_json") val productJson: String,
)

@Entity(tableName = "catalog_metadata")
data class CatalogMetadataEntity(
    @PrimaryKey val id: Int = SINGLETON_ID,
    @ColumnInfo(name = "initialized_at") val initializedAt: String,
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

@Dao
interface CheckoutIntentDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(intent: CheckoutIntentEntity)

    @Update
    fun update(intent: CheckoutIntentEntity): Int

    @Query("SELECT * FROM checkout_intents WHERE id = :id")
    fun findById(id: String): CheckoutIntentEntity?

    @Query("SELECT * FROM checkout_intents ORDER BY created_at ASC, id ASC")
    fun getAll(): List<CheckoutIntentEntity>
}

@Dao
interface ProductDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(product: ProductEntity)

    @Update
    fun update(product: ProductEntity): Int

    @Query("SELECT * FROM products WHERE id = :id")
    fun findById(id: String): ProductEntity?

    @Query("SELECT * FROM products ORDER BY display_order ASC, name ASC, id ASC")
    fun getAll(): List<ProductEntity>

    @Query("SELECT * FROM products WHERE active = 1 AND availability = 'available' ORDER BY display_order ASC, name ASC, id ASC")
    fun getSellable(): List<ProductEntity>

    @Query("SELECT COUNT(*) FROM products")
    fun count(): Int
}

@Dao
interface CatalogMetadataDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    fun insert(metadata: CatalogMetadataEntity)

    @Query("SELECT * FROM catalog_metadata WHERE id = 1")
    fun get(): CatalogMetadataEntity?
}

@Database(
    entities = [
        OrderEntity::class,
        OrderPrintingEntity::class,
        SalesLedgerEntity::class,
        PosMetadataEntity::class,
        CheckoutIntentEntity::class,
        ProductEntity::class,
        CatalogMetadataEntity::class,
    ],
    version = 5,
    exportSchema = true,
)
abstract class SamhainPosDatabase : RoomDatabase() {
    abstract fun orderDao(): OrderDao

    abstract fun orderPrintingDao(): OrderPrintingDao

    abstract fun salesLedgerDao(): SalesLedgerDao

    abstract fun metadataDao(): PosMetadataDao

    abstract fun checkoutIntentDao(): CheckoutIntentDao

    abstract fun productDao(): ProductDao

    abstract fun catalogMetadataDao(): CatalogMetadataDao

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

        val MIGRATION_2_3 =
            object : Migration(2, 3) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        """
                        CREATE TABLE IF NOT EXISTS checkout_intents (
                            id TEXT NOT NULL PRIMARY KEY,
                            status TEXT NOT NULL,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            payment_method TEXT NOT NULL,
                            total_cents INTEGER NOT NULL,
                            finalized_order_id TEXT,
                            payload_json TEXT NOT NULL
                        )
                        """.trimIndent(),
                    )
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_checkout_intents_status ON checkout_intents(status)",
                    )
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_checkout_intents_created_at ON checkout_intents(created_at)",
                    )
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_checkout_intents_updated_at ON checkout_intents(updated_at)",
                    )
                    db.execSQL(
                        "CREATE UNIQUE INDEX IF NOT EXISTS index_checkout_intents_finalized_order_id ON checkout_intents(finalized_order_id)",
                    )
                }
            }

        val MIGRATION_3_4 =
            object : Migration(3, 4) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        "ALTER TABLE order_printing ADD COLUMN pickup_ticket TEXT NOT NULL DEFAULT 'unknown'",
                    )
                }
            }

        val MIGRATION_4_5 =
            object : Migration(4, 5) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL(
                        """
                        CREATE TABLE IF NOT EXISTS products (
                            id TEXT NOT NULL PRIMARY KEY,
                            name TEXT NOT NULL,
                            category_id TEXT NOT NULL,
                            price_cents INTEGER,
                            vat_rate INTEGER NOT NULL,
                            availability TEXT NOT NULL,
                            active INTEGER NOT NULL,
                            display_order INTEGER NOT NULL,
                            product_json TEXT NOT NULL
                        )
                        """.trimIndent(),
                    )
                    db.execSQL("CREATE INDEX IF NOT EXISTS index_products_active ON products(active)")
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_products_category_id ON products(category_id)",
                    )
                    db.execSQL(
                        "CREATE INDEX IF NOT EXISTS index_products_display_order ON products(display_order)",
                    )
                    db.execSQL(
                        """
                        CREATE TABLE IF NOT EXISTS catalog_metadata (
                            id INTEGER NOT NULL PRIMARY KEY,
                            initialized_at TEXT NOT NULL
                        )
                        """.trimIndent(),
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
                ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5)
                    .build()
                    .also { instance = it }
            }
    }
}

