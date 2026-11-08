/**
 * Localización del globo que contiene cada bloque de texto. Port de `vision/bubbles.py`.
 *
 * Método clásico y determinista: se elimina el texto, se segmenta la zona del color de fondo que rodea
 * al texto y se toma la componente conexa que lo contiene. Si queda acotada (no se «derrama» por la
 * viñeta) es un globo: su interior define el área donde maquetar la traducción y su color de fondo
 * permite borrar el texto sin tocar el dibujo.
 */
import { channelMedians, cropClone, scoped, type Cv, type Mat } from '../runtime/cv';
import type { Box, DetectedBlock } from './types';

export interface BubbleInfo {
  polygon: [number, number][];
  bbox: Box;
  /** Color de fondo (RGB). */
  fill: [number, number, number];
  /** Fondo liso: se puede rellenar sin reconstrucción. */
  uniform: boolean;
}

/** Color medio (BGR, mediana por canal) y dispersión del anillo de píxeles alrededor del texto. */
export function textRingStats(cv: Cv, img: Mat, textMask: Mat, bbox: Box): { median: number[]; spread: number } {
  const [x1, y1, x2, y2] = bbox;
  const pad = Math.max(4, Math.trunc(0.15 * Math.min(x2 - x1, y2 - y1)));
  const h = textMask.rows, w = textMask.cols;
  const sx1 = Math.max(0, x1 - pad), sy1 = Math.max(0, y1 - pad), sx2 = Math.min(w, x2 + pad), sy2 = Math.min(h, y2 + pad);
  return scoped((s) => {
    const rect = new cv.Rect(sx1, sy1, sx2 - sx1, sy2 - sy1);
    const sub = s.add(textMask.roi(rect));
    const dil = s.add(new cv.Mat());
    cv.dilate(sub, dil, s.add(cv.Mat.ones(5, 5, cv.CV_8UC1)), new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const region = cropClone(s, img, rect);
    const rw = rect.width, rh = rect.height;
    const dd = dil.data;
    const ring: number[] = [];
    for (let i = 0; i < rw * rh; i++) if (dd[i] === 0) ring.push(i);
    const useAll = ring.length < 20;
    const idx = useAll ? undefined : ring;
    const data = region.data;
    const med = channelMedians(data, 3, idx);
    const count = useAll ? rw * rh : ring.length;
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const base = (idx ? idx[k] : k) * 3;
      sum += Math.abs(data[base] - med[0]) + Math.abs(data[base + 1] - med[1]) + Math.abs(data[base + 2] - med[2]);
    }
    return { median: med, spread: count ? sum / (count * 3) : 0 };
  });
}

export function findBubble(cv: Cv, img: Mat, textMask: Mat, block: DetectedBlock): BubbleInfo | null {
  const h = img.rows, w = img.cols;
  const [x1, y1, x2, y2] = block.bbox;
  const bw = x2 - x1, bh = y2 - y1;
  if (bw < 4 || bh < 4) return null;
  const { median: bg, spread } = textRingStats(cv, img, textMask, block.bbox);
  const uniform = spread < 12.0;

  // Ventana de búsqueda acotada: un globo rara vez supera ~3x el bloque de texto.
  const mx = Math.trunc(bw * 1.6) + 20, my = Math.trunc(bh * 1.6) + 20;
  const wx1 = Math.max(0, x1 - mx), wy1 = Math.max(0, y1 - my), wx2 = Math.min(w, x2 + mx), wy2 = Math.min(h, y2 + my);
  const ww = wx2 - wx1, wh = wy2 - wy1;
  const tol = uniform ? 38 : 26;

  return scoped((s) => {
    const rect = new cv.Rect(wx1, wy1, ww, wh);
    const win = cropClone(s, img, rect).data;
    const similar = s.add(new cv.Mat(wh, ww, cv.CV_8UC1));
    const sd = similar.data;
    const b0 = bg[0], b1 = bg[1], b2 = bg[2];
    for (let i = 0; i < ww * wh; i++) {
      const d = Math.max(Math.abs(win[3 * i] - b0), Math.abs(win[3 * i + 1] - b1), Math.abs(win[3 * i + 2] - b2));
      sd[i] = d <= tol ? 1 : 0;
    }
    // El propio texto (y un margen) cuenta como fondo para que no parta el globo.
    const tm = s.add(new cv.Mat());
    cv.dilate(s.add(textMask.roi(rect)), tm, s.add(cv.Mat.ones(3, 3, cv.CV_8UC1)), new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const tmd = tm.data;
    for (let y = y1 - wy1; y < y2 - wy1; y++) {
      for (let x = x1 - wx1; x < x2 - wx1; x++) if (tmd[y * ww + x] > 0) sd[y * ww + x] = 1;
    }
    const opened = s.add(new cv.Mat());
    cv.morphologyEx(similar, opened, cv.MORPH_OPEN, s.add(cv.Mat.ones(3, 3, cv.CV_8UC1)), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    const labels = s.add(new cv.Mat()), stats = s.add(new cv.Mat()), centroids = s.add(new cv.Mat());
    const n = cv.connectedComponentsWithStats(opened, labels, stats, centroids, 4, cv.CV_32S);
    if (n <= 1) return null;
    const lab = labels.data32S;
    const counts = new Int32Array(n);
    for (let y = y1 - wy1; y < y2 - wy1; y++) {
      for (let x = x1 - wx1; x < x2 - wx1; x++) counts[lab[y * ww + x]]++;
    }
    counts[0] = 0;
    let label = 0;
    for (let i = 1; i < n; i++) if (counts[i] > counts[label]) label = i;
    if (counts[label] < 0.35 * (bw * bh)) return null;
    const st = stats.data32S;
    const cx = st[label * 5], cy = st[label * 5 + 1], cw = st[label * 5 + 2], ch = st[label * 5 + 3], area = st[label * 5 + 4];
    // Si la componente llega al borde de la ventana (salvo el borde de la página) se ha «derramado» por la viñeta.
    const hits: [boolean, boolean][] = [[cx <= 0, wx1 === 0], [cy <= 0, wy1 === 0], [cx + cw >= ww, wx2 === w], [cy + ch >= wh, wy2 === h]];
    for (const [edgeHit, pageEdge] of hits) if (edgeHit && !pageEdge) return null;
    if (area > 6 * bw * bh) return null;

    const comp = s.add(new cv.Mat(wh, ww, cv.CV_8UC1));
    const cd = comp.data;
    for (let i = 0; i < cd.length; i++) cd[i] = lab[i] === label ? 255 : 0;
    const closed = s.add(new cv.Mat());
    cv.morphologyEx(comp, closed, cv.MORPH_CLOSE, s.add(cv.Mat.ones(5, 5, cv.CV_8UC1)), new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    const contours = s.add(new cv.MatVector()), hier = s.add(new cv.Mat());
    cv.findContours(closed, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) return null;
    let best: Mat | null = null, bestArea = -1;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) { best?.delete(); best = c; bestArea = a; } else c.delete();
    }
    const contour = s.add(best!);
    // Los globos son casi convexos; una forma irregular indica que se coló en el dibujo.
    const hull = s.add(new cv.Mat());
    cv.convexHull(contour, hull);
    const hullArea = cv.contourArea(hull);
    if (hullArea <= 0 || bestArea / hullArea < 0.82) return null;
    const eps = 0.006 * cv.arcLength(contour, true);
    const approx = s.add(new cv.Mat());
    cv.approxPolyDP(contour, approx, eps, true);
    if (approx.rows < 3) return null;
    const a32 = approx.data32S;
    const polygon: [number, number][] = [];
    for (let i = 0; i < approx.rows; i++) polygon.push([a32[2 * i] + wx1, a32[2 * i + 1] + wy1]);
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    return {
      polygon,
      bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Box,
      fill: [Math.trunc(bg[2]), Math.trunc(bg[1]), Math.trunc(bg[0])] as [number, number, number],
      uniform,
    };
  });
}
