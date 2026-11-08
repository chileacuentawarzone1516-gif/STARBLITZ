/**
 * OpenCV.js: carga única y utilidades para no perder memoria (los objetos de WebAssembly no los
 * recoge el recolector de basura: cada Mat se libera con `delete()`).
 */
import type * as CvNs from '@techstark/opencv-js';
import opencvUrl from '@techstark/opencv-js/dist/opencv.js?url';

export type Cv = typeof CvNs;
export type Mat = CvNs.Mat;

let loading: Promise<Cv> | null = null;

export function loadCv(): Promise<Cv> {
  loading ??= initCv();
  return loading;
}

/**
 * OpenCV.js 4.x se distribuye como un único script UMD que deja `cv` en el ámbito global. El módulo `cv` es
 * «thenable» (tiene `then`), y cualquier `import()` o `async` que lo devuelva lo vuelve a esperar sin fin (bucle
 * infinito en el empaquetador). Por eso se carga como archivo estático, sin pasar por `import`, y se le quita
 * `then` en cuanto el motor está inicializado.
 */
async function initCv(): Promise<Cv> {
  const g = globalThis as unknown as { cv?: CvModule };
  if (!g.cv) {
    const code = await (await fetch(opencvUrl)).text();
    (0, eval)(code); // eslint-disable-line no-eval -- script UMD de OpenCV.js empaquetado con la app; define `cv` en globalThis
  }
  const cv = g.cv;
  if (!cv) throw new Error('No se pudo cargar OpenCV.js.');
  if (!cv.Mat) {
    await new Promise<void>((resolve) => { cv.onRuntimeInitialized = () => resolve(); });
  }
  if (typeof cv.then === 'function') delete cv.then;
  return cv as unknown as Cv;
}

interface CvModule { Mat?: unknown; then?: unknown; onRuntimeInitialized?: () => void }

type Deletable = { delete(): void };

/** Agrupa objetos de OpenCV y los libera todos al terminar, aunque haya una excepción. */
export class Scope {
  private items: Deletable[] = [];
  add<T extends Deletable>(item: T): T { this.items.push(item); return item; }
  dispose(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      try { this.items[i].delete(); } catch { /* ya liberado */ }
    }
    this.items = [];
  }
}

export function scoped<T>(fn: (s: Scope) => T): T {
  const s = new Scope();
  try { return fn(s); } finally { s.dispose(); }
}

export async function scopedAsync<T>(fn: (s: Scope) => Promise<T>): Promise<T> {
  const s = new Scope();
  try { return await fn(s); } finally { s.dispose(); }
}

/** Copia contigua (no compartida) de una región; el `roi` intermedio y la copia se liberan con el ámbito. */
export function cropClone(s: Scope, mat: Mat, rect: CvNs.Rect): Mat {
  const view = s.add(mat.roi(rect));
  return s.add(view.clone());
}

/** Decodifica una imagen (JPEG/PNG/WebP…) a una matriz BGR de 8 bits, respetando la orientación EXIF. */
export async function decodeToBgr(cv: Cv, blob: Blob): Promise<Mat> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No se pudo preparar el lienzo para leer la imagen.');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return rgbaToBgr(cv, data.data, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Decodifica una imagen a un solo canal (gris) de 8 bits; se usa para las máscaras guardadas como PNG. */
export async function decodeToGray(cv: Cv, blob: Blob): Promise<Mat> {
  const bgr = await decodeToBgr(cv, blob);
  try {
    const gray = new cv.Mat();
    cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
    return gray;
  } finally {
    bgr.delete();
  }
}

export function rgbaToBgr(cv: Cv, rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Mat {
  const rgbaMat = new cv.Mat(height, width, cv.CV_8UC4);
  rgbaMat.data.set(rgba);
  const bgr = new cv.Mat();
  cv.cvtColor(rgbaMat, bgr, cv.COLOR_RGBA2BGR);
  rgbaMat.delete();
  return bgr;
}

/** Codifica una matriz BGR (3 canales) o de grises (1 canal) como PNG o JPEG. */
export async function encodeMat(cv: Cv, mat: Mat, type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.9): Promise<Blob> {
  const rgba = new cv.Mat();
  try {
    cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_BGR2RGBA);
    const canvas = new OffscreenCanvas(mat.cols, mat.rows);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar el lienzo para guardar la imagen.');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), mat.cols, mat.rows), 0, 0);
    return await canvas.convertToBlob({ type, quality });
  } finally {
    rgba.delete();
  }
}

/** Reduce una imagen para usarla de miniatura (lado mayor `max`). */
export function resizeToFit(cv: Cv, mat: Mat, max: number): Mat {
  const scale = Math.min(1, max / Math.max(mat.cols, mat.rows));
  const out = new cv.Mat();
  if (scale >= 1) { mat.copyTo(out); return out; }
  cv.resize(mat, out, new cv.Size(Math.max(1, Math.round(mat.cols * scale)), Math.max(1, Math.round(mat.rows * scale))), 0, 0, cv.INTER_AREA);
  return out;
}

/** `round()` de Python: el redondeo de la mitad va al par (necesario para coincidir con el motor de escritorio). */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (!n) return 0;
  const s = Array.from(values).sort((a, b) => a - b);
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Mediana de cada canal de una lista de píxeles (valores 0–255) con un histograma: exacta y rápida. */
export function channelMedians(data: Uint8Array | Uint8ClampedArray, channels: number, indices?: Int32Array | number[]): number[] {
  const hist = Array.from({ length: channels }, () => new Uint32Array(256));
  const count = indices ? indices.length : data.length / channels;
  for (let k = 0; k < count; k++) {
    const base = (indices ? indices[k] : k) * channels;
    for (let c = 0; c < channels; c++) hist[c][data[base + c]]++;
  }
  return hist.map((h) => histMedian(h, count));
}

function histMedian(hist: Uint32Array, n: number): number {
  if (!n) return 0;
  const lo = Math.floor((n - 1) / 2);
  const hi = Math.floor(n / 2);
  let seen = 0, a = -1, b = -1;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (a < 0 && seen > lo) a = v;
    if (seen > hi) { b = v; break; }
  }
  return (a + b) / 2;
}
