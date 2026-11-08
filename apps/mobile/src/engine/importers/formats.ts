/**
 * Reconocimiento de formatos por su firma (nunca por la extensión) y lectura de dimensiones sin decodificar la
 * imagen: así una «bomba de descompresión» se rechaza antes de gastar memoria.
 */
export type Kind = 'zip' | 'pdf' | 'jpg' | 'png' | 'webp';
export const IMAGE_KINDS: readonly string[] = ['jpg', 'png', 'webp'];
export const MAX_IMAGE_PIXELS = 60_000_000; // ≈ 7700 × 7700

const eq = (b: Uint8Array, at: number, sig: number[]) => sig.every((v, i) => b[at + i] === v);

export function sniff(head: Uint8Array): Kind | null {
  if (eq(head, 0, [0x50, 0x4b, 3, 4]) || eq(head, 0, [0x50, 0x4b, 5, 6])) return 'zip';
  if (eq(head, 0, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (eq(head, 0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (eq(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (head.length >= 12 && eq(head, 0, [0x52, 0x49, 0x46, 0x46]) && eq(head, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** Ancho y alto declarados por la cabecera; `null` si no se pueden leer (archivo dañado). */
export function peekDimensions(b: Uint8Array, kind: string): { width: number; height: number } | null {
  if (kind === 'png') {
    return b.length >= 24 && be32(b, 8) === 13 ? { width: be32(b, 16), height: be32(b, 20) } : null;
  }
  if (kind === 'webp') {
    if (b.length < 30) return null;
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
    if (tag === 'VP8L') {
      const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    }
    if (tag === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
    return null;
  }
  if (kind === 'jpg') {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1];
      if (marker === 0xff) { p++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const len = be16(b, p + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { width: be16(b, p + 7), height: be16(b, p + 5) };
      p += 2 + len;
    }
    return null;
  }
  return null;
}

/** Orientación EXIF (1–8) de un JPEG; 1 si no hay etiqueta. */
export function jpegOrientation(b: Uint8Array): number {
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = be16(b, p + 2);
    if (marker === 0xe1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) { // «Exif»
      const t = p + 10; // inicio de la cabecera TIFF
      const little = b[t] === 0x49;
      const r16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const r32 = (o: number) => (little ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : be32(b, o));
      let ifd = t + r32(t + 4);
      const count = ifd + 2 <= b.length ? r16(ifd) : 0;
      ifd += 2;
      for (let i = 0; i < count && ifd + 12 <= b.length; i++, ifd += 12) {
        if (r16(ifd) === 0x0112) { const v = r16(ifd + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    if (marker === 0xda) break; // empieza la imagen
    p += 2 + len;
  }
  return 1;
}

/** Distancia entre dos huellas perceptuales de 64 bits (hexadecimal). */
export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** Diferencia mínima (de 255) para que un vecino cuente como «más claro»: así el ruido de JPEG en zonas lisas no cambia la huella. */
export const DHASH_MARGIN = 3;

/** Huella «dhash» de una imagen en grises de 9×8 píxeles (64 bits como 16 dígitos hexadecimales). */
export function dhashFromGray(gray: ArrayLike<number>): string {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x + 1] - gray[y * 9 + x] > DHASH_MARGIN ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
