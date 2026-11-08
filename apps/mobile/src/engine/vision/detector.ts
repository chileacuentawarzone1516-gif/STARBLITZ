/**
 * Detección de bloques de texto, líneas y máscara de píxeles de texto.
 * Port fiel de `engine/starblitz_engine/vision/detector.py` (comic-text-detector: YOLOv5 para bloques +
 * DBNet para líneas + U-Net para la máscara) sobre ONNX Runtime Web.
 */
import { loadCv, pyRound, scoped, median, type Cv, type Mat } from '../runtime/cv';
import { ort, type OrtSession } from '../runtime/ort';
import { blockArea, lineGeometry, polyBBox, polyCenter, type Box, type DetectedBlock, type Poly } from './types';

export const INPUT_SIZE = 1024;
const CONF_THRESH = 0.4;
const NMS_THRESH = 0.35;
const LINE_BIN_THRESH = 0.3;
const LINE_SCORE_THRESH = 0.6;
const UNCLIP_RATIO = 1.5;
const MASK_THRESH = 0.3;
const LANGS = ['eng', 'ja'] as const;

// Páginas alargadas (tiras de webtoon): se analizan por tramos solapados.
const TILE_ASPECT = 1.6;
const TILE_LENGTH = 1.4;
const TILE_STRIDE = 0.6;

interface Detections { boxes: Box[]; confs: number[]; classes: number[]; lines: Poly[] }

export class TextDetector {
  private constructor(private readonly cv: Cv, private readonly session: OrtSession) {}

  static async create(session: OrtSession): Promise<TextDetector> {
    return new TextDetector(await loadCv(), session);
  }

  /** Detecta el texto de una página (matriz BGR). La máscara devuelta es de un canal, 0/255, a resolución original. */
  async detect(img: Mat): Promise<{ blocks: DetectedBlock[]; mask: Mat }> {
    const cv = this.cv;
    const h = img.rows, w = img.cols;
    const alongY = h >= w;
    const spans = tileSpans(Math.max(h, w), Math.min(h, w));
    let det: Detections;
    let prob: Float32Array;
    if (spans.length === 1) {
      const r = await this.infer(img);
      det = r.det;
      prob = r.prob;
    } else {
      prob = new Float32Array(w * h);
      const parts: Detections[] = [];
      for (const [start, end, ownStart, ownEnd] of spans) {
        const rect = alongY ? new cv.Rect(0, start, w, end - start) : new cv.Rect(start, 0, end - start, h);
        const crop = img.roi(rect);
        try {
          const r = await this.infer(crop);
          if (alongY) {
            // Las filas son contiguas: el tramo se funde con un máximo fila a fila.
            const off = start * w;
            for (let i = 0; i < r.prob.length; i++) if (r.prob[i] > prob[off + i]) prob[off + i] = r.prob[i];
          } else {
            const cw = end - start;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < cw; x++) {
                const v = r.prob[y * cw + x];
                if (v > prob[y * w + start + x]) prob[y * w + start + x] = v;
              }
            }
          }
          parts.push(shiftAndOwn(r.det, start, ownStart, ownEnd, alongY));
        } finally {
          crop.delete();
        }
      }
      det = mergeParts(parts);
    }
    const mask = new cv.Mat(h, w, cv.CV_8UC1);
    const md = mask.data;
    for (let i = 0; i < md.length; i++) md[i] = prob[i] > MASK_THRESH ? 255 : 0;
    return { blocks: group(det, w, h), mask };
  }

  /** Una pasada del modelo: bloques, líneas y probabilidad de texto por píxel. */
  private async infer(img: Mat): Promise<{ det: Detections; prob: Float32Array }> {
    const cv = this.cv;
    const h = img.rows, w = img.cols;
    const { tensor, ratio, padW, padH } = letterbox(cv, img);
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
    const outputs = await this.session.run(feeds);
    const { blk, seg, det } = splitOutputs(outputs);

    const boxesPart = yoloPostprocess(blk.data as Float32Array, blk.dims[1], blk.dims[2], ratio, w, h);
    const lines = dbLines(cv, (det.data as Float32Array).subarray(0, INPUT_SIZE * INPUT_SIZE), ratio, w, h);

    const validH = INPUT_SIZE - padH, validW = INPUT_SIZE - padW;
    const prob = scoped((s) => {
      const full = seg.data as Float32Array;
      const crop = s.add(new cv.Mat(validH, validW, cv.CV_32FC1));
      const dst = crop.data32F;
      for (let y = 0; y < validH; y++) dst.set(full.subarray(y * INPUT_SIZE, y * INPUT_SIZE + validW), y * validW);
      const resized = s.add(new cv.Mat());
      cv.resize(crop, resized, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
      return new Float32Array(resized.data32F);
    });
    return { det: { ...boxesPart, lines }, prob };
  }
}

// ----------------------------------------------------------------------
// Tramos para páginas alargadas
// ----------------------------------------------------------------------

/** Tramos (inicio, fin, inicio_propio, fin_propio) a lo largo del lado largo. */
export function tileSpans(length: number, short: number): [number, number, number, number][] {
  if (length <= short * TILE_ASPECT) return [[0, length, 0, length]];
  const tile = Math.max(1, pyRound(short * TILE_LENGTH));
  const stride = Math.max(1, Math.trunc(tile * TILE_STRIDE));
  const starts: number[] = [];
  for (let s = 0; s <= length - tile; s += stride) starts.push(s);
  if (starts[starts.length - 1] + tile < length) starts.push(length - tile);
  const ends = starts.map((s) => s + tile);
  const cuts = starts.slice(0, -1).map((_, i) => Math.floor((ends[i] + starts[i + 1]) / 2));
  const ownStarts = [0, ...cuts];
  const ownEnds = [...cuts, length];
  return starts.map((s, i) => [s, ends[i], ownStarts[i], ownEnds[i]]);
}

function shiftAndOwn(d: Detections, start: number, ownStart: number, ownEnd: number, alongY: boolean): Detections {
  const axis = alongY ? 1 : 0;
  const boxes: Box[] = [], confs: number[] = [], classes: number[] = [];
  d.boxes.forEach((b, i) => {
    const nb: Box = [...b];
    nb[axis] += start;
    nb[axis + 2] += start;
    const center = (nb[axis] + nb[axis + 2]) / 2;
    if (center >= ownStart && center < ownEnd) { boxes.push(nb); confs.push(d.confs[i]); classes.push(d.classes[i]); }
  });
  const lines: Poly[] = [];
  for (const poly of d.lines) {
    const moved = poly.map(([x, y]) => (alongY ? [x, y + start] : [x + start, y]) as [number, number]);
    const c = moved.reduce((a, p) => a + p[axis], 0) / moved.length;
    if (c >= ownStart && c < ownEnd) lines.push(moved);
  }
  return { boxes, confs, classes, lines };
}

function containment(a: Box, b: Box): number {
  const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (iw <= 0 || ih <= 0) return 0;
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return (iw * ih) / Math.max(smaller, 1);
}

/** Entre tramos distintos, un rectángulo casi entero dentro de otro de mayor prioridad es el mismo texto recortado. */
function dedupeAcross(rects: Box[], partOf: number[], priority: number[]): number[] {
  const kept: number[] = [];
  const order = rects.map((_, i) => i).sort((a, b) => priority[b] - priority[a]);
  for (const i of order) {
    if (kept.every((j) => partOf[j] === partOf[i] || containment(rects[i], rects[j]) < 0.7)) kept.push(i);
  }
  return kept.sort((a, b) => a - b);
}

function mergeParts(parts: Detections[]): Detections {
  const boxes = parts.flatMap((p) => p.boxes);
  const confs = parts.flatMap((p) => p.confs);
  const classes = parts.flatMap((p) => p.classes);
  const boxPart = parts.flatMap((p, i) => p.boxes.map(() => i));
  const keep = dedupeAcross(boxes, boxPart, confs);
  const lines = parts.flatMap((p) => p.lines);
  const linePart = parts.flatMap((p, i) => p.lines.map(() => i));
  const keptLines = dedupeAcross(lines.map(polyBBox), linePart, lines.map((l) => lineGeometry(l).length));
  return { boxes: keep.map((i) => boxes[i]), confs: keep.map((i) => confs[i]), classes: keep.map((i) => classes[i]),
    lines: keptLines.map((i) => lines[i]) };
}

// ----------------------------------------------------------------------
// Pre/post-procesado
// ----------------------------------------------------------------------

function letterbox(cv: Cv, img: Mat): { tensor: Float32Array; ratio: number; padW: number; padH: number } {
  const h = img.rows, w = img.cols;
  const r = Math.min(INPUT_SIZE / h, INPUT_SIZE / w);
  const nw = pyRound(w * r), nh = pyRound(h * r);
  return scoped((s) => {
    const rgb = s.add(new cv.Mat());
    cv.cvtColor(img, rgb, cv.COLOR_BGR2RGB);
    let src = rgb;
    if (nw !== w || nh !== h) {
      src = s.add(new cv.Mat());
      cv.resize(rgb, src, new cv.Size(nw, nh), 0, 0, r > 1 ? cv.INTER_LINEAR : cv.INTER_AREA);
    }
    const plane = INPUT_SIZE * INPUT_SIZE;
    const tensor = new Float32Array(3 * plane);
    const d = src.data;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const o = y * INPUT_SIZE + x, i = (y * nw + x) * 3;
        tensor[o] = d[i] / 255;
        tensor[plane + o] = d[i + 1] / 255;
        tensor[2 * plane + o] = d[i + 2] / 255;
      }
    }
    return { tensor, ratio: r, padW: INPUT_SIZE - nw, padH: INPUT_SIZE - nh };
  });
}

function splitOutputs(outputs: Record<string, ort.Tensor>) {
  let blk: ort.Tensor | undefined, seg: ort.Tensor | undefined, det: ort.Tensor | undefined;
  for (const t of Object.values(outputs)) {
    if (t.dims.length === 3) blk = t;
    else if (t.dims.length === 4 && t.dims[1] === 1) seg = t;
    else if (t.dims.length === 4 && t.dims[1] === 2) det = t;
  }
  if (!blk || !seg || !det) throw new Error('El modelo de detección no tiene las salidas esperadas.');
  return { blk, seg, det };
}

function nms(boxes: Box[], scores: number[], thresh: number): number[] {
  const areas = boxes.map((b) => (b[2] - b[0]) * (b[3] - b[1]));
  let order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep: number[] = [];
  while (order.length) {
    const i = order[0];
    keep.push(i);
    order = order.slice(1).filter((j) => {
      const iw = Math.max(0, Math.min(boxes[i][2], boxes[j][2]) - Math.max(boxes[i][0], boxes[j][0]));
      const ih = Math.max(0, Math.min(boxes[i][3], boxes[j][3]) - Math.max(boxes[i][1], boxes[j][1]));
      const inter = iw * ih;
      return inter / (areas[i] + areas[j] - inter + 1e-6) <= thresh;
    });
  }
  return keep;
}

function yoloPostprocess(pred: Float32Array, n: number, stride: number, ratio: number, w: number, h: number) {
  const cand: { box: Box; conf: number; cls: number }[] = [];
  const nCls = stride - 5;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    let cls = 0, best = pred[o + 5];
    for (let c = 1; c < nCls; c++) if (pred[o + 5 + c] > best) { best = pred[o + 5 + c]; cls = c; }
    const conf = pred[o + 4] * best;
    if (conf <= CONF_THRESH) continue;
    const cx = pred[o], cy = pred[o + 1], bw = pred[o + 2], bh = pred[o + 3];
    cand.push({ box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], conf, cls });
  }
  const keep = nms(cand.map((c) => c.box), cand.map((c) => c.conf), NMS_THRESH);
  const boxes: Box[] = [], confs: number[] = [], classes: number[] = [];
  for (const k of keep) {
    const b = cand[k].box.map((v) => v / ratio);
    const clip = (v: number, hi: number) => Math.trunc(Math.min(Math.max(v, 0), hi));
    boxes.push([clip(b[0], w), clip(b[1], h), clip(b[2], w), clip(b[3], h)]);
    confs.push(cand[k].conf);
    classes.push(cand[k].cls);
  }
  return { boxes, confs, classes };
}

function dbLines(cv: Cv, prob: Float32Array, ratio: number, w: number, h: number): Poly[] {
  return scoped((s) => {
    const bitmap = s.add(new cv.Mat(INPUT_SIZE, INPUT_SIZE, cv.CV_8UC1));
    const bd = bitmap.data;
    for (let i = 0; i < bd.length; i++) bd[i] = prob[i] > LINE_BIN_THRESH ? 1 : 0;
    const contours = s.add(new cv.MatVector());
    const hierarchy = s.add(new cv.Mat());
    cv.findContours(bitmap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const lines: Poly[] = [];
    const count = Math.min(contours.size(), 2000);
    for (let ci = 0; ci < count; ci++) {
      const contour = contours.get(ci);
      try {
        if (contour.rows < 4) continue;
        const rect = cv.boundingRect(contour);
        const score = contourMeanScore(cv, contour, rect, prob);
        if (score < LINE_SCORE_THRESH) continue;
        const rr = cv.minAreaRect(contour);
        const rw = rr.size.width, rh = rr.size.height;
        if (Math.min(rw, rh) < 2) continue;
        const area = rw * rh, perimeter = 2 * (rw + rh);
        const d = (area * UNCLIP_RATIO) / Math.max(perimeter, 1e-6);
        const grown = { center: rr.center, size: { width: rw + 2 * d, height: rh + 2 * d }, angle: rr.angle };
        if (Math.min(grown.size.width, grown.size.height) < 5) continue;
        const pts = (cv.RotatedRect as unknown as { points(r: unknown): { x: number; y: number }[] }).points(grown)
          .map((p) => [Math.min(Math.max(p.x / ratio, 0), w), Math.min(Math.max(p.y / ratio, 0), h)] as [number, number]);
        lines.push(orderPoints(pts).map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]));
      } finally {
        contour.delete();
      }
    }
    return lines;
  });
}

/** Media de `prob` dentro del contorno relleno (igual que `cv2.mean(prob_roi, mask)`). */
function contourMeanScore(cv: Cv, contour: Mat, rect: { x: number; y: number; width: number; height: number }, prob: Float32Array): number {
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
      for (let xx = 0; xx < cw; xx++) {
        if (rd[yy * cw + xx]) { sum += prob[(y + yy) * INPUT_SIZE + x + xx]; n++; }
      }
    }
    return n ? sum / n : 0;
  });
}

/** Ordena tl, tr, br, bl. */
export function orderPoints(pts: [number, number][]): [number, number][] {
  const sums = pts.map((p) => p[0] + p[1]);
  const diffs = pts.map((p) => p[1] - p[0]);
  const argmin = (a: number[]) => a.indexOf(Math.min(...a));
  const argmax = (a: number[]) => a.indexOf(Math.max(...a));
  return [pts[argmin(sums)], pts[argmin(diffs)], pts[argmax(sums)], pts[argmax(diffs)]];
}

function contains(box: Box, pt: [number, number], margin = 0): boolean {
  return box[0] - margin <= pt[0] && pt[0] <= box[2] + margin && box[1] - margin <= pt[1] && pt[1] <= box[3] + margin;
}

/** Une líneas contiguas de un mismo párrafo (misma orientación, cuerpo similar, hueco pequeño y solape suficiente). */
function clusterLines(lines: Poly[]): Poly[][] {
  const n = lines.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const info = lines.map((p) => ({ b: polyBBox(p), g: lineGeometry(p) }));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = info[i], b = info[j];
      const ti = a.g.thickness, tj = b.g.thickness;
      if (a.g.vertical !== b.g.vertical || Math.max(ti, tj) > Math.min(ti, tj) * 1.6) continue;
      const thick = (ti + tj) / 2;
      let gap: number, overlap: number, span: number;
      if (a.g.vertical) {
        gap = Math.max(a.b[0], b.b[0]) - Math.min(a.b[2], b.b[2]);
        overlap = Math.min(a.b[3], b.b[3]) - Math.max(a.b[1], b.b[1]);
        span = Math.min(a.b[3] - a.b[1], b.b[3] - b.b[1]);
      } else {
        gap = Math.max(a.b[1], b.b[1]) - Math.min(a.b[3], b.b[3]);
        overlap = Math.min(a.b[2], b.b[2]) - Math.max(a.b[0], b.b[0]);
        span = Math.min(a.b[2] - a.b[0], b.b[2] - b.b[0]);
      }
      if (gap < thick * 0.8 && overlap > span * 0.3) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Poly[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(lines[i]);
  }
  return [...groups.values()];
}

function group(d: Detections, w: number, h: number): DetectedBlock[] {
  const blocks: DetectedBlock[] = d.boxes.map((b, i) => ({
    bbox: [...b] as Box, lines: [], vertical: false, confidence: d.confs[i], lineSize: 0,
    langHint: d.classes[i] < 2 ? LANGS[d.classes[i]] : 'unknown',
  }));
  const orphans: Poly[] = [];
  for (const poly of d.lines) {
    const center = polyCenter(poly);
    let best: DetectedBlock | null = null;
    for (const b of blocks) {
      if (contains(b.bbox, center, 4) && (!best || blockArea(b) < blockArea(best))) best = b;
    }
    if (best) best.lines.push(poly); else orphans.push(poly);
  }
  for (const g of clusterLines(orphans)) {
    const all = g.flat() as [number, number][];
    blocks.push({ bbox: polyBBox(all), lines: g, vertical: false, confidence: 0, langHint: 'unknown', lineSize: 0 });
  }

  const result: DetectedBlock[] = [];
  for (const b of blocks) {
    if (b.lines.length) {
      const geoms = b.lines.map(lineGeometry);
      const elongated = geoms.filter((g) => g.length > g.thickness * 1.5);
      if (elongated.length) {
        b.vertical = elongated.filter((g) => g.vertical).length * 2 > elongated.length;
      } else {
        const bw = b.bbox[2] - b.bbox[0], bh = b.bbox[3] - b.bbox[1];
        b.vertical = bh > bw * 1.2 && b.langHint !== 'eng';
      }
      b.lineSize = median(geoms.map((g) => g.thickness));
      const [lx1, ly1, lx2, ly2] = polyBBox(b.lines.flat() as [number, number][]);
      if (b.confidence > 0) {
        const [x1, y1, x2, y2] = b.bbox;
        b.bbox = [Math.min(x1, lx1), Math.min(y1, ly1), Math.max(x2, lx2), Math.max(y2, ly2)];
      } else {
        b.bbox = [lx1, ly1, lx2, ly2];
      }
      if (b.confidence === 0 && b.lines.length === 1 && geoms[0].length < geoms[0].thickness * 1.6) continue;
    } else {
      if (b.confidence < 0.55) continue;
      const [x1, y1, x2, y2] = b.bbox;
      b.vertical = (y2 - y1) > (x2 - x1) * 1.4 && b.langHint !== 'eng';
      b.lineSize = Math.min(x2 - x1, y2 - y1) / 2;
    }
    const [x1, y1, x2, y2] = b.bbox;
    b.bbox = [Math.max(0, x1), Math.max(0, y1), Math.min(w, x2), Math.min(h, y2)];
    if (blockArea(b) >= 64) result.push(b);
  }
  return result;
}
