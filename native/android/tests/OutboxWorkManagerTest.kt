package __APP_PACKAGE__

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OutboxWorkManagerTest {
    @Test fun repeatedWakeupsKeepOneChainJobAndContinuationWaitsForItsParent() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        WorkManagerTestInitHelper.initializeTestWorkManager(context,Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        val chain = UUID.randomUUID().toString()
        OutboxScheduler.enqueue(context,chain).result.get()
        OutboxScheduler.enqueue(context,chain).result.get()
        val manager = WorkManager.getInstance(context)
        val first = manager.getWorkInfosForUniqueWork("samhain-outbox-$chain").get()
        assertEquals(1,first.size)
        assertEquals(WorkInfo.State.ENQUEUED,first.single().state)
        OutboxScheduler.enqueue(context,chain,60000,true).result.get()
        val jobs = manager.getWorkInfosForUniqueWork("samhain-outbox-$chain").get()
        assertEquals(2,jobs.size)
        assertEquals(setOf(WorkInfo.State.ENQUEUED,WorkInfo.State.BLOCKED),jobs.map { it.state }.toSet())
        manager.cancelUniqueWork("samhain-outbox-$chain").result.get()
    }
}
