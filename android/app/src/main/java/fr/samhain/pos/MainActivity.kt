package fr.samhain.pos

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(EpsonUsbPrinterPlugin::class.java)
        super.onCreate(savedInstanceState)

        allowContentInDisplayCutout()
        applyImmersiveMode()
    }

    override fun onResume() {
        super.onResume()
        window.decorView.post(::applyImmersiveMode)
        startManagedLockTaskIfPermitted()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            window.decorView.post(::applyImmersiveMode)
        }
    }

    private fun applyImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)

        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun allowContentInDisplayCutout() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return

        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    private fun startManagedLockTaskIfPermitted() {
        val devicePolicyManager =
            getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        val activityManager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager

        if (
            devicePolicyManager?.isLockTaskPermitted(packageName) == true &&
                activityManager?.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE
        ) {
            startLockTask()
        }
    }
}
