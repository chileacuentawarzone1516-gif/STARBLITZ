/**
 * ¿Cabe una traducción en su globo al cuerpo mínimo legible? Con las métricas REALES de las tipografías (port de
 * `translate/fit.py`; mismos resultados, casos de paridad). Núcleo del maquetador de las apps (`typeset/layout.ts`) evaluado solo al
 * cuerpo mínimo de `sizeBounds`, con las mismas alternativas (tipografía propia y condensada, margen normal y estrecho) y sin
 * partir palabras: nunca dice «cabe» de algo que no cabría. El rotulado final sigue siendo el del lienzo.
 */
import type { Region } from '@starblitz/shared';
import raw from './glyph_metrics.json';

type Adv = Record<string, number>;
const METRICS = (raw as unknown as { roles: Record<string, Adv> }).roles;

export const CONDENSED_ROLE = 'narration';
/** Tope fijo del cuerpo mínimo (igual que `MIN_FONT_CAP` en render.ts y fit.py). */
export const MIN_FONT_CAP = 0.0072;
export const BUBBLE_PADDING = 0.28;
export const TIGHT_BUBBLE_PADDING = 0.14;
export const FREE_PADDING = 0.15;

export function minFontSize(lineSize: number, pageHeight: number): number {
  const fixed = Math.max(8.0, pageHeight * MIN_FONT_CAP);
  const relative = lineSize > 0 ? lineSize * 0.75 : fixed;
  return Math.max(8.0, pageHeight * 0.005, Math.min(fixed, relative));
}

export function textWidth(text: string, size: number, role: string): number {
  const adv = METRICS[role] ?? METRICS.dialogue;
  let sum = 0;
  for (const c of text) sum += adv[c] ?? adv._default;
  return sum * size;
}

function span(polygon: [number, number][], y: number): [number, number] | null {
  const xs: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  let best: [number, number] | null = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  return best;
}

type Box = [number, number, number, number];
type Poly = [number, number][] | null | undefined;

function widths(box: Box, polygon: Poly, size: number, lineHeight: number, count: number, padEm: number, padBox: boolean): number[] {
  const [x1, y1, x2, y2] = box;
  const lh = size * lineHeight;
  const top = y1 + (y2 - y1 - lh * count) / 2;
  const pad = size * padEm;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const lineTop = top + i * lh;
    let left = x1 + (padBox ? pad : 0), right = x2 - (padBox ? pad : 0);
    if (polygon && polygon.length >= 3) {
      const spans = [span(polygon, lineTop + lh * 0.15), span(polygon, lineTop + lh * 0.85), span(polygon, lineTop + lh / 2)]
        .filter((s): s is [number, number] => !!s);
      if (spans.length) {
        left = Math.max(left, Math.max(...spans.map((s) => s[0])) + pad);
        right = Math.min(right, Math.min(...spans.map((s) => s[1])) - pad);
      } else right = left;
    }
    out.push(Math.max(0, right - left));
  }
  return out;
}

function wrap(paragraphs: string[][], size: number, role: string, ws: number[]): string[] | null {
  const space = textWidth(' ', size, role);
  const lines: string[] = [];
  let li = 0;
  for (const words of paragraphs) {
    let cur = '', curW = 0;
    for (const word of words) {
      const w = textWidth(word, size, role);
      const limit = ws[Math.min(li, ws.length - 1)];
      const cand = cur ? curW + space + w : w;
      if (cand <= limit) { cur = cur ? `${cur} ${word}` : word; curW = cand; continue; }
      if (cur) { lines.push(cur); li++; }
      if (w > ws[Math.min(li, ws.length - 1)]) return null; // la palabra no cabe entera en la línea (sin partirla)
      cur = word; curW = w;
    }
    if (cur) { lines.push(cur); li++; }
  }
  return lines;
}

function fitsAt(text: string, box: Box, polygon: Poly, size: number, lineHeight: number, role: string, padEm: number, padBox: boolean): boolean {
  const paragraphs = text.split('\n').map((p) => p.split(' ').filter(Boolean));
  const [, y1, , y2] = box;
  const lh = size * lineHeight;
  const maxLines = Math.max(1, Math.floor((y2 - y1) / lh + 1e-6));
  let count = Math.min(maxLines, Math.max(1, paragraphs.length));
  for (let iter = 0; iter < 6; iter++) {
    const lines = wrap(paragraphs, size, role, widths(box, polygon, size, lineHeight, count, padEm, padBox));
    if (!lines) return false;
    if (lines.length === count) return true;
    if (lines.length > maxLines) return false;
    count = lines.length;
  }
  return false;
}

/** Igual que `normalize` en Python (y que `normalizeText`, pero con mayúsculas sin reglas de idioma, como `str.upper`). */
export function normalize(text: string, uppercase = false): string {
  const t = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return uppercase ? t.toUpperCase() : t;
}

export interface FitInput {
  layoutBox: Box; polygon: Poly; lineSize: number; pageHeight: number; role?: string; lineHeight?: number; uppercase?: boolean;
}

export function fits(text: string, i: FitInput): boolean {
  const t = normalize(text, i.uppercase);
  if (!t) return true;
  const size = minFontSize(i.lineSize, i.pageHeight);
  const role = i.role ?? 'dialogue';
  const roles = role === CONDENSED_ROLE ? [role] : [role, CONDENSED_ROLE];
  const pads: [number, boolean][] = i.polygon ? [[BUBBLE_PADDING, false], [TIGHT_BUBBLE_PADDING, false]] : [[FREE_PADDING, true]];
  return pads.some(([p, pb]) => roles.some((r) => fitsAt(t, i.layoutBox, i.polygon, size, i.lineHeight ?? 1.12, r, p, pb)));
}

/** Caracteres del comienzo más largo de `text` (cortado entre palabras) que cabe: el objetivo de la reformulación. */
export function fitChars(region: Region, text: string, pageHeight: number): number {
  const words = normalize(text).split(' ');
  let best = 0;
  for (let k = 1; k <= words.length; k++) {
    const prefix = words.slice(0, k).join(' ');
    if (!regionFits(region, prefix, pageHeight)) break;
    best = [...prefix].length;
  }
  return best;
}

export function regionFits(region: Region, text: string, pageHeight: number): boolean {
  const s = region.style;
  return fits(text, {
    layoutBox: region.layout_box as Box, polygon: region.bubble ? region.bubble.polygon : null, lineSize: region.line_size,
    pageHeight, role: s.font, lineHeight: s.line_height, uppercase: s.uppercase,
  });
}
