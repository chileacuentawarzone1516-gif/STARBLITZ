/**
 * Construcción de las regiones de texto a partir de lo que detecta la visión (equivalente a `_make_region`,
 * `_classify`, `_grow_into_free_space` y `_split_lines` de `pipeline/processor.py`).
 */
import type { Region, RegionKind } from '@starblitz/shared';
import { newId } from '../core/ids';
import { defaultStyle, newRegion } from '../core/schema';
import { cropClone, scoped, type Cv, type Mat } from '../runtime/cv';
import { estimateMaxChars } from '../translate/contextual';
import { findBubble, textRingStats, type BubbleInfo } from './bubbles';
import type { Box, DetectedBlock, Poly } from './types';

/** Área de un polígono (fórmula de Gauss con coordenadas enteras, como `cv2.contourArea`). */
export function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i].map(Math.trunc), [x2, y2] = poly[(i + 1) % poly.length].map(Math.trunc);
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function classify(block: DetectedBlock, bubble: BubbleInfo | null, medianLine: number): RegionKind {
  if (bubble) {
    const [x1, y1, x2, y2] = bubble.bbox;
    const rectFill = polygonArea(bubble.polygon) / Math.max(1, (x2 - x1) * (y2 - y1));
    return bubble.polygon.length <= 6 && rectFill > 0.93 ? 'narration' : 'dialogue'; // cartela rectangular
  }
  if (medianLine && block.lineSize > medianLine * 2.4 && block.lines.length <= 2) return 'sfx';
  return block.lines.length >= 2 ? 'narration' : 'other';
}

/**
 * Amplía el área de un texto sin globo hacia el fondo liso que lo rodea (sin invadir el dibujo), para que la
 * traducción horizontal no quede comprimida en una columna estrecha.
 */
export function growIntoFreeSpace(img: Mat, mask: Mat, bbox: Box, bg: number[]): Box {
  const h = img.rows, w = img.cols;
  let [x1, y1, x2, y2] = bbox;
  const bw = x2 - x1, bh = y2 - y1;
  const b0 = Math.trunc(bg[0]), b1 = Math.trunc(bg[1]), b2 = Math.trunc(bg[2]);
  const px = img.data, mk = mask.data;
  const clear = (ax1: number, ay1: number, ax2: number, ay2: number): boolean => {
    if (ax1 < 0 || ay1 < 0 || ax2 > w || ay2 > h || ax2 <= ax1 || ay2 <= ay1) return false;
    let free = 0;
    for (let y = ay1; y < ay2; y++) {
      for (let x = ax1; x < ax2; x++) {
        const i = y * w + x, o = i * 3;
        const d = Math.max(Math.abs(px[o] - b0), Math.abs(px[o + 1] - b1), Math.abs(px[o + 2] - b2));
        if (d < 28 || mk[i] > 0) free++;
      }
    }
    return free / ((ax2 - ax1) * (ay2 - ay1)) > 0.985;
  };
  const stepX = Math.max(2, Math.trunc(bw * 0.05)), stepY = Math.max(2, Math.trunc(bh * 0.05));
  for (let n = 0; n < 12; n++) { // hasta +60 % por lado
    let grown = false;
    if (x2 - x1 < bw * 2.2 && clear(x1 - stepX, y1, x1, y2)) { x1 -= stepX; grown = true; }
    if (x2 - x1 < bw * 2.2 && clear(x2, y1, x2 + stepX, y2)) { x2 += stepX; grown = true; }
    if (!grown) break;
  }
  for (let n = 0; n < 6; n++) { // hasta +30 % por lado
    let grown = false;
    if (clear(x1, y1 - stepY, x2, y1)) { y1 -= stepY; grown = true; }
    if (clear(x1, y2, x2, y2 + stepY)) { y2 += stepY; grown = true; }
    if (!grown) break;
  }
  // Margen interior para no pegar el texto al dibujo vecino.
  const mx = Math.trunc((x2 - x1 - bw) * 0.15), my = Math.trunc((y2 - y1 - bh) * 0.15);
  return [x1 + mx, y1 + my, x2 - mx, y2 - my];
}

/** Separa líneas o columnas de un área dibujada por la persona mediante proyecciones. */
export function splitLines(cv: Cv, img: Mat, mask: Mat, bbox: Box, vertical: boolean): Poly[] {
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return [];
  const sub = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    const row = (y1 + y) * mask.cols + x1;
    for (let x = 0; x < w; x++) if (mask.data[row + x] > 0) { sub[y * w + x] = 1; count++; }
  }
  if (count < 20) { // sin máscara: se binariza la zona (texto oscuro sobre claro o al revés)
    scoped((s) => {
      const crop = cropClone(s, img, new cv.Rect(x1, y1, w, h));
      const gray = s.add(new cv.Mat());
      cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
      const bw = s.add(new cv.Mat());
      cv.threshold(gray, bw, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      let zeros = 0;
      for (let i = 0; i < bw.data.length; i++) if (bw.data[i] === 0) zeros++;
      const darkText = zeros / bw.data.length < 0.5;
      for (let i = 0; i < sub.length; i++) sub[i] = (darkText ? bw.data[i] === 0 : bw.data[i] > 0) ? 1 : 0;
    });
  }
  const length = vertical ? w : h, across = vertical ? h : w;
  const profile = new Float32Array(length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sub[y * w + x]) profile[vertical ? x : y] += 1;
  let peak = 0;
  for (const v of profile) if (v > peak) peak = v;
  if (peak <= 0) return [];
  const thr = Math.max(1, peak * 0.05);
  const segments: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const on = i < length && profile[i] > thr;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      if (i - start >= 3) segments.push([start, i]);
      start = -1;
    }
  }
  const lines: Poly[] = [];
  for (const [a, b] of segments) {
    const pad = Math.max(1, Math.trunc((b - a) / 6));
    let first = -1, last = -1;
    for (let k = 0; k < across; k++) { // primer y último punto con texto a lo largo de la línea
      let any = false;
      for (let t = a; t < b && !any; t++) any = !!sub[vertical ? k * w + t : t * w + k];
      if (any) { if (first < 0) first = k; last = k; }
    }
    if (first < 0) continue;
    let lx1: number, lx2: number, ly1: number, ly2: number;
    if (vertical) { lx1 = x1 + Math.max(0, a - pad); lx2 = x1 + Math.min(w, b + pad); ly1 = y1 + first; ly2 = y1 + last + 1; }
    else { ly1 = y1 + Math.max(0, a - pad); ly2 = y1 + Math.min(h, b + pad); lx1 = x1 + first; lx2 = x1 + last + 1; }
    lines.push([[lx1, ly1], [lx2, ly1], [lx2, ly2], [lx1, ly2]]);
  }
  return lines;
}

export interface MakeRegionInput {
  img: Mat;
  mask: Mat;
  block: DetectedBlock;
  text: string;
  confidence: number;
  engine: string;
  order: number;
  medianLine: number;
  sfx: 'keep' | 'note';
  pageHeight: number;
  regionId?: string | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function makeRegion(cv: Cv, i: MakeRegionInput): Region {
  const { img, mask, block } = i;
  const bubble = findBubble(cv, img, mask, block);
  const [x1, y1, x2, y2] = block.bbox;
  const bw = x2 - x1, bh = y2 - y1;
  const h = img.rows, w = img.cols;
  const ring = textRingStats(cv, img, mask, block.bbox);
  const bg = ring.median;
  let layout: Box;
  if (bubble) {
    // Se usa todo el interior del globo (el polígono ajusta el ancho de cada línea): los globos verticales
    // japoneses son estrechos y el español horizontal necesita su anchura completa.
    const [bx1, by1, bx2, by2] = bubble.bbox;
    const ix = Math.trunc((bx2 - bx1) * 0.06), iy = Math.trunc((by2 - by1) * 0.08);
    layout = [Math.min(bx1 + ix, x1), Math.min(by1 + iy, y1), Math.max(bx2 - ix, x2), Math.max(by2 - iy, y2)];
  } else if (ring.spread < 12) {
    layout = growIntoFreeSpace(img, mask, block.bbox, bg);
  } else {
    layout = [Math.max(0, x1 - Math.trunc(bw * 0.08)), Math.max(0, y1 - Math.trunc(bh * 0.08)), Math.min(w, x2 + Math.trunc(bw * 0.08)), Math.min(h, y2 + Math.trunc(bh * 0.08))];
  }
  const kind = classify(block, bubble, i.medianLine);
  const darkBg = (bg[0] + bg[1] + bg[2]) / 3 < 100;
  const style = defaultStyle();
  style.font = kind === 'narration' ? 'narration' : kind === 'sfx' ? 'sfx' : 'dialogue';
  if (darkBg) { style.color = '#ffffff'; style.stroke_color = '#000000'; }
  if (!bubble && ring.spread >= 12) style.stroke_width = round1(Math.max(2.0, block.lineSize * 0.12)); // legibilidad sobre dibujo
  if (kind === 'sfx') { style.uppercase = true; style.stroke_width = Math.max(style.stroke_width, 3.0); }
  const layoutBox = layout.map(Math.trunc) as Box;
  return newRegion({
    id: i.regionId || newId('r'), order: i.order, kind, bbox: block.bbox, lines: block.lines.map((p) => p.map(([px, py]) => [Math.trunc(px), Math.trunc(py)] as [number, number])),
    vertical: block.vertical, line_size: round1(block.lineSize), bubble: bubble ? { polygon: bubble.polygon, bbox: bubble.bbox, fill: bubble.fill, uniform: bubble.uniform } : null,
    layout_box: layoutBox, source_text: i.text, ocr_confidence: Math.round(i.confidence * 1000) / 1000, ocr_engine: i.engine,
    max_chars: estimateMaxChars(layoutBox, block.lineSize, i.pageHeight, bubble !== null), style,
    // Las onomatopeyas forman parte del dibujo: no se borran; con sfx="note" se rotula su traducción encima.
    erase: kind !== 'sfx', render: kind !== 'sfx' || i.sfx === 'note',
  });
}
