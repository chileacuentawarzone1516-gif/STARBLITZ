/** Decodificación y validación de imágenes con el navegador (`createImageBitmap` + `OffscreenCanvas`), también en un Worker. */
import { dhashFromGray, jpegOrientation, MAX_IMAGE_PIXELS, peekDimensions } from './formats';
import { ImportProblem, type ImageCodec, type LoadedImage } from './ingest';

const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const HASH_W = 9, HASH_H = 8, OVERSAMPLE = 8;

export class BrowserImageCodec implements ImageCodec {
  async load(_name: string, data: Uint8Array, kind: string): Promise<LoadedImage> {
    const dims = peekDimensions(data, kind);
    if (!dims || dims.width < 1 || dims.height < 1) throw new ImportProblem('la imagen está dañada o incompleta');
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw new ImportProblem('la imagen es demasiado grande');
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(new Blob([data.slice()], { type: MIME[kind] }), { imageOrientation: 'from-image' });
    } catch {
      throw new ImportProblem('la imagen está dañada o incompleta');
    }
    try {
      let out = data, ext = kind;
      if (kind === 'jpg' && jpegOrientation(data) > 1) {
        // Los visores y el PDF final ignoran la etiqueta EXIF: se guarda ya girada, igual que en el PC.
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new ImportProblem('no se pudo preparar la imagen');
        ctx.drawImage(bitmap, 0, 0);
        out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        ext = 'png';
      }
      return { data: out, ext, width: bitmap.width, height: bitmap.height, dhash: dhashOf(bitmap) };
    } finally {
      bitmap.close();
    }
  }
}

/** Reduce la imagen a grises 9×8 (promediando bloques) y calcula su huella. */
function dhashOf(bitmap: ImageBitmap): string {
  const w = HASH_W * OVERSAMPLE, h = HASH_H * OVERSAMPLE;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImportProblem('no se pudo preparar la imagen');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float64Array(HASH_W * HASH_H);
  for (let gy = 0; gy < HASH_H; gy++) {
    for (let gx = 0; gx < HASH_W; gx++) {
      let sum = 0;
      for (let y = 0; y < OVERSAMPLE; y++) {
        for (let x = 0; x < OVERSAMPLE; x++) {
          const o = ((gy * OVERSAMPLE + y) * w + gx * OVERSAMPLE + x) * 4;
          sum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
        }
      }
      gray[gy * HASH_W + gx] = sum / (OVERSAMPLE * OVERSAMPLE);
    }
  }
  return dhashFromGray(gray);
}
