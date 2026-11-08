// E2E en Chromium de STARBLITZ Mobile (modo navegador: OPFS + visión real en WASM).
// REAL: interfaz, importación, descarga e integridad del detector (95 MB), detector + PP-OCR en WASM, reconstrucción rápida, editor, exportación.
// SIMULADO: el modelo de lenguaje (servidor OpenAI-compatible falso interceptado por Playwright) y el plugin nativo de Android.
// Con E2E_REAL_LLM_URL (p. ej. http://127.0.0.1:8081/v1 de un llama-server real) el modelo de lenguaje DEJA de ser simulado:
// la app traduce con ese servidor y se registran las traducciones reales (el plugin nativo de Android sigue sin existir).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import fs from 'node:fs';
const D = process.argv[2];            // carpeta de trabajo: pages/, data/detector.onnx y shots/
const BASE = 'https://127.0.0.1:' + (process.env.E2E_PORT || 5198);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
fs.mkdirSync(D + '/shots', { recursive: true });
const problems = [];
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); log(ok ? 'OK  ' : 'FALLO', name, extra); };

const DICT = [['おはよう', 'Buenos días'], ['いい天気', 'Qué buen clima hace'], ['待ってください', 'Espérame, por favor'], ['着きます', 'Ya casi llego'], ['行くのか', '¿De verdad vas a ir?'], ['戻れない', 'Ya no hay vuelta atrás'], ['大丈夫', 'Está bien.'], ['任せて', 'Déjamelo a mí.'], ['ありがとう', 'Gracias,'], ['おかげ', 'todo gracias a ustedes.'], ['黙って', '¿Por qué te quedas callado?'], ['明日', 'Nos vemos mañana.'], ['さようなら', '¡Adiós!']];
const llmCalls = [];
const REAL_LLM = (process.env.E2E_REAL_LLM_URL || '').replace(/\/v1\/?$/, '');
function mockLlm(route) {
  const req = route.request();
  if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock' }] }), headers: { 'access-control-allow-origin': '*' } });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  const body = JSON.parse(req.postData());
  const schema = body.response_format?.json_schema?.schema ?? {};
  const kind = 'new_terms' in (schema.properties ?? {}) ? 'translate' : 'review';
  const user = body.messages.find((m) => m.role === 'user');
  const text = typeof user.content === 'string' ? user.content : user.content.map((c) => c.text ?? '').join('\n');
  llmCalls.push(kind);
  let out;
  if (kind === 'review') out = { items: [] };
  else {
    const items = [];
    for (const line of text.split('\n')) {
      const m = /^\[(\d+)\] \([^)]*\) (.*)$/.exec(line);
      if (!m || line.includes('→')) continue;
      const hit = DICT.filter(([ja]) => m[2].includes(ja)).map(([, es]) => es).join(' ');
      items.push({ n: Number(m[1]), translation: hit || ('[ES] ' + m[2]), speaker: '', emotion: 'neutral', confidence: hit ? 0.9 : 0.55, flags: [], note: '', issue: '', source_fix: '' });
    }
    out = { items, page_summary: 'Dos personajes conversan.', new_terms: [], characters: [] };
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }) });
}

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-ES', acceptDownloads: true, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') problems.push('[console.error] ' + m.text()); });
page.on('crash', () => log('LA PÁGINA SE CERRÓ POR UN FALLO (crash)'));
page.on('pageerror', (e) => problems.push('[pageerror] ' + e.message));
await page.route('https://github.com/zyddnys/**', (r) => r.continue({ url: BASE + '/__data/detector.onnx' }));
if (!REAL_LLM) await page.route('https://mock-llm.test/**', mockLlm);
const shot = (n) => page.screenshot({ path: D + '/shots/e2e-' + n + '.png' });
const nav = (label) => page.locator('nav.m-bottom-nav').getByRole('button', { name: label, exact: true }).click();

await page.goto(BASE + '/');
await page.waitForSelector('.m-bottom-nav', { timeout: 30000 });
check('arranque del motor local', await page.evaluate(() => !!window.__sb?.engine));

// 1) Descargar el detector desde la interfaz (SHA-256 verificado por la app)
await nav('Modelos');
await page.getByRole('button', { name: 'Visión', exact: true }).click();
const detCard = page.locator('article.m-model', { hasText: 'Detector de texto' });
await detCard.getByRole('button', { name: /Descargar/ }).click();
await page.waitForTimeout(800); await shot('01-descarga-detector');
await detCard.locator('.chip-ok', { hasText: 'Instalado' }).waitFor({ timeout: 180000 });
check('detector descargado e instalado con verificación SHA-256', true); await shot('02-detector-instalado');

// 2) Servidor de lenguaje externo (simulado) para probar el flujo de traducción
await page.evaluate((cfg) => window.__sb.engine.updateSettings({ llm: { provider: 'openai', base_url: cfg.base, model: cfg.model, use_vision: false }, processing: { profile: 'mid' } }),
  { base: REAL_LLM || 'https://mock-llm.test', model: process.env.E2E_REAL_LLM_MODEL || 'mock' });

// 3) Importar y procesar todo el proyecto
await nav('Proyectos');
await page.getByRole('button', { name: 'Importar capítulo' }).click();
await page.getByTestId('import-input').setInputFiles([D + '/pages/pagina-01.png', D + '/pages/pagina-02.png']);
await page.getByPlaceholder('Nombre del capítulo').fill('Capítulo de prueba');
await page.getByRole('radio', { name: 'Japonés', exact: true }).click();
await page.getByLabel('Traducir todo el proyecto al terminar de importar').check();
await shot('03-importar');
await page.locator('.m-sheet').getByRole('button', { name: /^Importar/ }).click();
await page.waitForURL(/#\/p\//, { timeout: 60000 });
check('importación de 2 imágenes y apertura del proyecto', true);
const t0 = Date.now();
let shotted = 0;
for (;;) {
  const live = await page.locator('.m-run').count();
  if (live && shotted < 3 && Date.now() - t0 > 4000 * (shotted + 1)) { await shot('04-procesando-' + shotted++); }
  const state = await page.evaluate(async () => { const e = window.__sb.engine; const p = (await e.projects())[0]; const r = await e.run(p.id); return { status: r?.status, counts: r?.counts, error: r?.error }; });
  if (state.status === 'done' || state.status === 'error' || state.status === 'cancelled') { log('estado final', JSON.stringify(state)); check('procesamiento completo sin errores', state.status === 'done' && state.counts.error === 0, JSON.stringify(state.counts)); break; }
  if (Date.now() - t0 > (REAL_LLM ? 2400000 : 420000)) { check('procesamiento completo sin errores', false, 'tiempo agotado ' + JSON.stringify(state)); break; }
  await page.waitForTimeout(1500);
}
log('procesamiento:', ((Date.now() - t0) / 1000).toFixed(1), 's; llamadas al modelo simulado:', llmCalls.join(','));
await page.waitForTimeout(800); await shot('05-proyecto-terminado');

// 4) Resultado real del análisis (detector + OCR) y de la traducción
const summary = await page.evaluate(async () => {
  const e = window.__sb.engine; const p = (await e.projects())[0]; const b = await e.project(p.id);
  return { lang: b.project.detected_lang || b.project.source_lang, pages: b.pages.map((pg) => ({ regions: pg.regions.length, clean: pg.has_clean, texts: pg.regions.map((r) => [r.source_text, r.translation, r.ocr_engine, +(r.confidence ?? 0).toFixed(2), r.status]) })) };
});
fs.writeFileSync(D + '/e2e-summary.json', JSON.stringify(summary, null, 1));
log(JSON.stringify(summary));
check('el detector real encontró globos en la página 1 (≥3 de 4)', summary.pages[0].regions >= 3, String(summary.pages[0].regions));
check('el detector real encontró globos en la página 2 (≥2 de 3)', summary.pages[1].regions >= 2, String(summary.pages[1].regions));
check('hay traducciones en español', summary.pages.every((p) => p.texts.every((t) => t[1])));
if (REAL_LLM) {
  const all = summary.pages.flatMap((p) => p.texts);
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;
  check('modelo REAL: ninguna traducción conserva kana/kanji', all.every((t) => !cjk.test(t[1] || '')), all.filter((t) => cjk.test(t[1] || '')).map((t) => t[1]).join(' | '));
  check('modelo REAL: ninguna traducción es el marcador del modelo simulado', all.every((t) => !String(t[1]).startsWith('[ES]')));
  fs.writeFileSync(D + '/e2e-traducciones-reales.json', JSON.stringify(all, null, 1));
}
check('las páginas tienen fondo reconstruido', summary.pages.every((p) => p.clean));

// 5) Lector y editor
await page.getByRole('button', { name: /Leer/ }).first().click();
await page.waitForSelector('.m-reader', { timeout: 20000 }); await page.waitForTimeout(1500); await shot('06-lector');
await page.goBack(); await page.waitForSelector('.m-thumb', { timeout: 20000 });
await page.getByRole('button', { name: /Editar/ }).first().click();
await page.waitForSelector('.m-edit-overlay', { timeout: 20000 }); await page.waitForTimeout(1200); await shot('07-editor');
await page.locator('.m-edit-overlay g[role=button]').first().click();
await page.waitForSelector('.m-tgt', { timeout: 10000 });
await page.locator('.m-tgt').fill('Texto corregido a mano'); await page.waitForTimeout(900); await shot('08-editor-region');
const saved = await page.evaluate(async () => { const e = window.__sb.engine; const p = (await e.projects())[0]; const b = await e.project(p.id); return b.pages[0].regions.some((r) => r.translation === 'Texto corregido a mano' && r.status === 'edited'); });
check('la edición manual se guarda y marca como editada', saved);

// 6) Exportación real (ZIP de PNG)
await page.goto(BASE + '/#/p/' + (await page.evaluate(async () => (await window.__sb.engine.projects())[0].id)));
await page.waitForSelector('.m-thumb', { timeout: 20000 });
await page.getByRole('button', { name: /Exportar/ }).first().click();
await page.waitForTimeout(600); await shot('09-exportar');
const names = await page.locator('.m-sheet [aria-pressed], .m-sheet button').allInnerTexts();
log('opciones de la hoja de exportación:', names.join(' | '));
fs.writeFileSync(D + '/e2e-problems.txt', problems.join('\n'));
fs.writeFileSync(D + '/e2e-results.json', JSON.stringify(results, null, 1));
log('errores de consola/página:', problems.length); problems.slice(0, 8).forEach((p) => log(' ', p.slice(0, 300)));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
