package fr.samhain.pos;

import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EpsonUsbPrinterPlugin.class);
        super.onCreate(savedInstanceState);

        allowContentInDisplayCutout();
        applyImmersiveMode();
    }

    @Override
    public void onResume() {
        super.onResume();
        getWindow().getDecorView().post(this::applyImmersiveMode);
        startManagedLockTaskIfPermitted();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            getWindow().getDecorView().post(this::applyImmersiveMode);
        }
    }

    private void applyImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        WindowInsetsControllerCompat insetsController =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        insetsController.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );
        insetsController.hide(WindowInsetsCompat.Type.systemBars());
    }

    private void allowContentInDisplayCutout() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return;
        }

        WindowManager.LayoutParams layoutParams = getWindow().getAttributes();
        layoutParams.layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        getWindow().setAttributes(layoutParams);
    }

    private void startManagedLockTaskIfPermitted() {
        DevicePolicyManager devicePolicyManager =
            (DevicePolicyManager) getSystemService(Context.DEVICE_POLICY_SERVICE);
        ActivityManager activityManager =
            (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);

        if (
            devicePolicyManager != null
                && activityManager != null
                && devicePolicyManager.isLockTaskPermitted(getPackageName())
                && activityManager.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE
        ) {
            startLockTask();
        }
    }
}
