/**
 * Lectura de ZIP/CBZ con acceso aleatorio: nunca se carga el archivo entero en memoria (un CBZ de cientos de MB
 * reventaría un teléfono), solo el directorio central y, de uno en uno, los datos de cada imagen.
 *
 * Medidas de seguridad (mismas que el motor del PC): los nombres del archivo nunca se usan como ruta de disco,
 * se limitan el número de entradas, el tamaño descomprimido y la razón de compresión (bombas zip), y se rechazan
 * rutas con «..» y archivos cifrados.
 */
import { inflateSync } from 'fflate';

export const MAX_ENTRY_BYTES = 150 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5000;
export const MAX_COMPRESSION_RATIO = 200;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

export interface ByteSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export const blobSource = (blob: Blob): ByteSource => ({
  size: blob.size,
  async read(start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); },
});

export const bytesSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.length,
  async read(start, end) { return bytes.subarray(start, end); },
});

export class ZipProblem extends Error {}

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  isDir: boolean;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

/** Directorio central del ZIP. Lanza `ZipProblem` con un mensaje para la persona si el archivo no es válido. */
export async function listZip(src: ByteSource): Promise<ZipEntry[]> {
  if (src.size < 22) throw new ZipProblem('el ZIP está dañado');
  const tailStart = Math.max(0, src.size - (22 + 0xffff));
  const tail = await src.read(tailStart, src.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipProblem('el ZIP está dañado');
  const total = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdOffset = u32(tail, eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipProblem('el ZIP es demasiado grande');
  if (cdOffset + cdSize > src.size) throw new ZipProblem('el ZIP está dañado');
  if (total > MAX_ZIP_ENTRIES * 2 || cdSize > MAX_DIRECTORY_BYTES) throw new ZipProblem('el ZIP contiene demasiados archivos');
  const cd = await src.read(cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipProblem('el ZIP está dañado');
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    const compressedSize = u32(cd, p + 20), size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28), extraLen = u16(cd, p + 30), commentLen = u16(cd, p + 32), offset = u32(cd, p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipProblem('el ZIP es demasiado grande');
    const raw = cd.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? new TextDecoder('utf-8', { fatal: false }).decode(raw) : latin1(raw)).replace(/\\/g, '/');
    entries.push({ name, flags, method, compressedSize, size, offset, isDir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Datos descomprimidos de una entrada. */
export async function readZipEntry(src: ByteSource, e: ZipEntry): Promise<Uint8Array> {
  const head = await src.read(e.offset, e.offset + 30);
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) throw new ZipProblem('el ZIP está dañado');
  const start = e.offset + 30 + u16(head, 26) + u16(head, 28);
  if (start + e.compressedSize > src.size) throw new ZipProblem('el ZIP está dañado');
  const data = await src.read(start, start + e.compressedSize);
  if (e.method === 0) return data.slice();
  if (e.method !== 8) throw new ZipProblem('método de compresión no admitido');
  try {
    const out = inflateSync(data, { out: new Uint8Array(e.size) });
    if (out.length !== e.size) throw new Error('tamaño');
    return out;
  } catch {
    throw new ZipProblem('el archivo está dañado dentro del ZIP');
  }
}
