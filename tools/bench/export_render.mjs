#!/usr/bin/env node
/**
 * Exporta las páginas TRADUCIDAS de una evaluación de `corpus_eval.py` (carpeta `img/` con NNN-page.json y NNN-clean.png) con el
 * renderizador compartido de las apps (`renderPageBlob` + tipografías incluidas), en Chromium. Guarda NNN-traducida.png y un
 * resumen con el tiempo de rotulación y los textos que no caben en su caja.
 *
 * Requisito: la página de pruebas compilada (ver manga_det_parity.mjs).
 * Uso: node tools/bench/export_render.mjs <dist-test> <carpeta img> <salida>
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Playwright: el del proyecto o, con PLAYWRIGHT_DIR, el de otra carpeta. PW_CHANNEL=msedge usa el Edge instalado (sin descargar Chromium).
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/` : import.meta.url)('playwright');

const [dist, imgDir, out] = process.argv.slice(2).map((p) => resolve(p));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = path.startsWith('/img/') ? join(imgDir, path.slice(5)) : join(dist, path === '/' ? 'index.html' : path.slice(1));
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}/index.html`);
await page.waitForFunction(() => !!window.SBT, null, { timeout: 60000 });
const ids = readdirSync(imgDir).filter((f) => f.endsWith('-page.json')).map((f) => f.slice(0, -10)).sort();
const rows = [];
for (const id of ids) {
  // Sin página limpia (página sin texto: no hay nada que borrar) la app exporta el original, igual que aquí.
  const baseImg = existsSync(join(imgDir, `${id}-clean.png`)) ? `${id}-clean.png` : `${id}-original.png`;
  // `--sin-original` reproduce la exportación antigua (traducción desbordada en vez de restaurar el original).
  const orig = process.argv.includes('--sin-original') ? undefined : `${base}/img/${id}-original.png`;
  const r = await page.evaluate(([j, c, o]) => window.SBT.exportPage(j, c, o), [`${base}/img/${id}-page.json`, `${base}/img/${baseImg}`, orig]);
  writeFileSync(join(out, `${id}-traducida.png`), Buffer.from(r.png.split(',')[1], 'base64'));
  rows.push({ page: id, base: baseImg, ms: r.ms, drawn: r.drawn, kept_original: r.kept_original, not_fit: r.not_fit });
  console.log(JSON.stringify({ page: id, ms: r.ms, drawn: r.drawn, not_fit: r.not_fit.length }));
}
writeFileSync(join(out, 'export.json'), JSON.stringify({ errors, pages: rows }, null, 1));
await browser.close();
server.close();
if (errors.length) { console.error(errors.slice(0, 5)); process.exit(1); }
