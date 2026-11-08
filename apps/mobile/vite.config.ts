import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * ONNX Runtime Web con hilos (SharedArrayBuffer) lanza sus hilos con *el mismo script* que cargó el módulo. Si el módulo
 * va incrustado en el paquete de la app, cada hilo arrancaría la aplicación entera (`document is not defined`) y la
 * inicialización se quedaría esperando para siempre. Por eso `.mjs` y `.wasm` se sirven como archivos propios en `ort/`
 * (y `configureOrt` apunta ahí) y se descarta la copia del `.wasm` que el empaquetador deja en `assets/` (~15 MB de más en el APK).
 */
function ortRuntimeFiles(): Plugin {
  const dist = path.dirname(createRequire(import.meta.url).resolve('onnxruntime-web/wasm')); // …/onnxruntime-web/dist
  const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
  return {
    name: 'starblitz-ort-runtime-files',
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!files.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(path.join(dist, name)).pipe(res);
      });
    },
    generateBundle(_options, bundle) {
      for (const name of files) this.emitFile({ type: 'asset', fileName: `ort/${name}`, source: fs.readFileSync(path.join(dist, name)) });
      for (const key of Object.keys(bundle)) if (/^assets\/ort-wasm-simd-threaded-[\w-]+\.wasm$/.test(key)) delete bundle[key];
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), ortRuntimeFiles()],
  resolve: {
    alias: { '@starblitz/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  worker: { format: 'es' }, // el Worker de visión es un módulo ES (importa onnxruntime-web)
  server: { port: 5174, strictPort: true, fs: { allow: ['..'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome110',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
});
