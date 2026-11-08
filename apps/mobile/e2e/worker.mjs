// E2E del camino que usa Android: el motor de visión en un Web Worker (el mismo `visionWorker.entry` del APK), con
// ONNX Runtime con hilos (página aislada), modelos leídos por URL y comunicación por mensajes. Todo real.
// Detecta el fallo que dejaba el análisis colgado: los hilos de WebAssembly arrancaban el paquete de la app en vez del runtime.
// Uso: node worker.mjs <carpeta_de_trabajo> <carpeta_dist_e2e>
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
const [D, DIST] = process.argv.slice(2);
const BASE = 'https://127.0.0.1:' + (process.env.E2E_PORT || 5198);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + ' s', ...a);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); log(ok ? 'OK  ' : 'FALLO', name, extra); };
const workerFile = fs.readdirSync(DIST + '/assets').find((f) => /^visionWorker\.entry-.*\.js$/.test(f));
if (!workerFile) throw new Error('No se encontró visionWorker.entry en ' + DIST);

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-proxy-server'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('[console.error] ' + m.text()); });
const threadWorkers = [];
page.on('worker', (w) => { if (w.url().includes('ort-wasm-simd-threaded')) threadWorkers.push(w.url()); });
await page.goto(BASE + '/');
const png = fs.readFileSync(D + '/pages/pagina-01.png').toString('base64');

const out = await page.evaluate(async ({ workerUrl, base, png }) => {
  const worker = new Worker(workerUrl, { type: 'module' });
  const errors = [];
  worker.addEventListener('error', (e) => errors.push(e.message));
  let next = 1;
  const call = (msg, ms = 240000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error('Tiempo agotado: ' + msg.op)), ms);
    const on = (e) => { if (e.data.id !== id) return; clearTimeout(timer); worker.removeEventListener('message', on); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error.message)); };
    worker.addEventListener('message', on);
    worker.postMessage({ id, ...msg });
  });
  const image = new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' });
  const flags = { detector: true, manga: false, lama: false, inpaintMode: 'fast' };
  await call({ op: 'configure', config: { modelsBase: base + '/__data/models', ppocrUrl: base + '/models/ppocr-rec.onnx', threads: 2 }, flags });
  const t = performance.now();
  const analysis = await call({ op: 'analyze', input: { original: image, lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 1300 } });
  const analyzeMs = performance.now() - t;
  const t2 = performance.now();
  const cleaned = await call({ op: 'clean', original: image, mask: analysis.mask, regions: analysis.regions });
  const cleanMs = performance.now() - t2;
  await call({ op: 'dispose' });
  worker.terminate();
  return { isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency, regions: analysis.regions.map((r) => r.source_text), ocr: analysis.ocrEngine, analyzeMs, cleanMs, cleanedBytes: cleaned.size, cleanedType: cleaned.type, errors };
}, { workerUrl: BASE + '/assets/' + workerFile, base: BASE, png });

log(JSON.stringify(out).slice(0, 700));
check('la página está aislada (SharedArrayBuffer disponible)', out.isolated === true);
check('el worker de visión detecta los globos con el detector real (≥3 de 4)', out.regions.length >= 3, String(out.regions.length));
check('lee texto japonés con PP-OCR real', out.regions.some((t) => /[ぁ-んァ-ン一-龯]/.test(t)), out.ocr);
check('los hilos de WebAssembly salen del runtime (ort-wasm-simd-threaded.mjs), no del paquete de la app', threadWorkers.length >= 1, String(threadWorkers.length));
check('la reconstrucción devuelve una imagen', out.cleanedBytes > 5000, out.cleanedType + ' ' + out.cleanedBytes);
check('sin errores en el worker ni en la consola', out.errors.length === 0 && problems.length === 0, [...out.errors, ...problems].join(' | ').slice(0, 300));
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
