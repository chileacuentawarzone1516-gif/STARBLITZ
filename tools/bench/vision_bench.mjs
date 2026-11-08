// Mide por etapa el análisis de visión REAL (detector de texto + OCR PP-OCR en WebAssembly, dentro del mismo Web Worker que usa
// el APK) en un navegador Chromium. Comprueba el efecto de los hilos de WebAssembly y del tamaño/forma de la página.
//
// Qué es y qué NO es: tiempos de ESTE equipo y de ESTE navegador (no del teléfono), con páginas SINTÉTICAS (texto sobre viñetas
// simples; un manga real tiene más trazos y suele costar más en el posproceso). Sirve para ver DÓNDE se va el tiempo (proporciones)
// y para comparar configuraciones, no para predecir segundos en el Redmi. Mismo programa en el teléfono = protocolo del informe.
//
// Uso: node vision_bench.mjs <carpeta_trabajo con pages/ y data/> <dist_e2e> <salida.json> [canal_navegador=msedge]
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
const [D, DIST, OUT, CHANNEL = 'msedge'] = process.argv.slice(2);
const BASE = 'https://127.0.0.1:' + (process.env.E2E_PORT || 5198);
const workerFile = fs.readdirSync(DIST + '/assets').find((f) => /^visionWorker\.entry-.*\.js$/.test(f));
if (!workerFile) throw new Error('No se encontró visionWorker.entry en ' + DIST);
const pages = fs.readdirSync(D + '/pages').filter((f) => /^bench-.*\.png$/.test(f)).sort();
const REPEATS = Number(process.env.REPEATS || 3);
const THREADS = (process.env.THREADS || '1,2,4').split(',').map(Number);

const browser = await chromium.launch({ channel: CHANNEL, args: ['--disable-dev-shm-usage', '--no-proxy-server'] });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
page.on('console', (m) => { if (m.text().startsWith('[vb]')) console.log(m.text()); });
page.on('crash', () => console.log('[vb] la pestaña se cerró por fallo (memoria?)'));
await page.goto(BASE + '/');
const results = [];
for (const threads of THREADS) {
  const imgs = pages.map((f) => ({ name: f, b64: fs.readFileSync(D + '/pages/' + f).toString('base64') }));
  const out = await page.evaluate(async ({ workerUrl, base, imgs, threads, repeats }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    let next = 1;
    const call = (msg, ms = 600000) => new Promise((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error('Tiempo agotado: ' + msg.op)), ms);
      const on = (e) => { if (e.data.id !== id) return; clearTimeout(timer); worker.removeEventListener('message', on); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error?.message || 'error')); };
      worker.addEventListener('message', on);
      worker.postMessage({ id, ...msg });
    });
    const flags = { detector: true, manga: false, lama: false, inpaintMode: 'fast' };
    await call({ op: 'configure', config: { modelsBase: base + '/__data/models', ppocrUrl: base + '/models/ppocr-rec.onnx', threads }, flags });
    const rows = [];
    for (const im of imgs) {
      const blob = new Blob([Uint8Array.from(atob(im.b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
      const bmp = await createImageBitmap(blob);
      for (let i = 0; i < repeats + 1; i++) {
        const t = performance.now();
        const a = await call({ op: 'analyze', input: { original: blob, lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: bmp.height } });
        const wall = performance.now() - t;
        rows.push({ page: im.name, w: bmp.width, h: bmp.height, cold: i === 0, wall_ms: Math.round(wall), stats: a.stats, regions: a.regions.length });
        console.log('[vb] hilos=' + threads + ' ' + im.name + (i === 0 ? ' (fría)' : '') + ' ' + Math.round(wall) + ' ms ' + JSON.stringify(a.stats));
      }
      const t2 = performance.now();
      const clean = await call({ op: 'clean', original: blob, mask: (await call({ op: 'analyze', input: { original: blob, lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: bmp.height } })).mask, regions: [] });
      rows.push({ page: im.name, clean_only_ms: Math.round(performance.now() - t2), bytes: clean.size });
    }
    await call({ op: 'dispose' });
    worker.terminate();
    return { isolated: crossOriginIsolated, cores: navigator.hardwareConcurrency, rows };
  }, { workerUrl: BASE + '/assets/' + workerFile, base: BASE, imgs, threads, repeats: REPEATS });
  results.push({ threads, ...out });
  console.log(`hilos=${threads} aislada=${out.isolated} núcleos=${out.cores}`);
}
fs.writeFileSync(OUT, JSON.stringify({ browser: CHANNEL, node: process.version, results }, null, 1));
await browser.close();
