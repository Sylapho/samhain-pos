package fr.samhain.pos

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BackupPolicyTest {
    @Test
    fun applicationDoesNotAllowAndroidBackup() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val applicationInfo =
            context.packageManager.getApplicationInfo(context.packageName, 0)

        assertEquals(0, applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }
}
