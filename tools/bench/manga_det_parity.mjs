#!/usr/bin/env node
/**
 * Ejecuta el detector EXPERIMENTAL (PP-OCRv6 Manga) del motor MÓVIL (TypeScript + ONNX Runtime Web/WASM + OpenCV.js) en Chromium
 * sobre una carpeta de páginas y guarda, por página, líneas, bloques, máscara y tiempos. `manga_det_compare.py` lo compara con el
 * motor de escritorio (Python) sobre las mismas páginas.
 *
 * Requisitos: compilar antes la página de pruebas:  (cd apps/mobile && SB_TEST_OUT=dist-test npx vite build -c test/engine/vite.config.ts)
 * Uso:        node tools/bench/manga_det_parity.mjs <dist-test> <carpeta_paginas> <manga_det.onnx> <salida> [--no-isolation] [--threads N]
 * Con aislamiento (COOP/COEP, como el WebView de la app) ONNX usa hilos; sin él, uno solo (peor caso del teléfono).
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Playwright: el del proyecto o, con PLAYWRIGHT_DIR, el de otra carpeta. PW_CHANNEL=msedge usa el Edge instalado (sin descargar Chromium).
const { chromium } = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/` : import.meta.url)('playwright');

const [dist, pagesDir, model, out] = process.argv.slice(2).map((p) => resolve(p));
const isolated = !process.argv.includes('--no-isolation');
// La compilación de pruebas no copia los .wasm de ONNX Runtime (lo hace la de la app en `ort/`): se sirven desde node_modules.
const ORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/onnxruntime-web/dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.onnx': 'application/octet-stream' };

const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; } // evita un 404 inofensivo que contaría como error
  let file;
  if (path === '/data/manga_det.onnx') file = model;
  else if (path.startsWith('/pages/')) file = join(pagesDir, path.slice(7));
  else if (path.startsWith('/ort/')) file = join(ORT_DIR, path.slice(5));
  else file = join(dist, path === '/' ? 'index.html' : path.slice(1));
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
  if (isolated) Object.assign(headers, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  res.writeHead(200, headers);
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/index.html`);
await page.waitForFunction(() => !!window.SBT, null, { timeout: 60000 });
const files = readdirSync(pagesDir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
const summary = [];
for (const f of files) {
  const r = await page.evaluate(([u, m]) => window.SBT.mangaDetect(u, m), [`${base}/pages/${f}`, `${base}/data/manga_det.onnx`]);
  const { mask_png: maskPng, ...rest } = r;
  writeFileSync(join(out, f.replace(/\.\w+$/, '.json')), JSON.stringify(rest));
  writeFileSync(join(out, f.replace(/\.\w+$/, '.mask.png')), Buffer.from(maskPng.split(',')[1], 'base64'));
  summary.push({ page: f, ms: r.ms, infer_ms: r.infer_ms, blocks: r.blocks.length, lines: r.blocks.reduce((n, b) => n + b.lines.length, 0), isolated: r.isolated });
  console.log(JSON.stringify(summary.at(-1)));
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ isolated, errors, pages: summary }, null, 1));
await browser.close();
server.close();
if (errors.length) { console.error('Errores en la página:', errors.slice(0, 5)); process.exit(1); }
