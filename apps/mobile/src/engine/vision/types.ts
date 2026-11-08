export type Box = [number, number, number, number];
/** Cuadrilátero de una línea de texto: tl, tr, br, bl. */
export type Poly = [number, number][];

export interface DetectedBlock {
  bbox: Box;
  lines: Poly[];
  vertical: boolean;
  confidence: number;
  langHint: 'ja' | 'eng' | 'unknown';
  /** Tamaño estimado del cuerpo de letra (px). */
  lineSize: number;
}

export const blockArea = (b: { bbox: Box }): number =>
  Math.max(0, b.bbox[2] - b.bbox[0]) * Math.max(0, b.bbox[3] - b.bbox[1]);

export const polyBBox = (poly: Poly): Box => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of poly) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
  return [Math.trunc(x1), Math.trunc(y1), Math.trunc(x2), Math.trunc(y2)];
};

export const polyCenter = (poly: Poly): [number, number] => {
  let sx = 0, sy = 0;
  for (const [x, y] of poly) { sx += x; sy += y; }
  return [sx / poly.length, sy / poly.length];
};

/** Largo, grosor y orientación de una línea de texto (cuadrilátero tl, tr, br, bl). */
export function lineGeometry(poly: Poly): { length: number; thickness: number; vertical: boolean } {
  const [tl, tr, br, bl] = poly;
  const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const width = (d(tr, tl) + d(br, bl)) / 2;
  const height = (d(bl, tl) + d(br, tr)) / 2;
  return { length: Math.max(width, height), thickness: Math.min(width, height), vertical: height > width * 1.15 };
}
