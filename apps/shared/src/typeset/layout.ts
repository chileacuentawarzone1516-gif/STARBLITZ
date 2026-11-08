/**
 * Maquetación de texto en globos (letrismo).
 *
 * - Ajuste automático del cuerpo de letra (búsqueda binaria) al área disponible.
 * - Ancho de cada línea según la forma real del globo (polígono), lo que produce
 *   la clásica composición en rombo/elipse de los globos de manga.
 * - Equilibrado de líneas: evita una última línea con una sola palabra.
 * - Partición silábica básica del español solo cuando una palabra no cabe.
 */
import type { Align, BBox } from '../types';

export type Measure = (text: string, fontSize: number) => number;

export interface LayoutInput {
  text: string;
  box: BBox;
  polygon?: [number, number][] | null;
  fontSize?: number | null; // null = automático
  minSize: number;
  maxSize: number;
  lineHeight: number;
  align: Align;
  uppercase?: boolean;
  padding?: number; // margen interior en proporción del cuerpo de letra
}

export interface LaidLine {
  text: string;
  x: number; // posición del ancla según la alineación
  y: number; // línea base
  width: number;
  available: number;
}

export interface LayoutResult {
  fontSize: number;
  lineHeight: number;
  lines: LaidLine[];
  fits: boolean;
  anchor: Align;
}

/** Intervalo horizontal disponible del polígono a la altura `y`. */
export function polygonSpan(polygon: [number, number][], y: number): [number, number] | null {
  const xs: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
      xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  // Intervalo más ancho (polígonos cóncavos pueden dar varios tramos).
  let best: [number, number] | null = null;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  }
  return best;
}

export function normalizeText(text: string, uppercase = false): string {
  const t = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return uppercase ? t.toLocaleUpperCase('es') : t;
}

/** Posibles cortes silábicos (aproximación para español: antes de consonante seguida de vocal). */
export function hyphenPoints(word: string): number[] {
  const v = /[aeiouáéíóúüAEIOUÁÉÍÓÚÜ]/;
  const points: number[] = [];
  for (let i = 2; i < word.length - 2; i++) {
    const prev = word[i - 1];
    const cur = word[i];
    const next = word[i + 1];
    if (v.test(prev) && !v.test(cur) && v.test(next)) points.push(i); // vo-cal
    else if (!v.test(prev) && !v.test(cur) && v.test(next) && !/^(bl|br|cl|cr|dr|fl|fr|gl|gr|pl|pr|tr|ch|ll|rr)$/i.test(prev + cur)) {
      points.push(i); // con-so-nan-te
    }
  }
  return points;
}

interface Slot {
  y: number; // línea base
  left: number;
  right: number;
}

function slots(input: LayoutInput, size: number, count: number): Slot[] {
  const [x1, y1, x2, y2] = input.box;
  const lh = size * input.lineHeight;
  const total = lh * count;
  const top = y1 + (y2 - y1 - total) / 2;
  const pad = size * (input.padding ?? 0.35);
  const out: Slot[] = [];
  for (let i = 0; i < count; i++) {
    const lineTop = top + i * lh;
    const mid = lineTop + lh / 2;
    let left = x1 + pad;
    let right = x2 - pad;
    if (input.polygon && input.polygon.length >= 3) {
      // Se usa el tramo más estrecho entre la parte alta y baja de la línea.
      const a = polygonSpan(input.polygon, lineTop + lh * 0.15);
      const b = polygonSpan(input.polygon, lineTop + lh * 0.85);
      const c = polygonSpan(input.polygon, mid);
      const spans = [a, b, c].filter(Boolean) as [number, number][];
      if (spans.length) {
        const l = Math.max(...spans.map((s) => s[0])) + pad;
        const r = Math.min(...spans.map((s) => s[1])) - pad;
        left = Math.max(left, l);
        right = Math.min(right, r);
      } else {
        right = left; // fuera del globo: sin espacio
      }
    }
    out.push({ y: lineTop + lh * 0.78, left, right });
  }
  return out;
}

function wrap(words: string[][], measure: Measure, size: number, widths: number[], squeeze = 1, hard = false,
  hyphenate = true): string[] | null {
  const lines: string[] = [];
  const space = measure(' ', size);
  let li = 0;
  for (const paragraph of words) {
    let current = '';
    let currentW = 0;
    for (let wi = 0; wi < paragraph.length; wi++) {
      let word = paragraph[wi];
      const maxW = (widths[Math.min(li, widths.length - 1)] ?? 0) * squeeze;
      const w = measure(word, size);
      const candidate = current ? currentW + space + w : w;
      if (candidate <= maxW) {
        current = current ? `${current} ${word}` : word;
        currentW = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        li++;
        current = '';
        currentW = 0;
      }
      const lineMax = (widths[Math.min(li, widths.length - 1)] ?? 0) * squeeze;
      if (w <= lineMax) {
        current = word;
        currentW = w;
        continue;
      }
      // La palabra no cabe en una línea: se parte por sílabas con guion (solo si se permite).
      if (!hyphenate && !hard) return null;
      let guard = 0;
      while (measure(word, size) > (widths[Math.min(li, widths.length - 1)] ?? 0) * squeeze && guard++ < 20) {
        const limit = (widths[Math.min(li, widths.length - 1)] ?? 0) * squeeze;
        const points = hyphenPoints(word).reverse();
        let cut = points.find((p) => measure(word.slice(0, p) + '-', size) <= limit);
        if (cut === undefined) {
          if (!hard) return null; // imposible a este tamaño: el ajuste automático probará uno menor
          cut = 2;
          while (cut + 1 < word.length && measure(word.slice(0, cut + 1) + '-', size) <= limit) cut++;
        }
        lines.push(word.slice(0, cut) + '-');
        li++;
        word = word.slice(cut);
      }
      current = word;
      currentW = measure(word, size);
    }
    if (current) {
      lines.push(current);
      li++;
    }
  }
  return lines;
}

function tryLayout(input: LayoutInput, measure: Measure, size: number, paragraphs: string[][], hyphenate = true):
  { lines: string[]; slots: Slot[] } | null {
  const [, y1, , y2] = input.box;
  const lh = size * input.lineHeight;
  const maxLines = Math.max(1, Math.floor((y2 - y1) / lh + 1e-6));
  let count = Math.min(maxLines, Math.max(1, paragraphs.length));
  for (let iter = 0; iter < 6; iter++) {
    const sl = slots(input, size, count);
    const widths = sl.map((s) => Math.max(0, s.right - s.left));
    const lines = wrap(paragraphs, measure, size, widths, 1, false, hyphenate);
    if (!lines) return null;
    if (lines.length === count) {
      // Equilibrado: se estrecha el ancho mientras no aumente el número de líneas.
      let best = lines;
      if (count > 1) {
        for (let squeeze = 0.95; squeeze >= 0.6; squeeze -= 0.05) {
          const alt = wrap(paragraphs, measure, size, widths, squeeze, false, hyphenate);
          if (!alt || alt.length !== count) break;
          best = alt;
        }
      }
      return { lines: best, slots: sl };
    }
    if (lines.length > maxLines) return null;
    count = lines.length;
  }
  return null;
}

export function layoutText(input: LayoutInput, measure: Measure): LayoutResult {
  const text = normalizeText(input.text, input.uppercase);
  const paragraphs = text.split('\n').map((p) => p.split(' ').filter(Boolean));
  const build = (size: number, res: { lines: string[]; slots: Slot[] } | null, fits: boolean): LayoutResult => {
    const lines: LaidLine[] = [];
    if (res) {
      res.lines.forEach((t, i) => {
        const s = res.slots[Math.min(i, res.slots.length - 1)];
        const width = measure(t, size);
        const x = input.align === 'left' ? s.left : input.align === 'right' ? s.right : (s.left + s.right) / 2;
        lines.push({ text: t, x, y: s.y, width, available: s.right - s.left });
      });
    }
    return { fontSize: size, lineHeight: size * input.lineHeight, lines, fits, anchor: input.align };
  };
  if (!text) return build(input.minSize, null, true);

  if (input.fontSize) {
    const res = tryLayout(input, measure, input.fontSize, paragraphs);
    return res ? build(input.fontSize, res, true) : build(input.fontSize, forceLayout(input, measure, input.fontSize, paragraphs), false);
  }
  const search = (hyphenate: boolean) => {
    let lo = input.minSize;
    let hi = Math.max(input.minSize, input.maxSize);
    let best: { size: number; res: { lines: string[]; slots: Slot[] } } | null = null;
    for (let i = 0; i < 14 && hi - lo > 0.25; i++) {
      const mid = (lo + hi) / 2;
      const res = tryLayout(input, measure, mid, paragraphs, hyphenate);
      if (res) {
        best = { size: mid, res };
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  };
  // Un rotulista profesional evita partir palabras: solo se acepta el guion si permite
  // un cuerpo de letra claramente mayor (más legible) que sin partir.
  const whole = search(false);
  const split = !whole || whole.size < input.maxSize * 0.98 ? search(true) : null;
  const best = whole && (!split || whole.size >= split.size * 0.82) ? whole : split ?? whole;
  const useHyphens = best !== whole;
  if (!best) {
    const res = tryLayout(input, measure, input.minSize, paragraphs);
    if (res) return build(input.minSize, res, true);
    // No cabe ni al tamaño mínimo: se compone igualmente y se avisa (el editor lo marca).
    return build(input.minSize, forceLayout(input, measure, input.minSize, paragraphs), false);
  }
  const size = Math.floor(best.size * 2) / 2;
  return build(size, tryLayout(input, measure, size, paragraphs, useHyphens) ?? best.res, true);
}

/** Composición de emergencia: ignora el alto disponible para no perder texto. */
function forceLayout(input: LayoutInput, measure: Measure, size: number, paragraphs: string[][]) {
  const [x1, , x2] = input.box;
  const width = Math.max(size * 3, x2 - x1 - size * 0.7);
  const lines = wrap(paragraphs, measure, size, [width], 1, true) ?? paragraphs.map((p) => p.join(' '));
  const sl = slots({ ...input, polygon: null }, size, lines.length);
  return { lines, slots: sl };
}

