import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.starblitz.mobile',
  appName: 'STARBLITZ',
  webDir: 'dist',
  backgroundColor: '#060818',
  server: {
    // Origen http://localhost: sigue siendo un contexto seguro (necesario para SharedArrayBuffer y OPFS) y permite hablar
    // con el servidor de modelos de la propia app (http://127.0.0.1) sin contenido mixto. El resto del tráfico sale por
    // HTTPS: `network_security_config.xml` solo admite HTTP en claro hacia 127.0.0.1 y localhost.
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 900, backgroundColor: '#060818', showSpinner: false, androidScaleType: 'CENTER_INSIDE' },
    StatusBar: { style: 'DARK', backgroundColor: '#060818', overlaysWebView: false },
  },
};

export default config;
