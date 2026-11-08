/** Miniaturas de página para la cuadrícula y la vista previa del procesamiento (WebP reducido, también dentro de un Worker). */
import type { ThumbMaker } from '../store/projects';

export const THUMB_WIDTH = 360;

export const browserThumbs: ThumbMaker = async (original) => {
  const bitmap = await createImageBitmap(original);
  try {
    const w = Math.min(THUMB_WIDTH, bitmap.width);
    const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear la miniatura.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  } finally {
    bitmap.close();
  }
};
