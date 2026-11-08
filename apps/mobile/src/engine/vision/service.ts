/**
 * Visión del dispositivo: detecta, lee y borra el texto de las páginas con OpenCV.js y ONNX Runtime Web
 * (WebAssembly), sin red. Implementa `VisionPort` para el procesador.
 *
 * Los modelos llegan de un `VisionAssets` (en la app, leídos del almacenamiento local de la app donde los dejó el
 * gestor de modelos; en las pruebas, desde archivos). Las sesiones se crean al primer uso y se reutilizan.
 */
import type { Region } from '@starblitz/shared';
import { CancelledError } from '../core/errors';
import { Inpainter, LamaInpainter, type EraseTarget, type InpaintMode } from '../render/inpaint';
import type { AnalysisResult, AnalyzeInput, ReadRegionInput, VisionPort } from '../pipeline/ports';
import { configureOrt, createSession, releaseSession, type OrtOptions, type OrtSession } from '../runtime/ort';
import { decodeToBgr, decodeToGray, encodeMat, loadCv, median, type Cv, type Mat } from '../runtime/cv';
import { annotateForLlm } from './annotate';
import { TextDetector } from './detector';
import { guessFromBlocks, guessFromText } from './langid';
import { detectPanels, readingOrder } from './layout';
import { type MangaOcrFiles, MangaOcrEngine } from './ocr/mangaOcr';
import { PaddleOcrEngine } from './ocr/ppocr';
import type { OcrEngine } from './ocr/base';
import { makeRegion, splitLines } from './regions';
import { blockArea, type Box, type DetectedBlock } from './types';

/** De dónde salen los modelos de visión. */
export interface VisionAssets {
  /** Detector de texto (obligatorio). Lanza `ModelMissingError` si no está instalado. */
  detector(): Promise<Uint8Array>;
  /** Reconocedor PP-OCR del idioma (viene con la app). */
  ppocr(lang: string): Promise<Uint8Array>;
  /** ¿Se debe usar Manga OCR para el japonés? (instalado y permitido por el perfil del dispositivo). Es barato: no lee el modelo. */
  hasMangaOcr(): Promise<boolean>;
  /** Archivos de Manga OCR (≈460 MB): solo se leen cuando hace falta crear el motor. */
  mangaOcr(): Promise<MangaOcrFiles | null>;
  /** LaMa (opcional, mejora el borrado sobre dibujo); `null` si no está instalado. */
  lama(): Promise<Uint8Array | null>;
}

export interface VisionOptions {
  ort?: OrtOptions;
  /** Modo de reconstrucción actual (depende del perfil del dispositivo y de los ajustes). */
  inpaintMode: () => InpaintMode;
}

const VERTICAL_LANGS = ['ja', 'zh', 'zh-hant'];

export class VisionService implements VisionPort {
  private cv: Cv | null = null;
  private detector: TextDetector | null = null;
  private detectorSession: OrtSession | null = null;
  private ocr = new Map<string, OcrEngine>();
  private lama: LamaInpainter | null | undefined;
  private inpainter: Inpainter;

  constructor(private assets: VisionAssets, private opts: VisionOptions) {
    this.inpainter = new Inpainter(opts.inpaintMode(), () => this.lamaEngine());
  }

  private async runtime(): Promise<Cv> {
    if (!this.cv) {
      configureOrt(this.opts.ort ?? {});
      this.cv = await loadCv();
    }
    return this.cv;
  }

  private async detectorEngine(): Promise<TextDetector> {
    await this.runtime();
    if (!this.detector) {
      const bytes = await this.assets.detector(); // ModelMissingError si falta
      this.detectorSession = await createSession(bytes);
      this.detector = await TextDetector.create(this.detectorSession);
    }
    return this.detector;
  }

  /** Manga OCR para japonés si está instalado; si no (o si está dañado), PP-OCR del idioma. */
  private async engineFor(lang: string): Promise<OcrEngine> {
    const cv = await this.runtime();
    const wantManga = lang === 'ja' && (await this.assets.hasMangaOcr());
    const key = wantManga ? 'manga-ocr' : `ppocr-${lang}`;
    let engine = this.ocr.get(key);
    if (!engine) {
      if (wantManga) {
        try {
          const files = await this.assets.mangaOcr();
          if (files) engine = await MangaOcrEngine.create(cv, files);
        } catch (e) {
          console.error('No se pudo cargar Manga OCR; se usa PP-OCR.', e);
        }
      }
      engine ??= await PaddleOcrEngine.create(cv, await this.assets.ppocr(lang), lang);
      this.ocr.set(key, engine); // si Manga OCR falló, queda PP-OCR guardado bajo su clave y no se reintenta en cada página
    }
    return engine;
  }

  private async lamaEngine(): Promise<LamaInpainter | null> {
    if (this.lama === undefined) {
      const bytes = await this.assets.lama();
      this.lama = bytes ? await LamaInpainter.create(await this.runtime(), bytes) : null;
    }
    return this.lama;
  }

  /** Los ajustes cambiaron: se vuelve a decidir el modo de reconstrucción y se relee qué modelos opcionales hay. */
  refresh(): void {
    this.inpainter.mode = this.opts.inpaintMode();
    this.lama = undefined;
    for (const e of this.ocr.values()) void e.dispose();
    this.ocr.clear();
  }

  async dispose(): Promise<void> {
    for (const e of this.ocr.values()) await e.dispose();
    this.ocr.clear();
    await this.lama?.dispose();
    this.lama = undefined;
    await releaseSession(this.detectorSession);
    this.detector = null;
    this.detectorSession = null;
  }

  // -- análisis -----------------------------------------------------------------------------------------------------
  async analyze(input: AnalyzeInput, signal?: AbortSignal): Promise<AnalysisResult> {
    const detector = await this.detectorEngine();
    const engine = await this.engineFor(input.lang);
    const cv = await this.runtime();
    const img = await decodeToBgr(cv, input.original);
    let mask: Mat | null = null;
    try {
      const found = await detector.detect(img);
      mask = found.mask;
      const { blocks } = found;
      const panels = detectPanels(cv, img);
      const order = readingOrder(blocks.map((b) => b.bbox), panels, input.direction);
      const medianLine = blocks.length ? median(blocks.map((b) => b.lineSize)) : 0;
      const regions: Region[] = [];
      for (const [rank, bi] of order.entries()) {
        if (signal?.aborted) throw new CancelledError();
        const block = blocks[bi];
        const ocr = await engine.recognize(img, block);
        if (!ocr.text.trim()) continue;
        regions.push(makeRegion(cv, {
          img, mask, block, text: ocr.text, confidence: ocr.confidence, engine: ocr.engine, order: rank, medianLine, sfx: input.sfx, pageHeight: input.pageHeight,
        }));
      }
      return { regions, panels, ocrEngine: engine.id, mask: await encodeMat(cv, mask) };
    } finally {
      img.delete();
      mask?.delete();
    }
  }

  /** Deduce si la obra es japonesa o inglesa: el detector clasifica los bloques y se confirma leyendo los mayores. */
  async detectLanguage(pages: (() => Promise<Blob>)[], signal?: AbortSignal): Promise<string> {
    const detector = await this.detectorEngine();
    const cv = await this.runtime();
    const blocks: DetectedBlock[] = [];
    let best: { img: Mat; found: DetectedBlock[] } | null = null;
    try {
      for (const load of pages) {
        if (signal?.aborted) throw new CancelledError();
        const img = await decodeToBgr(cv, await load());
        const { blocks: found, mask } = await detector.detect(img);
        mask.delete();
        blocks.push(...found);
        if (found.length && (!best || found.length > best.found.length)) {
          best?.img.delete();
          best = { img, found };
        } else {
          img.delete();
        }
        if (blocks.length >= 10) break;
      }
      let lang: string = guessFromBlocks(blocks).lang ?? 'ja';
      if (best) {
        const biggest = [...best.found].sort((a, b) => blockArea(b) - blockArea(a)).slice(0, 4);
        const engine = await this.engineFor(lang);
        const texts: string[] = [];
        for (const b of biggest) texts.push((await engine.recognize(best.img, b)).text);
        const confirmed = guessFromText(texts);
        if (confirmed && confirmed !== lang) {
          console.info(`Idioma corregido por la lectura del texto: ${lang} → ${confirmed}`);
          lang = confirmed;
        }
      }
      return lang;
    } finally {
      best?.img.delete();
    }
  }

  // -- reconstrucción -------------------------------------------------------------------------------------------------
  async clean(original: Blob, maskBlob: Blob | null, regions: Region[], signal?: AbortSignal): Promise<Blob> {
    const cv = await this.runtime();
    const img = await decodeToBgr(cv, original);
    const mask = await this.maskFor(cv, maskBlob, img);
    try {
      if (signal?.aborted) throw new CancelledError();
      const targets: EraseTarget[] = regions.filter((r) => r.erase).map((r) => ({
        bbox: r.bbox, lines: r.lines as EraseTarget['lines'], lineSize: r.line_size || 16.0, bubblePolygon: r.bubble?.polygon ?? null,
        fill: r.bubble?.fill ?? null, uniform: !!r.bubble?.uniform,
      }));
      this.inpainter.mode = this.opts.inpaintMode();
      const cleaned = targets.length ? await this.inpainter.erase(img, mask, targets) : img;
      try { return await encodeMat(cv, cleaned); } finally { if (cleaned !== img) cleaned.delete(); }
    } finally {
      img.delete();
      mask.delete();
    }
  }

  private async maskFor(cv: Cv, blob: Blob | null, img: Mat): Promise<Mat> {
    if (blob) {
      const m = await decodeToGray(cv, blob);
      if (m.rows === img.rows && m.cols === img.cols) return m;
      m.delete();
    }
    return cv.Mat.zeros(img.rows, img.cols, cv.CV_8UC1);
  }

  annotate(original: Blob, boxes: Box[]): Promise<Uint8Array> {
    return annotateForLlm(original, boxes);
  }

  // -- edición manual ---------------------------------------------------------------------------------------------------
  /** Vuelve a leer un área (corrige o crea una región dibujada por la persona). */
  async readRegion(input: ReadRegionInput): Promise<Region> {
    const engine = await this.engineFor(input.lang);
    const cv = await this.runtime();
    const img = await decodeToBgr(cv, input.original);
    const mask = await this.maskFor(cv, input.mask, img);
    try {
      const [x1, y1, x2, y2] = input.bbox;
      const vertical = VERTICAL_LANGS.includes(input.lang) && (y2 - y1) > (x2 - x1) * 1.2;
      const lines = splitLines(cv, img, mask, input.bbox, vertical);
      const lineSize = lines.length
        ? median(lines.map((p) => Math.min(Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1])) - Math.min(...p.map((q) => q[1])))))
        : Math.min(x2 - x1, y2 - y1) / 2;
      const block: DetectedBlock = { bbox: input.bbox, lines, vertical, confidence: 1.0, langHint: 'unknown', lineSize };
      const ocr = await engine.recognize(img, block);
      return makeRegion(cv, {
        img, mask, block, text: ocr.text, confidence: ocr.confidence, engine: ocr.engine, order: input.order, medianLine: lineSize, sfx: input.sfx,
        pageHeight: input.pageHeight, regionId: input.regionId,
      });
    } finally {
      img.delete();
      mask.delete();
    }
  }
}
