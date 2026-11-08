/**
 * Borrado del texto original y reconstrucción del fondo. Port de `render/inpaint.py`.
 *
 * Estrategia por región, de menor a mayor intervención:
 *  1. Fondo liso (globo blanco o de color plano): se rellena solo la máscara de texto con muestras
 *     reales del papel y nunca se pinta fuera de su contorno.
 *  2. Fondo con dibujo o trama: LaMa (red de inpainting) sobre un recorte local.
 *  3. Sin LaMa: inpainting clásico de OpenCV (Telea) como último recurso.
 * Los píxeles fuera de la máscara de texto no se modifican jamás.
 *
 * Cada región se procesa en una ventana local alrededor del texto (no en la página entera): el
 * resultado es el mismo y el consumo de memoria es el que un teléfono puede permitirse.
 */
import { cropClone, loadCv, scoped, type Cv, type Mat, type Scope } from '../runtime/cv';
import { ort, createSession, releaseSession, type OrtSession } from '../runtime/ort';
import type { Box, Poly } from '../vision/types';

const LAMA_SIZE = 512;

export interface EraseTarget {
  bbox: Box;
  lines: Poly[];
  lineSize: number;
  bubblePolygon: [number, number][] | null;
  fill: [number, number, number] | null;
  uniform: boolean;
}

export class LamaInpainter {
  private constructor(private readonly cv: Cv, private readonly session: OrtSession, private readonly imageName: string,
    private readonly maskName: string) {}

  static async create(cv: Cv, model: Uint8Array): Promise<LamaInpainter> {
    const session = await createSession(model);
    const names = [...session.inputNames];
    const maskName = names.find((n) => /mask/i.test(n)) ?? names[names.length - 1];
    const imageName = names.find((n) => n !== maskName) ?? names[0];
    return new LamaInpainter(cv, session, imageName, maskName);
  }

  dispose(): Promise<void> { return releaseSession(this.session); }

  /** `rgb`: recorte RGB; `mask`: 0/255. Devuelve el recorte reconstruido (RGB, mismo tamaño). */
  async run(rgb: Mat, mask: Mat): Promise<Mat> {
    const cv = this.cv;
    const h = rgb.rows, w = rgb.cols;
    const { image, m } = scoped((s) => {
      const img = s.add(new cv.Mat());
      cv.resize(rgb, img, new cv.Size(LAMA_SIZE, LAMA_SIZE), 0, 0, Math.max(h, w) > LAMA_SIZE ? cv.INTER_AREA : cv.INTER_CUBIC);
      const mk = s.add(new cv.Mat());
      cv.resize(mask, mk, new cv.Size(LAMA_SIZE, LAMA_SIZE), 0, 0, cv.INTER_NEAREST);
      const n = LAMA_SIZE * LAMA_SIZE;
      const image = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        image[i] = img.data[3 * i] / 255; image[n + i] = img.data[3 * i + 1] / 255; image[2 * n + i] = img.data[3 * i + 2] / 255;
      }
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = mk.data[i] > 0 ? 1 : 0;
      return { image, m };
    });
    const out = await this.session.run({
      [this.imageName]: new ort.Tensor('float32', image, [1, 3, LAMA_SIZE, LAMA_SIZE]),
      [this.maskName]: new ort.Tensor('float32', m, [1, 1, LAMA_SIZE, LAMA_SIZE]),
    });
    const data = out[this.session.outputNames[0]].data as Float32Array;
    const n = LAMA_SIZE * LAMA_SIZE;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
    const scale = max <= 1.5 ? 255 : 1;
    const result = new cv.Mat(LAMA_SIZE, LAMA_SIZE, cv.CV_8UC3);
    const rd = result.data;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) rd[3 * i + c] = Math.min(255, Math.max(0, Math.trunc(data[c * n + i] * scale)));
    }
    const resized = new cv.Mat();
    cv.resize(result, resized, new cv.Size(w, h), 0, 0, cv.INTER_CUBIC);
    result.delete();
    return resized;
  }
}

export type InpaintMode = 'auto' | 'lama' | 'fast';

export class Inpainter {
  private cv: Cv | null = null;
  constructor(public mode: InpaintMode, private readonly getLama: () => Promise<LamaInpainter | null>) {}

  async erase(img: Mat, textMask: Mat, targets: EraseTarget[]): Promise<Mat> {
    const cv = (this.cv ??= await loadCv());
    const out = img.clone();
    for (const t of targets) await this.eraseOne(cv, img, out, textMask, t);
    return out;
  }

  private async eraseOne(cv: Cv, img: Mat, out: Mat, textMask: Mat, t: EraseTarget): Promise<void> {
    const h = img.rows, w = img.cols;
    const [x1, y1, x2, y2] = t.bbox;
    const reach = Math.max(4, Math.trunc(t.lineSize * 0.6));
    const k = Math.max(2, Math.trunc(t.lineSize * 0.12));
    const margin = reach + k + 16;
    // Ventana local: contiene el texto y todo lo que las dilataciones pueden alcanzar.
    let [wx1, wy1, wx2, wy2] = [x1, y1, x2, y2];
    for (const p of t.lines) for (const [px, py] of p) {
      wx1 = Math.min(wx1, px); wy1 = Math.min(wy1, py); wx2 = Math.max(wx2, px); wy2 = Math.max(wy2, py);
    }
    wx1 = Math.max(0, wx1 - margin); wy1 = Math.max(0, wy1 - margin);
    wx2 = Math.min(w, wx2 + margin); wy2 = Math.min(h, wy2 + margin);
    if (wx2 <= wx1 || wy2 <= wy1) return;
    const win = new cv.Rect(wx1, wy1, wx2 - wx1, wy2 - wy1);

    const plan = scoped((s) => {
      const imgW = cropClone(s, img, win);
      const maskW = cropClone(s, textMask, win);
      const local = { ...t, bbox: [x1 - wx1, y1 - wy1, x2 - wx1, y2 - wy1] as Box,
        lines: t.lines.map((p) => p.map(([px, py]) => [px - wx1, py - wy1] as [number, number])),
        bubblePolygon: t.bubblePolygon?.map(([px, py]) => [px - wx1, py - wy1] as [number, number]) ?? null };
      const { regionMask, allowed } = regionMasks(cv, s, maskW, local);
      if (!countNonZero(regionMask)) return null;
      const bg = background(cv, s, imgW, regionMask, allowed, local.bbox);
      if (t.uniform || bg.uniformRatio >= 0.9) {
        const absorbed = absorbResidue(cv, s, imgW, regionMask, allowed, bg.median, t.lineSize);
        const fillMask = new Uint8Array(absorbed.data);
        return { kind: 'fill' as const, mask: fillMask, paper: bg.paper };
      }
      return { kind: 'inpaint' as const, mask: new Uint8Array(regionMask.data) };
    });
    if (!plan) return;

    const dstWin = out.roi(win);
    try {
      if (plan.kind === 'fill') {
        const rng = mulberry32(Math.trunc(x1 * 7919 + y1) >>> 0);
        // El recorte de OpenCV no es contiguo (su `data` no cubre el paso entre filas): se escribe en una copia.
        const buf = dstWin.clone();
        const dd = buf.data;
        const { paper } = plan;
        const nPaper = paper.length / 3;
        for (let y = 0; y < win.height; y++) {
          for (let x = 0; x < win.width; x++) {
            if (!plan.mask[y * win.width + x]) continue;
            const p = Math.floor(rng() * nPaper) * 3;
            const o = (y * win.width + x) * 3;
            dd[o] = paper[p]; dd[o + 1] = paper[p + 1]; dd[o + 2] = paper[p + 2];
          }
        }
        buf.copyTo(dstWin);
        buf.delete();
      } else {
        await this.inpaintRegion(cv, out, plan.mask, win, t);
      }
    } finally {
      dstWin.delete();
    }
  }

  /** Reconstruye con LaMa (o Telea) un recorte con contexto alrededor del texto. */
  private async inpaintRegion(cv: Cv, out: Mat, winMask: Uint8Array, win: { x: number; y: number; width: number; height: number }, t: EraseTarget): Promise<void> {
    const h = out.rows, w = out.cols;
    const [x1, y1, x2, y2] = t.bbox;
    const bw = x2 - x1, bh = y2 - y1;
    const side = Math.trunc(Math.max(bw, bh) * 1.6) + 32; // contexto para que LaMa entienda el dibujo
    const cx = (x1 + x2) >> 1, cy = (y1 + y2) >> 1;
    let sx1 = Math.max(0, cx - (side >> 1)), sy1 = Math.max(0, cy - (side >> 1));
    const sx2 = Math.min(w, sx1 + side), sy2 = Math.min(h, sy1 + side);
    sx1 = Math.max(0, sx2 - side); sy1 = Math.max(0, sy2 - side);
    const crop = new cv.Rect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    const cmask = new cv.Mat(crop.height, crop.width, cv.CV_8UC1, new cv.Scalar(0));
    let any = false;
    for (let y = 0; y < win.height; y++) {
      const gy = win.y + y - crop.y;
      if (gy < 0 || gy >= crop.height) continue;
      for (let x = 0; x < win.width; x++) {
        const gx = win.x + x - crop.x;
        if (gx < 0 || gx >= crop.width || !winMask[y * win.width + x]) continue;
        cmask.data[gy * crop.width + gx] = 255;
        any = true;
      }
    }
    if (!any) { cmask.delete(); return; }
    const target = out.roi(crop);
    const lama = this.mode === 'fast' ? null : await this.getLama();
    let result: Mat;
    const bgr = target.clone();
    try {
      if (lama) {
        const rgb = new cv.Mat();
        cv.cvtColor(bgr, rgb, cv.COLOR_BGR2RGB);
        const rec = await lama.run(rgb, cmask);
        result = new cv.Mat();
        cv.cvtColor(rec, result, cv.COLOR_RGB2BGR);
        rgb.delete(); rec.delete();
      } else {
        result = new cv.Mat();
        const radius = Math.max(3, Math.trunc(Math.min(bw, bh) * 0.03));
        cv.inpaint(bgr, cmask, result, radius, cv.INPAINT_TELEA);
      }
      const rd = result.data, td = target.data, stride = target.step[0];
      for (let y = 0; y < crop.height; y++) {
        for (let x = 0; x < crop.width; x++) {
          if (!cmask.data[y * crop.width + x]) continue;
          const o = y * stride + x * 3, r = (y * crop.width + x) * 3;
          td[o] = rd[r]; td[o + 1] = rd[r + 1]; td[o + 2] = rd[r + 2];
        }
      }
      result.delete();
    } finally {
      bgr.delete(); target.delete(); cmask.delete();
    }
  }
}

// ----------------------------------------------------------------------
// Máscaras y fondo (en coordenadas de la ventana local)
// ----------------------------------------------------------------------

type Sc = Scope;

const countNonZero = (m: Mat): number => { let n = 0; const d = m.data; for (let i = 0; i < d.length; i++) if (d[i]) n++; return n; };

function ellipse(cv: Cv, s: Sc, size: number): Mat {
  return s.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)));
}

function dilate(cv: Cv, s: Sc, src: Mat, kernel: Mat, iterations = 1): Mat {
  const dst = s.add(new cv.Mat());
  cv.dilate(src, dst, kernel, new cv.Point(-1, -1), iterations, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  return dst;
}

function fillPolys(cv: Cv, s: Sc, dst: Mat, polys: [number, number][][]): void {
  const mv = s.add(new cv.MatVector());
  for (const p of polys) mv.push_back(s.add(cv.matFromArray(p.length, 1, cv.CV_32SC2, p.flat())));
  cv.fillPoly(dst, mv, new cv.Scalar(255));
}

/** (máscara de texto dilatada, zona permitida). Fuera de la zona permitida nunca se modifica un píxel. */
function regionMasks(cv: Cv, s: Sc, textMask: Mat, t: EraseTarget): { regionMask: Mat; allowed: Mat } {
  const h = textMask.rows, w = textMask.cols;
  const [x1, y1, x2, y2] = t.bbox;
  const reach = Math.max(4, Math.trunc(t.lineSize * 0.6));
  let allowed = s.add(new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0)));
  let linesMask: Mat | null = null;
  if (t.lines.length) {
    fillPolys(cv, s, allowed, t.lines);
    linesMask = s.add(allowed.clone());
    allowed = dilate(cv, s, allowed, ellipse(cv, s, 2 * reach + 1));
  } else {
    const box = s.add(allowed.roi(new cv.Rect(Math.max(0, x1 - reach), Math.max(0, y1 - reach),
      Math.min(w, x2 + reach) - Math.max(0, x1 - reach), Math.min(h, y2 + reach) - Math.max(0, y1 - reach))));
    box.setTo(new cv.Scalar(255));
  }
  if (t.bubblePolygon) {
    const interior = s.add(new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0)));
    fillPolys(cv, s, interior, [t.bubblePolygon]);
    const eroded = s.add(new cv.Mat());
    cv.erode(interior, eroded, s.add(cv.Mat.ones(3, 3, cv.CV_8UC1)), new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const merged = s.add(new cv.Mat());
    cv.bitwise_and(allowed, eroded, merged);
    allowed = merged;
  }
  let mask = s.add(new cv.Mat());
  cv.bitwise_and(textMask, allowed, mask);
  const area = Math.max(1, (x2 - x1) * (y2 - y1));
  if (linesMask && countNonZero(mask) * 255 < 0.05 * 255 * area) mask = linesMask; // la segmentación falló: se usan las líneas
  const k = Math.max(2, Math.trunc(t.lineSize * 0.12));
  const grown = dilate(cv, s, mask, ellipse(cv, s, 2 * k + 1));
  const regionMask = s.add(new cv.Mat());
  cv.bitwise_and(grown, allowed, regionMask);
  return { regionMask, allowed };
}

/** Color de fondo (mediana), fracción del entorno que lo comparte y muestras de papel limpio (BGR planas). */
function background(cv: Cv, s: Sc, img: Mat, mask: Mat, allowed: Mat, bbox: Box): { median: number[]; uniformRatio: number; paper: Uint8Array } {
  const [x1, y1, x2, y2] = bbox;
  const h = mask.rows, w = mask.cols;
  const pad = 6;
  const sx1 = Math.max(0, x1 - pad), sy1 = Math.max(0, y1 - pad), sx2 = Math.min(w, x2 + pad), sy2 = Math.min(h, y2 + pad);
  const rect = new cv.Rect(sx1, sy1, sx2 - sx1, sy2 - sy1);
  const rw = rect.width, rh = rect.height;
  // Se excluye el halo de antialiasing para que el color de relleno sea el del papel limpio.
  const near = dilate(cv, s, cropClone(s, mask, rect), s.add(cv.Mat.ones(3, 3, cv.CV_8UC1)), 4);
  const allowedW = cropClone(s, allowed, rect);
  const imgW = cropClone(s, img, rect);
  const ring: number[] = [];
  for (let i = 0; i < rw * rh; i++) if (allowedW.data[i] > 0 && near.data[i] === 0) ring.push(i);
  const useAll = ring.length < 30;
  const count = useAll ? rw * rh : ring.length;
  const px = (k: number) => (useAll ? k : ring[k]) * 3;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let k = 0; k < count; k++) { const o = px(k); for (let c = 0; c < 3; c++) hist[c][imgW.data[o + c]]++; }
  const med = hist.map((hc) => medianFromHist(hc, count));
  const medInt = med.map((m) => Math.trunc(m)); // `median.astype(np.uint8)`
  let close = 0;
  const paper: number[] = [];
  for (let k = 0; k < count; k++) {
    const o = px(k);
    const d = Math.max(Math.abs(imgW.data[o] - medInt[0]), Math.abs(imgW.data[o + 1] - medInt[1]), Math.abs(imgW.data[o + 2] - medInt[2]));
    if (d <= 30) close++;
    if (d <= 6) paper.push(imgW.data[o], imgW.data[o + 1], imgW.data[o + 2]);
  }
  return { median: medInt, uniformRatio: count ? close / count : 0, paper: paper.length / 3 < 10 ? Uint8Array.from(medInt) : Uint8Array.from(paper) };
}

function medianFromHist(hist: Uint32Array, n: number): number {
  if (!n) return 0;
  const lo = Math.floor((n - 1) / 2), hi = Math.floor(n / 2);
  let seen = 0, a = -1, b = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (a < 0 && seen > lo) a = v;
    if (seen > hi) { b = v; break; }
  }
  return (a + b) / 2;
}

/** Añade a la máscara los restos de trazo (antialiasing, puntos, furigana) pegados a ella. */
function absorbResidue(cv: Cv, s: Sc, img: Mat, mask: Mat, allowed: Mat, fill: number[], lineSize: number): Mat {
  const n = img.rows * img.cols;
  const id = img.data, md = mask.data, ad = allowed.data;
  const diff = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    diff[i] = Math.max(Math.abs(id[3 * i] - fill[0]), Math.abs(id[3 * i + 1] - fill[1]), Math.abs(id[3 * i + 2] - fill[2]));
  }
  const residue = s.add(new cv.Mat(img.rows, img.cols, cv.CV_8UC1));
  for (let i = 0; i < n; i++) residue.data[i] = diff[i] > 45 && ad[i] > 0 && md[i] === 0 ? 1 : 0;
  const labels = s.add(new cv.Mat()), stats = s.add(new cv.Mat()), cent = s.add(new cv.Mat());
  const count = cv.connectedComponentsWithStats(residue, labels, stats, cent, 8, cv.CV_32S);
  if (count <= 1) return mask;
  const limit = Math.max(6.0, lineSize * 1.1);
  const k3 = s.add(cv.Mat.ones(3, 3, cv.CV_8UC1));
  const grown = dilate(cv, s, mask, k3, 3);
  const keep = new Uint8Array(count);
  const lab = labels.data32S, st = stats.data32S;
  for (let i = 0; i < n; i++) {
    const l = lab[i];
    if (l && grown.data[i] > 0 && residue.data[i] > 0 && Math.max(st[l * 5 + 2], st[l * 5 + 3]) <= limit) keep[l] = 1;
  }
  const out = s.add(mask.clone());
  for (let i = 0; i < n; i++) if (keep[lab[i]]) out.data[i] = 255;
  const out2 = dilate(cv, s, out, k3, 1);
  // Halo claro de antialiasing/JPEG alrededor de los trazos: diferencia pequeña pero visible.
  const halo = dilate(cv, s, out2, k3, 4);
  for (let i = 0; i < n; i++) if (halo.data[i] > 0 && diff[i] > 3) out2.data[i] = 255;
  const result = s.add(new cv.Mat());
  cv.bitwise_and(out2, allowed, result);
  return result;
}

/** Generador pseudoaleatorio determinista (el mismo borrado sale igual en cada ejecución). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
