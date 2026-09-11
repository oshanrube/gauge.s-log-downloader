package io.github.oshanrube.gaugeslog;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Hands a downloaded log straight to Car Doctor for offline fault analysis.
 *
 * Car Doctor accepts ACTION_SEND, so the ordinary share sheet already reaches it. This exists to
 * skip that sheet: one tap goes directly to the analyser instead of two taps through a list of
 * every app on the phone, and when Car Doctor is not installed the caller gets told so plainly
 * rather than finding it missing from a list.
 *
 * Package visibility matters here. From Android 11 an app cannot see, query or launch another
 * package unless it declares it in <queries> - so the entry for Car Doctor in AndroidManifest.xml
 * is what makes both {@link #isInstalled} and {@link #analyse} work at all on a modern phone.
 */
@CapacitorPlugin(name = "CarDoctor")
public class CarDoctorPlugin extends Plugin {

    private static final String CAR_DOCTOR_PACKAGE = "dev.cardoctor.app";
    private static final String RELEASES_URL = "https://github.com/oshanrube/car-doctor/releases/latest";

    /**
     * The type is set explicitly rather than derived from the file name. Android's MimeTypeMap
     * resolves .csv to text/csv on some versions and text/comma-separated-values on others, and
     * there is no reason to leave that to chance when we know what we are sending.
     */
    private static final String CSV_MIME = "text/csv";

    private boolean carDoctorInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(CAR_DOCTOR_PACKAGE, 0);
            return true;
        } catch (Exception notInstalled) {
            return false;
        }
    }

    private JSObject notInstalledResult() {
        JSObject result = new JSObject();
        result.put("installed", false);
        result.put("downloadUrl", RELEASES_URL);
        return result;
    }

    @PluginMethod
    public void isInstalled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("installed", carDoctorInstalled());
        result.put("downloadUrl", RELEASES_URL);
        call.resolve(result);
    }

    @PluginMethod
    public void analyse(PluginCall call) {
        String fileUrl = call.getString("uri");
        if (fileUrl == null || fileUrl.isEmpty()) {
            call.reject("No log file was supplied");
            return;
        }

        if (!carDoctorInstalled()) {
            call.resolve(notInstalledResult());
            return;
        }

        try {
            // The Filesystem plugin hands back a file:// path, which another app cannot read.
            // It has to go out as a content:// URI from our own FileProvider - the same one the
            // share sheet already uses, so every directory the app saves to is already declared
            // in file_paths.xml.
            Uri content = FileProvider.getUriForFile(
                getActivity(),
                getContext().getPackageName() + ".fileprovider",
                new File(Uri.parse(fileUrl).getPath())
            );

            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setPackage(CAR_DOCTOR_PACKAGE);
            intent.setType(CSV_MIME);
            intent.putExtra(Intent.EXTRA_STREAM, content);
            // Grants read access for the life of the receiving task, which Car Doctor needs
            // because it reads the log twice: once to calibrate, once to analyse.
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            getActivity().startActivity(intent);

            JSObject result = new JSObject();
            result.put("installed", true);
            call.resolve(result);
        } catch (ActivityNotFoundException absent) {
            // Installed but with no matching activity - an old build without the SEND filter.
            call.resolve(notInstalledResult());
        } catch (Exception err) {
            call.reject("Could not open Car Doctor: " + err.getMessage(), err);
        }
    }
}
