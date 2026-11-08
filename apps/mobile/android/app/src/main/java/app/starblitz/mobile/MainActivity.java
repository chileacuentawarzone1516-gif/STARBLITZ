package app.starblitz.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // El plugin nativo de STARBLITZ (archivos, descargas, motor de lenguaje, estado del teléfono) se registra antes de crear el puente.
        registerPlugin(StarblitzNativePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void load() {
        super.load();
        if (bridge != null) bridge.setWebViewClient(new IsolatedWebViewClient(bridge));
    }
}
