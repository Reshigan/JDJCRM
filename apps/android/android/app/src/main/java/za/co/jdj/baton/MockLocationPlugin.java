package za.co.jdj.baton;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.CancellationSignal;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * A fresh GPS fix plus whether Android reports it as coming from a mock-location app.
 * The web app refuses geofenced checkpoints while mock is true (brief §6.3: prove the nurse was there).
 */
@CapacitorPlugin(name = "MockLocation", permissions = { @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location") })
public class MockLocationPlugin extends Plugin {

    @PluginMethod
    public void getPosition(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "onPermission");
            return;
        }
        read(call);
    }

    @PermissionCallback
    private void onPermission(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) read(call);
        else call.reject("Location permission denied");
    }

    @SuppressLint("MissingPermission")
    private void read(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 30) {
            lm.getCurrentLocation(LocationManager.GPS_PROVIDER, new CancellationSignal(), getContext().getMainExecutor(), (loc) -> resolve(call, loc));
        } else {
            resolve(call, lm.getLastKnownLocation(LocationManager.GPS_PROVIDER));
        }
    }

    private void resolve(PluginCall call, Location loc) {
        if (loc == null) {
            call.reject("No GPS fix yet");
            return;
        }
        JSObject r = new JSObject();
        r.put("lat", loc.getLatitude());
        r.put("lng", loc.getLongitude());
        r.put("accuracy", loc.getAccuracy());
        r.put("mock", Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider());
        call.resolve(r);
    }
}
