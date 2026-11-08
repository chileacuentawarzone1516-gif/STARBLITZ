/**
 * Viñetas y orden de lectura. Port de `vision/layout.py`.
 * Las viñetas se obtienen del «canal» (gutter): el espacio claro conectado con los márgenes de la página.
 * El orden de lectura usa cortes XY recursivos, de derecha a izquierda en manga y al revés en cómic occidental.
 */
import { scoped, type Cv, type Mat } from '../runtime/cv';
import type { Box } from './types';

export type Direction = 'rtl' | 'ltr';

export function detectPanels(cv: Cv, img: Mat, minAreaRatio = 0.015): Box[] {
  const h = img.rows, w = img.cols;
  const scale = Math.max(h, w) > 1000 ? 1000 / Math.max(h, w) : 1.0;
  return scoped((s) => {
    let small = img;
    if (scale < 1) {
      small = s.add(new cv.Mat());
      cv.resize(img, small, new cv.Size(Math.trunc(w * scale), Math.trunc(h * scale)), 0, 0, cv.INTER_AREA);
    }
    const gray = s.add(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_BGR2GRAY);
    const sh = gray.rows, sw = gray.cols;
    const blur = s.add(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    const light = s.add(new cv.Mat(sh, sw, cv.CV_8UC1));
    const bd = blur.data, ld = light.data;
    for (let i = 0; i < ld.length; i++) ld[i] = bd[i] > 215 ? 1 : 0;

    // El canal es el espacio claro conectado (4 vecinos) con algún punto de los bordes, muestreados cada 4 px.
    const labels = s.add(new cv.Mat());
    const nLight = cv.connectedComponents(light, labels, 4, cv.CV_32S);
    const lab = labels.data32S;
    const touching = new Uint8Array(nLight);
    const seed = (x: number, y: number) => { const l = lab[y * sw + x]; if (l > 0) touching[l] = 1; };
    for (let x = 0; x < sw; x += 4) { seed(x, 0); seed(x, sh - 1); }
    for (let y = 0; y < sh; y += 4) { seed(0, y); seed(sw - 1, y); }

    const content = s.add(new cv.Mat(sh, sw, cv.CV_8UC1));
    const cd = content.data;
    for (let i = 0; i < cd.length; i++) cd[i] = lab[i] > 0 && touching[lab[i]] ? 0 : 1;
    const cLabels = s.add(new cv.Mat()), stats = s.add(new cv.Mat()), centroids = s.add(new cv.Mat());
    const n = cv.connectedComponentsWithStats(content, cLabels, stats, centroids, 8, cv.CV_32S);
    const st = stats.data32S;
    const panels: Box[] = [];
    for (let i = 1; i < n; i++) {
      const x = st[i * 5], y = st[i * 5 + 1], cw = st[i * 5 + 2], ch = st[i * 5 + 3], area = st[i * 5 + 4];
      if (area < minAreaRatio * sh * sw || cw < sw * 0.08 || ch < sh * 0.05) continue;
      panels.push([Math.trunc(x / scale), Math.trunc(y / scale), Math.trunc((x + cw) / scale), Math.trunc((y + ch) / scale)]);
    }
    if (panels.length === 1) {
      const [x1, y1, x2, y2] = panels[0];
      if ((x2 - x1) * (y2 - y1) > 0.85 * h * w) return [];
    }
    return panels;
  });
}

function split(items: number[], boxes: Box[], axis: 0 | 1): number[][] {
  const [lo, hi] = axis === 0 ? [0, 2] : [1, 3];
  const spans = [...items].sort((a, b) => boxes[a][lo] - boxes[b][lo]);
  const groups: number[][] = [];
  let gStart = 0, gEnd = 0;
  for (const i of spans) {
    const start = boxes[i][lo], end = boxes[i][hi];
    if (groups.length) {
      const overlap = gEnd - start;
      // Se toleran solapes pequeños (globos o arte que invaden el canal entre viñetas).
      if (overlap > 0.25 * Math.min(end - start, gEnd - gStart)) {
        groups[groups.length - 1].push(i);
        gEnd = Math.max(gEnd, end);
        continue;
      }
    }
    groups.push([i]);
    gStart = start;
    gEnd = end;
  }
  return groups;
}

/** Índices de `boxes` en orden de lectura mediante cortes XY recursivos. */
export function xyCutOrder(boxes: Box[], direction: Direction): number[] {
  const recurse = (items: number[]): number[] => {
    if (items.length <= 1) return items;
    const rows = split(items, boxes, 1);
    if (rows.length > 1) return rows.flatMap(recurse);
    let cols = split(items, boxes, 0);
    if (cols.length > 1) {
      if (direction === 'rtl') cols = [...cols].reverse();
      return cols.flatMap(recurse);
    }
    const sign = direction === 'rtl' ? -1 : 1;
    return [...items].sort((a, b) => {
      const ka = boxes[a][1] + boxes[a][3], kb = boxes[b][1] + boxes[b][3];
      return ka !== kb ? ka - kb : sign * (boxes[a][0] + boxes[a][2]) - sign * (boxes[b][0] + boxes[b][2]);
    });
  };
  return recurse(boxes.map((_, i) => i));
}

/** Ordena bloques: primero por viñeta y después dentro de cada viñeta. */
export function readingOrder(blocks: Box[], panels: Box[], direction: Direction): number[] {
  if (!panels.length) return xyCutOrder(blocks, direction);
  const regions: Box[] = [...panels];
  const containing = (b: Box): number => {
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    let best = -1, bestArea = Infinity;
    regions.forEach((p, ri) => {
      if (p[0] <= cx && cx <= p[2] && p[1] <= cy && cy <= p[3]) {
        const area = (p[2] - p[0]) * (p[3] - p[1]);
        if (area < bestArea) { best = ri; bestArea = area; }
      }
    });
    return best;
  };
  const groups = new Map<number, number[]>();
  // Bloques fuera de toda viñeta forman pseudo-viñetas; los más grandes primero para que contengan a los pequeños.
  const bySize = blocks.map((_, i) => i).sort((a, b) =>
    (blocks[b][2] - blocks[b][0]) * (blocks[b][3] - blocks[b][1]) - (blocks[a][2] - blocks[a][0]) * (blocks[a][3] - blocks[a][1]));
  for (const bi of bySize) {
    let ri = containing(blocks[bi]);
    if (ri < 0) { regions.push(blocks[bi]); ri = regions.length - 1; }
    if (!groups.has(ri)) groups.set(ri, []);
    groups.get(ri)!.push(bi);
  }
  const rank = new Map(xyCutOrder(regions, direction).map((p, r) => [p, r]));
  const ordered: number[] = [];
  for (const pi of [...groups.keys()].sort((a, b) => rank.get(a)! - rank.get(b)!)) {
    const members = groups.get(pi)!;
    const sub = xyCutOrder(members.map((i) => blocks[i]), direction);
    ordered.push(...sub.map((k) => members[k]));
  }
  return ordered;
}
