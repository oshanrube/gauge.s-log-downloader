package io.github.oshanrube.gaugeslog;

import android.content.Context;
import android.os.PowerManager;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the phone working through a download.
 *
 * Two different things interrupt a run, so both are held off:
 *
 *  - FLAG_KEEP_SCREEN_ON stops the display timing out. That alone covers the
 *    usual case, where the download simply outlasts the screen timeout.
 *  - A PARTIAL_WAKE_LOCK keeps the CPU alive if the screen goes off anyway,
 *    e.g. the user presses the power button and pockets the phone. Without it
 *    Android suspends the process and the transfer stalls mid-file.
 *
 * The wake lock is acquired with a timeout so a missed release cannot drain the
 * battery indefinitely — a stuck lock is a far worse bug than a stalled
 * download.
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    /** Generous for a log download, short enough to bound any mistake. */
    private static final long MAX_HOLD_MS = 30 * 60 * 1000L;

    private PowerManager.WakeLock wakeLock;

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final android.app.Activity activity = getActivity();
        if (activity != null) {
            // Window flags must be touched on the UI thread.
            activity.runOnUiThread(() ->
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            );
        }

        boolean cpuHeld = false;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            try {
                releaseWakeLock();
                wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GaugeS:download");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(MAX_HOLD_MS);
                cpuHeld = true;
            } catch (Exception e) {
                // Screen-on alone still covers the common case.
                wakeLock = null;
            }
        }

        JSObject ret = new JSObject();
        ret.put("screen", activity != null);
        ret.put("cpu", cpuHeld);
        call.resolve(ret);
    }

    @PluginMethod
    public void allowSleep(PluginCall call) {
        final android.app.Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() ->
                activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            );
        }
        releaseWakeLock();
        call.resolve();
    }

    private void releaseWakeLock() {
        if (wakeLock == null) return;
        try {
            if (wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // Already released, or never really held.
        }
        wakeLock = null;
    }

    @Override
    protected void handleOnDestroy() {
        releaseWakeLock();
        super.handleOnDestroy();
    }
}
