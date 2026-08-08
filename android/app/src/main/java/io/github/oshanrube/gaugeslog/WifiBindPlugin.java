package io.github.oshanrube.gaugeslog;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Pins this process's sockets to the Wi-Fi network.
 *
 * The Gauge.S device runs an access point with no internet uplink. Android
 * notices the dead uplink and keeps mobile data as the *default* network, so
 * an ordinary HTTP request to 192.168.4.1 is handed to the cellular interface
 * and fails — even though the phone is associated with the Gauge.S AP.
 *
 * bindProcessToNetwork() forces every socket opened by this app (including the
 * ones CapacitorHttp opens for the device requests) onto the Wi-Fi transport,
 * which is what makes the device reachable while "no internet" is showing.
 *
 * Everything here is best-effort: if binding fails the app still works
 * whenever Wi-Fi happens to be the default network anyway.
 */
@CapacitorPlugin(name = "WifiBind")
public class WifiBindPlugin extends Plugin {

    private ConnectivityManager.NetworkCallback callback;

    private ConnectivityManager connectivity() {
        return (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    @PluginMethod
    public void bind(final PluginCall call) {
        final ConnectivityManager cm = connectivity();
        if (cm == null) {
            call.resolve(result(false, "ConnectivityManager unavailable"));
            return;
        }

        // Already bound — releasing first keeps repeated calls idempotent.
        releaseCallback(cm);

        // NET_CAPABILITY_INTERNET is dropped deliberately: the Gauge.S access
        // point has no uplink, so a request that insists on internet would
        // never match it — which is the exact network we need.
        NetworkRequest request = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build();

        callback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                cm.bindProcessToNetwork(network);
            }

            @Override
            public void onLost(Network network) {
                cm.bindProcessToNetwork(null);
            }
        };

        try {
            // requestNetwork brings up / selects a Wi-Fi network for this process
            // even when the system default stays on cellular.
            cm.requestNetwork(request, callback);
        } catch (SecurityException e) {
            callback = null;
            call.resolve(result(false, "Missing network permission: " + e.getMessage()));
            return;
        }

        // Bind immediately if a Wi-Fi network is already up, so the first
        // request after startup doesn't race the callback.
        boolean boundNow = false;
        for (Network network : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                boundNow = cm.bindProcessToNetwork(network);
                break;
            }
        }

        call.resolve(result(true, boundNow ? "Bound to Wi-Fi" : "Waiting for Wi-Fi"));
    }

    @PluginMethod
    public void unbind(PluginCall call) {
        ConnectivityManager cm = connectivity();
        if (cm != null) {
            releaseCallback(cm);
            cm.bindProcessToNetwork(null);
        }
        call.resolve(result(true, "Unbound"));
    }

    private void releaseCallback(ConnectivityManager cm) {
        if (callback == null) return;
        try {
            cm.unregisterNetworkCallback(callback);
        } catch (IllegalArgumentException ignored) {
            // Not registered — nothing to undo.
        }
        callback = null;
    }

    @Override
    protected void handleOnDestroy() {
        ConnectivityManager cm = connectivity();
        if (cm != null) releaseCallback(cm);
        super.handleOnDestroy();
    }

    private JSObject result(boolean ok, String message) {
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        ret.put("message", message);
        ret.put("sdk", Build.VERSION.SDK_INT);
        return ret;
    }
}
