package __APP_PACKAGE__

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class OutboxWorker(context: Context, parameters: WorkerParameters) : Worker(context,parameters) {
    override fun doWork(): Result {
        return try {
            val database = SamhainPosDatabase.getInstance(applicationContext)
            val auth = TabletAuthService.get(applicationContext)
            val next = SyncEngine(database,{ auth.status() },auth::sendSync).drain()
            if(next != null) OutboxScheduler.continueDrain(applicationContext,next)
            Result.success()
        } catch (_: Exception) { Result.retry() }
    }
}

/** Safety scan covers the commit-to-enqueue window even without a WebView. */
class OutboxRescanWorker(context: Context, parameters: WorkerParameters) : Worker(context,parameters) {
    override fun doWork(): Result {
        OutboxScheduler.schedule(applicationContext)
        return Result.success()
    }
}

internal object OutboxScheduler {
    private val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private fun request(delay: Long) = OneTimeWorkRequestBuilder<OutboxWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setInitialDelay(delay.coerceAtLeast(0),TimeUnit.MILLISECONDS).build()

    fun enqueue(context: Context, chain: String, delay: Long = 0, continuation: Boolean = false): Operation =
        WorkManager.getInstance(context).enqueueUniqueWork("samhain-outbox-$chain",
            if(continuation) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP,request(delay))

    fun schedule(context: Context) {
        executor.execute {
            try {
                if(SupabaseConfiguration.load(context).status != "configured") return@execute
                val database = SamhainPosDatabase.getInstance(context)
                val chain = RoomOrderStore(database).syncIdentity().chainId
                val state = database.outboxDao().backfill()
                val needsBackfill = state == null || !state.legacyComplete || state.ledgerCursor < (database.metadataDao().get()?.nextJournalSequence ?: 1) - 1
                if(!needsBackfill && database.outboxDao().outstandingCount(chain) == 0) return@execute
                enqueue(context,chain)
            } catch (_: Exception) { /* The next startup/periodic scan reads the durable queue. */ }
        }
    }

    fun continueDrain(context: Context, next: Long) {
        val chain = RoomOrderStore(SamhainPosDatabase.getInstance(context)).syncIdentity().chainId
        enqueue(context,chain,next - System.currentTimeMillis(),true)
    }

    fun start(context: Context) {
        val app = context.applicationContext
        executor.execute {
            try {
                val store = OutboxStore(SamhainPosDatabase.getInstance(app))
                while(!store.backfillBatch()) { /* Each batch commits separately and allows new sales. */ }
                WorkManager.getInstance(app).enqueueUniquePeriodicWork("samhain-outbox-rescan",ExistingPeriodicWorkPolicy.KEEP,
                    PeriodicWorkRequestBuilder<OutboxRescanWorker>(15,TimeUnit.MINUTES).build())
                schedule(app)
            } catch (_: Exception) { /* Local checkout is independent of scheduler availability. */ }
        }
    }
}
