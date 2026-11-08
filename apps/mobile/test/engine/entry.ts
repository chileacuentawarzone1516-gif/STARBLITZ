/**
 * Banco de pruebas del motor del móvil: se compila con Vite y se ejecuta en Chromium (`run_parity.py`).
 * Expone `window.SBT` con las operaciones que se comparan contra el motor de escritorio (Python).
 */
import { configureOrt, createSession, type OrtSession } from '../../src/engine/runtime/ort';
import { decodeToBgr, encodeMat, loadCv, type Mat } from '../../src/engine/runtime/cv';
import { TextDetector } from '../../src/engine/vision/detector';
import { detectPanels, readingOrder } from '../../src/engine/vision/layout';
import { findBubble, textRingStats } from '../../src/engine/vision/bubbles';
import { PaddleOcrEngine } from '../../src/engine/vision/ocr/ppocr';
import { Inpainter, type EraseTarget } from '../../src/engine/render/inpaint';
import { guessFromBlocks, guessFromText } from '../../src/engine/vision/langid';
import { VisionService } from '../../src/engine/vision/service';
import { splitLines } from '../../src/engine/vision/regions';
import { decodeToGray } from '../../src/engine/runtime/cv';
import { zipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { BrowserImageCodec } from '../../src/engine/importers/codec';
import { hamming } from '../../src/engine/importers/formats';
import { ImportProblem, ingest } from '../../src/engine/importers/ingest';
import { openPdf } from '../../src/engine/importers/pdf';
import { bytesSource } from '../../src/engine/importers/zip';

const fetchBytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

let detector: TextDetector | null = null;
let ocr: PaddleOcrEngine | null = null;
let session: OrtSession | null = null;
let service: VisionService | null = null;

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(s)}`;
}

/** Imagen sintética: izquierda oscura, derecha clara y una marca roja arriba a la izquierda (se ve si se gira mal). */
async function synthetic(w: number, h: number, type: string, tone = 0): Promise<Uint8Array> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.fillStyle = `rgb(${tone},${tone},${tone})`; g.fillRect(0, 0, w / 2, h);
  g.fillStyle = '#e00'; g.fillRect(4, 4, w / 8, h / 8);
  for (let i = 0; i < 6; i++) { g.fillStyle = `rgb(${40 * i},${255 - 40 * i},128)`; g.fillRect(w * 0.55, h * (0.1 + 0.13 * i), w * 0.4, h * 0.08); }
  return new Uint8Array(await (await c.convertToBlob({ type, quality: 0.92 })).arrayBuffer());
}

/** Inserta una etiqueta EXIF de orientación en un JPEG. */
function withExifOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const seg = new Uint8Array([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2)); out.set(seg, 2); out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

const dims = async (data: Uint8Array) => { const b = await createImageBitmap(new Blob([data.slice()])); const d = [b.width, b.height]; b.close(); return d; };

const api = {
  /** Importador con los códecs reales del navegador: formatos, EXIF, bombas, dañados, duplicados, ZIP y PDF. */
  async importers() {
    const codec = new BrowserImageCodec();
    const out: Record<string, unknown> = {};
    const jpg = await synthetic(200, 100, 'image/jpeg', 20), png = await synthetic(120, 80, 'image/png', 20), webp = await synthetic(90, 60, 'image/webp', 20);
    const load = async (data: Uint8Array, kind: string) => { const r = await codec.load('x', data, kind); return { ext: r.ext, width: r.width, height: r.height, dhash: r.dhash, bytes: r.data.length, same: r.data === data }; };
    out.jpg = await load(jpg, 'jpg'); out.png = await load(png, 'png'); out.webp = await load(webp, 'webp');
    const rotated = await load(withExifOrientation(jpg, 6), 'jpg');
    out.exif = { ...rotated, decoded: await dims(await (await codec.load('x', withExifOrientation(jpg, 6), 'jpg')).data) };
    out.exif1 = await load(withExifOrientation(jpg, 1), 'jpg');
    const tryLoad = async (data: Uint8Array, kind: string) => { try { await codec.load('x', data, kind); return 'sin error'; } catch (e) { return e instanceof ImportProblem ? e.message : `otro error: ${e}`; } };
    const bomb = new Uint8Array(png); new DataView(bomb.buffer).setUint32(16, 20000); new DataView(bomb.buffer).setUint32(20, 20000);
    out.bomb = await tryLoad(bomb, 'png');
    out.corrupt = await tryLoad(new Uint8Array([...png.subarray(0, 40), 1, 2, 3, 4]), 'png');
    out.truncatedHeader = await tryLoad(new Uint8Array(png.subarray(0, 12)), 'png');
    // Huellas: la misma imagen en otro formato es «casi igual»; otra imagen distinta, no
    const other = await synthetic(200, 100, 'image/png', 200);
    const a = (await codec.load('x', jpg, 'jpg')).dhash, b = (await codec.load('x', await synthetic(200, 100, 'image/png', 20), 'png')).dhash;
    const c = (await codec.load('x', await synthetic(400, 200, 'image/webp', 20), 'webp')).dhash;
    out.hash = { jpgVsPng: hamming(a, b), jpgVsBigWebp: hamming(a, c), different: hamming(a, (await codec.load('x', other, 'png')).dhash) };

    // PDF con pdf-lib: página 1 = escaneo a toda página; página 2 = texto; página 3 = escaneo
    const pdf = await PDFDocument.create();
    const scan = await pdf.embedJpg(await synthetic(800, 1130, 'image/jpeg', 30));
    const p1 = pdf.addPage([595, 842]); p1.drawImage(scan, { x: 0, y: 0, width: 595, height: 842 });
    const p2 = pdf.addPage([595, 842]); p2.drawText('Texto de prueba', { x: 50, y: 700, size: 24, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const p3 = pdf.addPage([420, 595]); p3.drawImage(scan, { x: 0, y: 0, width: 420, height: 595 });
    const pdfBytes = await pdf.save();
    const opened = await openPdf(pdfBytes);
    const pages: number[][] = [];
    for (let i = 0; i < opened.numPages; i++) pages.push(await dims(await opened.render(i)));
    await opened.destroy();
    out.pdf = { numPages: opened.numPages, pages };
    let pdfError = '';
    try { await openPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3])); } catch (e) { pdfError = 'falla'; }
    out.pdfBroken = pdfError;

    // Todo junto: CBZ con varios formatos + PDF + una imagen suelta repetida
    const added: { name: string; ext: string; width: number; height: number }[] = [];
    let n = 0;
    const cbz = zipSync({ 'c/p10.jpg': await synthetic(100, 150, 'image/jpeg', 90), 'c/p2.png': png, 'c/p1.webp': webp, 'c/rot.jpg': withExifOrientation(jpg, 8), 'c/nota.txt': new TextEncoder().encode('x') });
    const report = await ingest([
      { name: 'tomo.cbz', source: bytesSource(cbz) }, { name: 'doc.pdf', source: bytesSource(pdfBytes) }, { name: 'repetida.png', source: bytesSource(png) },
    ], [], 50, { codec, pdf: openPdf, add: async (img) => { added.push({ name: img.name, ext: img.ext, width: img.width, height: img.height }); return `g${++n}`; } });
    out.ingest = { added, report };
    return out;
  },

  async init(opts: { wasmBase?: string; detectorUrl: string; ocrUrl: string }) {
    const t0 = performance.now();
    const lap = (m: string) => console.log(`init ${((performance.now() - t0) / 1000).toFixed(1)}s ${m}`);
    configureOrt({ wasmBase: opts.wasmBase });
    const cv = await loadCv();
    lap('opencv listo');
    const bytes = await fetchBytes(opts.detectorUrl);
    lap(`detector descargado ${bytes.length}`);
    session = await createSession(bytes);
    lap('sesión del detector');
    detector = await TextDetector.create(session);
    lap('detector listo');
    ocr = await PaddleOcrEngine.create(cv, await fetchBytes(opts.ocrUrl), 'ja');
    lap('ocr listo');
    service = new VisionService({
      detector: async () => bytes, ppocr: async () => fetchBytes(opts.ocrUrl), hasMangaOcr: async () => false, mangaOcr: async () => null, lama: async () => null,
    }, { inpaintMode: () => 'fast' });
    return { ms: performance.now() - t0, isolated: crossOriginIsolated };
  },

  /** La fachada de visión de la app (VisionService) sobre una página: regiones, borrado, relectura, idioma y anotación. */
  async service(imageUrl: string, maskUrl: string, splitCases: { bbox: [number, number, number, number]; vertical: boolean }[]) {
    const cv = await loadCv();
    const blob = await (await fetch(imageUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const [width, height] = [bitmap.width, bitmap.height];
    bitmap.close();
    const t0 = performance.now();
    const analysis = await service!.analyze({ original: blob, lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: height });
    const tAnalyze = Math.round(performance.now() - t0);
    const clean = await service!.clean(blob, analysis.mask, analysis.regions);
    const lang = await service!.detectLanguage([async () => blob]);
    const first = analysis.regions.find((r) => r.vertical) ?? analysis.regions[0];
    const reread = first ? await service!.readRegion({ original: blob, mask: analysis.mask, bbox: first.bbox, lang: 'ja', sfx: 'keep', pageHeight: height, regionId: first.id, order: first.order }) : null;
    const annotated = await service!.annotate(blob, analysis.regions.map((r) => r.bbox));
    const aBitmap = await createImageBitmap(new Blob([annotated.slice()], { type: 'image/jpeg' }));
    const annotatedInfo = { head: [annotated[0], annotated[1]], width: aBitmap.width, height: aBitmap.height, bytes: annotated.length };
    aBitmap.close();
    // Separación de líneas (texto dibujado a mano), con la máscara de referencia y sin ella
    const img = await decodeToBgr(cv, blob);
    const refMask = await decodeToGray(cv, await (await fetch(maskUrl)).blob());
    const blank = cv.Mat.zeros(img.rows, img.cols, cv.CV_8UC1);
    const splits = splitCases.map((c) => ({
      mask: splitLines(cv, img, refMask, c.bbox, c.vertical),
      no_mask: splitLines(cv, img, blank, c.bbox, c.vertical),
    }));
    img.delete(); refMask.delete(); blank.delete();
    return {
      width, height, regions: analysis.regions.map(({ id: _i, updated: _u, ...r }) => r), panels: analysis.panels, ocr_engine: analysis.ocrEngine, lang,
      reread: reread && { id_kept: reread.id === first!.id, text: reread.source_text, kind: reread.kind, bbox: reread.bbox },
      annotated: annotatedInfo, splits, t_analyze: tAnalyze, clean_png: await blobToDataUrl(clean), mask_png: await blobToDataUrl(analysis.mask),
    };
  },

  /** Ejecuta visión completa sobre una imagen y devuelve lo mismo que `tools/golden_vision.py`. */
  async analyze(imageUrl: string, withOcr = true) {
    const cv = await loadCv();
    const timings: Record<string, number> = {};
    const lap = (k: string, t: number) => { timings[k] = Math.round(performance.now() - t); };
    const img: Mat = await decodeToBgr(cv, await (await fetch(imageUrl)).blob());
    let t = performance.now();
    const { blocks, mask } = await detector!.detect(img);
    lap('detect', t);
    t = performance.now();
    const panels = detectPanels(cv, img);
    const order = readingOrder(blocks.map((b) => b.bbox), panels, 'rtl');
    lap('layout', t);
    t = performance.now();
    const entries = [];
    const targets: EraseTarget[] = [];
    const texts: string[] = [];
    let tBubble = 0, tOcr = 0;
    for (const b of blocks) {
      let s = performance.now();
      const bubble = findBubble(cv, img, mask, b);
      const ring = textRingStats(cv, img, mask, b.bbox);
      tBubble += performance.now() - s;
      s = performance.now();
      const res = withOcr ? await ocr!.recognize(img, b) : { text: '', confidence: 0, engine: '' };
      tOcr += performance.now() - s;
      texts.push(res.text);
      entries.push({ bbox: b.bbox, lines: b.lines, vertical: b.vertical, confidence: b.confidence, lang_hint: b.langHint,
        line_size: b.lineSize, bubble, ring, ocr: res });
      targets.push({ bbox: b.bbox, lines: b.lines, lineSize: b.lineSize || 16, bubblePolygon: bubble?.polygon ?? null,
        fill: bubble?.fill ?? null, uniform: !!(bubble && bubble.uniform) });
    }
    timings.bubbles = Math.round(tBubble);
    timings.ocr = Math.round(tOcr);
    t = performance.now();
    const inpainter = new Inpainter('fast', async () => null);
    const clean = await inpainter.erase(img, mask, targets);
    lap('erase', t);
    const guess = guessFromBlocks(blocks);
    const out = {
      width: img.cols, height: img.rows, blocks: entries, panels, order, timings,
      mask_pixels: (() => { let n = 0; for (let i = 0; i < mask.data.length; i++) if (mask.data[i]) n++; return n; })(),
      lang_blocks: [guess.lang, guess.confidence], lang_text: guessFromText(texts.slice(0, 4)),
      mask_png: await blobToDataUrl(await encodeMat(cv, mask)),
      clean_png: await blobToDataUrl(await encodeMat(cv, clean)),
    };
    img.delete(); mask.delete(); clean.delete();
    return out;
  },
};

(window as unknown as { SBT: typeof api }).SBT = api;
