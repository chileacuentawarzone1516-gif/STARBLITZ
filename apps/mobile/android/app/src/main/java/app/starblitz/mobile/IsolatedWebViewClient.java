package app.starblitz.mobile;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

/**
 * Añade a lo que sirve la propia app las cabeceras que aíslan el origen (COOP + COEP). Con ellas la WebView activa
 * {@code SharedArrayBuffer} y ONNX Runtime puede usar varios hilos de WebAssembly: la visión (detección de texto y OCR)
 * va entre 2 y 4 veces más rápida en un móvil con 8 núcleos. Sin ellas todo funciona igual, con un solo hilo.
 * {@code credentialless} evita romper recursos de terceros que no envían CORP.
 */
final class IsolatedWebViewClient extends BridgeWebViewClient {
    IsolatedWebViewClient(Bridge bridge) { super(bridge); }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse response = super.shouldInterceptRequest(view, request);
        if (response == null) return null;
        Map<String, String> headers = response.getResponseHeaders();
        headers = headers == null ? new HashMap<>() : new HashMap<>(headers);
        headers.put("Cross-Origin-Opener-Policy", "same-origin");
        headers.put("Cross-Origin-Embedder-Policy", "credentialless");
        response.setResponseHeaders(headers);
        return response;
    }
}
