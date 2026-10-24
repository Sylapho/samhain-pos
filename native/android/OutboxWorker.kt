package __APP_PACKAGE__

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class OutboxWorker(context: Context, parameters: WorkerParameters) : Worker(context,parameters) {
    override fun doWork(): Result {
        return try {
            val database = SamhainPosDatabase.getInstance(applicationContext)
            val config = ApiAuthConfiguration.load(applicationContext)
            if (config.status != "configured") return Result.success()
            val auth = ApiTabletAuthService.get(applicationContext)
            val next = SyncEngine(database,{ auth.status() },auth::sendSync,destination = config.destinationId).drain()
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
                val config = ApiAuthConfiguration.load(context)
                if(config.status != "configured") return@execute
                val database = SamhainPosDatabase.getInstance(context)
                OutboxStore(database,config.destinationId).selectDestination()
                val chain = RoomOrderStore(database).syncIdentity().chainId
                val state = database.outboxDao().backfill()
                if(state?.captureError != null) return@execute
                if(state?.enabled == false || (database.outboxDao().blockedCount(chain) > 0 && state?.recoveryRequested != true)) return@execute
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
                WorkManager.getInstance(app).enqueueUniquePeriodicWork("samhain-outbox-rescan",ExistingPeriodicWorkPolicy.KEEP,
                    PeriodicWorkRequestBuilder<OutboxRescanWorker>(15,TimeUnit.MINUTES).build())
                val config = ApiAuthConfiguration.load(app)
                val store = OutboxStore(SamhainPosDatabase.getInstance(app),config.destinationId)
                store.selectDestination()
                try { while(!store.backfillBatch()) { /* Local capture in bounded commits. */ } }
                catch (_: Exception) { store.recordCaptureFailure() }
                schedule(app)
            } catch (_: Exception) { /* Local checkout is independent of scheduler availability. */ }
        }
    }
}
