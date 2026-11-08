/**
 * Página reducida con cada texto numerado en un círculo, para el modelo con visión (equivalente a
 * `annotate_for_llm`). Se dibuja con el lienzo del navegador: no necesita OpenCV y funciona en un Worker.
 *
 * Una página normal se limita por su lado largo; una tira de webtoon se limita por superficie (≈1,2 MP, máximo
 * 4096 px de largo) para que no quede en una franja ilegible de pocos píxeles de ancho.
 */
import type { Box } from './types';

const MARK = '#e6143c'; // rojo vivo: se distingue sobre cualquier fondo de manga

export function annotationScale(w: number, h: number, maxSide = 1280): number {
  if (Math.max(h, w) <= Math.min(h, w) * 1.6) return Math.min(1, maxSide / Math.max(h, w));
  return Math.min(1, Math.sqrt((maxSide * maxSide * 0.75) / (h * w)), 4096 / Math.max(h, w));
}

export async function annotateForLlm(original: Blob, boxes: Box[], maxSide = 1280): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
  try {
    const scale = annotationScale(bitmap.width, bitmap.height, maxSide);
    const w = Math.max(1, Math.trunc(bitmap.width * scale)), h = Math.max(1, Math.trunc(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar el lienzo para anotar la página.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const r = Math.max(11, Math.trunc(Math.min(w, h) * 0.02));
    ctx.lineWidth = 2;
    ctx.strokeStyle = MARK;
    ctx.fillStyle = MARK;
    ctx.font = `bold ${Math.round(r * 1.15)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    boxes.forEach(([x1, y1, x2, y2], i) => {
      ctx.strokeRect(x1 * scale, y1 * scale, (x2 - x1) * scale, (y2 - y1) * scale);
      const cx = Math.max(r, Math.min(w - r, Math.trunc(x1 * scale))), cy = Math.max(r, Math.min(h - r, Math.trunc(y1 * scale)));
      ctx.fillStyle = MARK;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(i + 1), cx, cy + 1);
    });
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
