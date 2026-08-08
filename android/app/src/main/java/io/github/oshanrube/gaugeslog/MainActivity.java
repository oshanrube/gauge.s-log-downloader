package io.github.oshanrube.gaugeslog;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(WifiBindPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
