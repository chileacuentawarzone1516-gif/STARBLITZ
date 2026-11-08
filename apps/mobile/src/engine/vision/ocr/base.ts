import { scoped, type Cv, type Mat } from '../../runtime/cv';
import type { Box, DetectedBlock, Poly } from '../types';

export interface OcrResult { text: string; confidence: number; engine: string }

export interface OcrEngine {
  readonly id: string;
  recognize(img: Mat, block: DetectedBlock): Promise<OcrResult>;
  dispose(): Promise<void>;
}

/** Endereza el cuadrilátero de una línea de texto a un rectángulo (copia nueva; el llamante la libera). */
export function warpLine(cv: Cv, img: Mat, poly: Poly): Mat {
  const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(2, Math.trunc(Math.max(d(poly[0], poly[1]), d(poly[2], poly[3]))));
  const h = Math.max(2, Math.trunc(Math.max(d(poly[0], poly[3]), d(poly[1], poly[2]))));
  return scoped((s) => {
    const src = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, poly.flat()));
    const dst = s.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]));
    const m = s.add(cv.getPerspectiveTransform(src, dst));
    const out = new cv.Mat();
    cv.warpPerspective(img, out, m, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    return out;
  });
}

/** Orden de lectura de las líneas de un bloque: columnas de derecha a izquierda si es vertical; si no, de arriba abajo. */
export function orderedLines(block: DetectedBlock, rtlColumns = true): Poly[] {
  const mean = (p: Poly, axis: 0 | 1) => p.reduce((a, q) => a + q[axis], 0) / p.length;
  const key = block.vertical ? (p: Poly) => (rtlColumns ? -mean(p, 0) : mean(p, 0)) : (p: Poly) => mean(p, 1);
  return [...block.lines].sort((a, b) => key(a) - key(b));
}

/** Recorte (copia) de una región con margen, limitada a la imagen. */
export function cropBBox(cv: Cv, img: Mat, bbox: Box, pad = 0): Mat {
  const x1 = Math.max(0, bbox[0] - pad), y1 = Math.max(0, bbox[1] - pad);
  const x2 = Math.min(img.cols, bbox[2] + pad), y2 = Math.min(img.rows, bbox[3] + pad);
  const out = new cv.Mat();
  if (x2 <= x1 || y2 <= y1) return out;
  const roi = img.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
  roi.copyTo(out);
  roi.delete();
  return out;
}

/** Gira 90° en sentido antihorario (como `np.rot90`). */
export function rot90(cv: Cv, src: Mat): Mat {
  const out = new cv.Mat();
  cv.rotate(src, out, cv.ROTATE_90_COUNTERCLOCKWISE);
  return out;
}
