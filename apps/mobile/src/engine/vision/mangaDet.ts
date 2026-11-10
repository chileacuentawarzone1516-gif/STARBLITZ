/**
 * Detector de texto EXPERIMENTAL: líneas de PP-OCRv6 Manga (`manga_det`, Apache-2.0 declarada). Port de
 * `engine/starblitz_engine/vision/manga_det.py` (mismos parámetros y misma lógica).
 *
 * Qué hace el MODELO: solo un mapa de probabilidad de líneas de texto (cabeza DB).
 * Qué hace ESTE MÓDULO (código de STARBLITZ): post-procesado DB → polígonos de línea; agrupación de líneas en bloques
 * (`clusterLines`, la misma regla que el detector por defecto usa para el texto fuera de globos) y máscara de trazos dentro de
 * cada línea por Otsu (el modelo no da una máscara de trazos). La asociación con globos y el orden de lectura no cambian.
 */
import { loadCv, median, scoped, type Cv, type Mat } from '../runtime/cv';
import { ort, type OrtSession } from '../runtime/ort';
import { clusterLines, dedupeAcross, orderPoints, tileSpans } from './detector';
import { blockArea, lineGeometry, polyBBox, type Box, type DetectedBlock, type Poly } from './types';

// La ficha dice 960; con rotulación pequeña de cómic occidental a 960 se pierde la mitad de las líneas (medido 2026-11-09: 106/208
// palabras de referencia en una doble página frente a 207/208 a 1600). Igual que el motor Python. Con manga japonés NO está medido.
export const LONG_SIDE = 1600;
const BIN_THRESH = 0.15;
const BOX_THRESH = 0.25;
const UNCLIP_RATIO = 1.5;
const MIN_SIDE = 3;
const MAX_CONTOURS = 3000;
const MASK_DILATE = 2;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Tamaño de entrada: lado largo LONG_SIDE redondeado a múltiplos de 32 (como el ejemplo oficial y el motor Python). */
export function inputSize(w: number, h: number): [number, number] {
  const ratio = LONG_SIDE / Math.max(h, w);
  // Math.round de JS y round() de Python difieren en .5 exacto; con estas proporciones no se da, pero se usa el redondeo bancario por paridad.
  const r32 = (v: number) => { const x = v / 32; const f = Math.floor(x); const d = x - f; return (d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f) * 32; };
  return [Math.max(32, r32(w * ratio)), Math.max(32, r32(h * ratio))];
}

export class MangaLineDetector {
  readonly kind = 'manga-det';
  private inferMs = 0;

  private constructor(private readonly cv: Cv, private readonly session: OrtSession) {}

  static async create(session: OrtSession): Promise<MangaLineDetector> {
    return new MangaLineDetector(await loadCv(), session);
  }

  async detect(img: Mat): Promise<{ blocks: DetectedBlock[]; mask: Mat; stats: { infer_ms: number; tiles: number } }> {
    const cv = this.cv;
    this.inferMs = 0;
    const h = img.rows, w = img.cols;
    const alongY = h >= w;
    const spans = tileSpans(Math.max(h, w), Math.min(h, w));
    let lines: Poly[] = [], scores: number[] = [];
    if (spans.length === 1) {
      ({ lines, scores } = await this.detectLines(img));
    } else {
      const partOf: number[] = [];
      const axis = alongY ? 1 : 0;
      for (let k = 0; k < spans.length; k++) {
        const [start, end, ownStart, ownEnd] = spans[k];
        const rect = alongY ? new cv.Rect(0, start, w, end - start) : new cv.Rect(start, 0, end - start, h);
        const crop = img.roi(rect);
        try {
          const r = await this.detectLines(crop);
          r.lines.forEach((poly, i) => {
            const p = poly.map(([x, y]) => (axis === 1 ? [x, y + start] : [x + start, y]) as [number, number]);
            const c = p.reduce((s, q) => s + q[axis], 0) / p.length;
            if (c >= ownStart && c < ownEnd) { lines.push(p); scores.push(r.scores[i]); partOf.push(k); }
          });
        } finally {
          crop.delete();
        }
      }
      const keep = dedupeAcross(lines.map(polyBBox), partOf, scores);
      lines = keep.map((i) => lines[i]);
      scores = keep.map((i) => scores[i]);
    }
    const mask = lineMask(cv, img, lines);
    return { blocks: groupLines(lines, scores, w, h), mask, stats: { infer_ms: this.inferMs, tiles: spans.length } };
  }

  private async detectLines(img: Mat): Promise<{ lines: Poly[]; scores: number[] }> {
    const cv = this.cv;
    const h = img.rows, w = img.cols;
    const [rw, rh] = inputSize(w, h);
    const tensor = scoped((s) => {
      const resized = s.add(new cv.Mat());
      cv.resize(img, resized, new cv.Size(rw, rh), 0, 0, rw < w ? cv.INTER_AREA : cv.INTER_LINEAR);
      const src = resized.data;
      const plane = rw * rh;
      const out = new Float32Array(3 * plane);
      // Entrada BGR (como cv2.imread en el ejemplo oficial) normalizada con media/desviación de ImageNet por canal.
      for (let i = 0; i < plane; i++) {
        for (let c = 0; c < 3; c++) out[c * plane + i] = (src[i * 3 + c] / 255 - MEAN[c]) / STD[c];
      }
      return out;
    });
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, rh, rw]) };
    const t = performance.now();
    const outputs = await this.session.run(feeds);
    this.inferMs += performance.now() - t;
    const out = outputs[this.session.outputNames[0]];
    const prob = (out.data as Float32Array).subarray(0, rw * rh);
    return dbLines(cv, prob, rw, rh, w / rw, h / rh, w, h);
  }
}

/** Post-procesado DB: contornos sobre el umbral, puntuación media y expansión del polígono. */
export function dbLines(cv: Cv, prob: Float32Array, pw: number, ph: number, sx: number, sy: number, w: number, h: number): { lines: Poly[]; scores: number[] } {
  return scoped((s) => {
    const bitmap = s.add(new cv.Mat(ph, pw, cv.CV_8UC1));
    const bd = bitmap.data;
    for (let i = 0; i < bd.length; i++) bd[i] = prob[i] > BIN_THRESH ? 1 : 0;
    const contours = s.add(new cv.MatVector());
    const hierarchy = s.add(new cv.Mat());
    cv.findContours(bitmap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const lines: Poly[] = [], scores: number[] = [];
    const count = Math.min(contours.size(), MAX_CONTOURS);
    for (let ci = 0; ci < count; ci++) {
      const contour = contours.get(ci);
      try {
        if (contour.rows < 4) continue;
        const rect = cv.boundingRect(contour);
        const score = meanInside(cv, contour, rect, prob, pw);
        if (score < BOX_THRESH) continue;
        const area = cv.contourArea(contour);
        const perimeter = cv.arcLength(contour, true);
        if (area <= 0 || perimeter <= 0) continue;
        const rr = cv.minAreaRect(contour);
        const d = (area * UNCLIP_RATIO) / perimeter;
        const grown = { center: rr.center, size: { width: rr.size.width + 2 * d, height: rr.size.height + 2 * d }, angle: rr.angle };
        if (Math.min(grown.size.width, grown.size.height) < MIN_SIDE) continue;
        const pts = (cv.RotatedRect as unknown as { points(r: unknown): { x: number; y: number }[] }).points(grown)
          .map((p) => [Math.min(Math.max(p.x * sx, 0), w), Math.min(Math.max(p.y * sy, 0), h)] as [number, number]);
        lines.push(orderPoints(pts).map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]));
        scores.push(score);
      } finally {
        contour.delete();
      }
    }
    return { lines, scores };
  });
}

function meanInside(cv: Cv, contour: Mat, rect: { x: number; y: number; width: number; height: number }, prob: Float32Array, stride: number): number {
  return scoped((s) => {
    const { x, y, width: cw, height: ch } = rect;
    const region = s.add(new cv.Mat(ch, cw, cv.CV_8UC1, new cv.Scalar(0)));
    const shifted = s.add(new cv.Mat(contour.rows, 1, cv.CV_32SC2));
    const src = contour.data32S, dst = shifted.data32S;
    for (let i = 0; i < contour.rows; i++) { dst[2 * i] = src[2 * i] - x; dst[2 * i + 1] = src[2 * i + 1] - y; }
    const mv = s.add(new cv.MatVector());
    mv.push_back(shifted);
    cv.fillPoly(region, mv, new cv.Scalar(1));
    let sum = 0, n = 0;
    const rd = region.data;
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) if (rd[yy * cw + xx]) { sum += prob[(y + yy) * stride + x + xx]; n++; }
    }
    return n ? sum / n : 0;
  });
}

/** Bloques a partir de líneas (el modelo no detecta bloques ni globos). */
export function groupLines(lines: Poly[], scores: number[], w: number, h: number): DetectedBlock[] {
  const scoreOf = new Map<Poly, number>(lines.map((p, i) => [p, scores[i]]));
  const blocks: DetectedBlock[] = [];
  for (const group of clusterLines(lines)) {
    const geoms = group.map(lineGeometry);
    const [x1, y1, x2, y2] = polyBBox(group.flat() as [number, number][]);
    const elongated = geoms.filter((g) => g.length > g.thickness * 1.5);
    const vertical = elongated.length ? elongated.filter((g) => g.vertical).length * 2 > elongated.length : (y2 - y1) > (x2 - x1) * 1.2;
    const conf = group.reduce((s, p) => s + (scoreOf.get(p) ?? 0), 0) / group.length;
    const b: DetectedBlock = { bbox: [Math.max(0, x1), Math.max(0, y1), Math.min(w, x2), Math.min(h, y2)] as Box, lines: group, vertical,
      confidence: conf, langHint: 'unknown', lineSize: median(geoms.map((g) => g.thickness)) };
    if (blockArea(b) >= 64) blocks.push(b);
  }
  return blocks;
}

/** Máscara de trazos de texto dentro de cada línea (Otsu local; la clase minoritaria son los trazos). */
export function lineMask(cv: Cv, img: Mat, lines: Poly[]): Mat {
  const h = img.rows, w = img.cols;
  const mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
  if (!lines.length) return mask;
  scoped((s) => {
    const gray = s.add(new cv.Mat());
    cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);
    const kernel = s.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * MASK_DILATE + 1, 2 * MASK_DILATE + 1)));
    const g = gray.data, md = mask.data;
    for (const poly of lines) {
      let [x1, y1, x2, y2] = polyBBox(poly);
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(w, x2 + 1); y2 = Math.min(h, y2 + 1);
      const cw = x2 - x1, ch = y2 - y1;
      if (cw < 2 || ch < 2) continue;
      scoped((t) => {
        const inside = t.add(new cv.Mat(ch, cw, cv.CV_8UC1, new cv.Scalar(0)));
        const pts = t.add(cv.matFromArray(4, 1, cv.CV_32SC2, poly.flatMap(([x, y]) => [x - x1, y - y1])));
        const mv = t.add(new cv.MatVector());
        mv.push_back(pts);
        cv.fillPoly(inside, mv, new cv.Scalar(1));
        const ins = inside.data;
        const vals: number[] = [];
        let lo = 255, hi = 0;
        for (let yy = 0; yy < ch; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            if (!ins[yy * cw + xx]) continue;
            const v = g[(y1 + yy) * w + x1 + xx];
            vals.push(v); if (v < lo) lo = v; if (v > hi) hi = v;
          }
        }
        if (vals.length < 8 || hi - lo < 24) return; // sin contraste: no hay trazos que separar
        const col = t.add(cv.matFromArray(vals.length, 1, cv.CV_8UC1, vals));
        const bin = t.add(new cv.Mat());
        const thr = cv.threshold(col, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        let dark = 0;
        for (const v of vals) if (v <= thr) dark++;
        const darkIsText = dark <= vals.length - dark;
        const strokes = t.add(new cv.Mat(ch, cw, cv.CV_8UC1, new cv.Scalar(0)));
        const sd = strokes.data;
        for (let yy = 0; yy < ch; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            const k = yy * cw + xx;
            if (!ins[k]) continue;
            const v = g[(y1 + yy) * w + x1 + xx];
            if ((v <= thr) === darkIsText) sd[k] = 255;
          }
        }
        const grown = t.add(new cv.Mat());
        cv.dilate(strokes, grown, kernel);
        const gd = grown.data;
        for (let yy = 0; yy < ch; yy++) {
          for (let xx = 0; xx < cw; xx++) {
            const k = yy * cw + xx;
            if (ins[k] && gd[k] > md[(y1 + yy) * w + x1 + xx]) md[(y1 + yy) * w + x1 + xx] = gd[k];
          }
        }
      });
    }
  });
  return mask;
}
