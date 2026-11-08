/**
 * Importación de ZIP/CBZ, PDF e imágenes (JPG, PNG, WEBP) al proyecto (equivalente a `importers/ingest.py`).
 *
 * El tipo se decide por la firma del archivo. Los archivos se leen de uno en uno (un ZIP nunca se carga entero),
 * las páginas se ordenan de forma natural y se detectan duplicados exactos (SHA-1) y casi iguales (dhash ≤ 3).
 */
import { sha1Hex } from './hash';
import { hamming, IMAGE_KINDS, sniff } from './formats';
import { naturalCompare } from './sort';
import {
  listZip, MAX_COMPRESSION_RATIO, MAX_ENTRY_BYTES, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES, readZipEntry, ZipProblem, type ByteSource,
} from './zip';

export class ImportProblem extends Error {}

export interface LoadedImage { data: Uint8Array; ext: string; width: number; height: number; dhash: string }

export interface ImageCodec {
  /** Valida y, si hace falta, normaliza la imagen (orientación EXIF). Lanza `ImportProblem`. */
  load(name: string, data: Uint8Array, kind: string): Promise<LoadedImage>;
}

export interface PdfPages {
  readonly numPages: number;
  /** Página `index` (0…) renderizada como PNG. */
  render(index: number): Promise<Uint8Array>;
  destroy(): Promise<void>;
}
export type PdfOpener = (data: Uint8Array) => Promise<PdfPages>;

export interface ImportedImage { name: string; data: Uint8Array; ext: string; width: number; height: number; sha1: string; dhash: string }

export interface ImportReport {
  added: string[];
  duplicates: { file: string; of: string; exact: boolean; page_id?: string }[];
  errors: { file: string; reason: string }[];
  skipped_limit: number;
}

export interface Upload { name: string; source: ByteSource }

export interface IngestDeps {
  codec: ImageCodec;
  pdf?: PdfOpener;
  /** Guarda la imagen y devuelve el identificador de la página creada. */
  add(img: ImportedImage, nearDuplicateOf: string | null): Promise<string>;
  progress?(fraction: number, message: string): void;
  /** Punto de control entre archivos (cancelar o pausar). */
  check?(): Promise<void>;
}

const IGNORED_EXTS = new Set(['txt', 'xml', 'json', 'nfo', 'db', 'ini', 'url']);
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const extOf = (p: string) => { const n = basename(p); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

type Item = { name: string; data: Uint8Array } | { name: string; error: string };

/** Contenido de un archivo subido: una o varias imágenes (o errores por entrada). */
async function* expand(u: Upload, deps: IngestDeps): AsyncGenerator<Item> {
  const head = await u.source.read(0, Math.min(16, u.source.size));
  const kind = sniff(head);
  if (kind && IMAGE_KINDS.includes(kind)) {
    if (u.source.size > MAX_ENTRY_BYTES) { yield { name: u.name, error: 'archivo sospechoso o demasiado grande' }; return; }
    yield { name: u.name, data: await u.source.read(0, u.source.size) };
  } else if (kind === 'zip') {
    yield* expandZip(u, deps);
  } else if (kind === 'pdf') {
    yield* expandPdf(u, deps);
  } else {
    yield { name: u.name, error: 'formato no admitido (usa ZIP, CBZ, PDF, JPG, PNG o WEBP)' };
  }
}

async function* expandZip(u: Upload, _deps: IngestDeps): AsyncGenerator<Item> {
  let entries;
  try {
    entries = (await listZip(u.source)).filter((e) => !e.isDir);
  } catch (e) {
    yield { name: u.name, error: e instanceof ZipProblem ? e.message : 'el ZIP está dañado' };
    return;
  }
  if (entries.length > MAX_ZIP_ENTRIES) { yield { name: u.name, error: 'el ZIP contiene demasiados archivos' }; return; }
  if (entries.reduce((n, e) => n + e.size, 0) > MAX_ZIP_TOTAL_BYTES) { yield { name: u.name, error: 'el contenido descomprimido del ZIP es demasiado grande' }; return; }
  for (const e of [...entries].sort((a, b) => naturalCompare(a.name, b.name))) {
    const parts = e.name.split('/').filter((p) => p !== '');
    const name = parts[parts.length - 1] ?? e.name;
    if (parts.includes('..')) { yield { name, error: 'ruta no permitida dentro del ZIP' }; continue; }
    if (parts.some((p) => p.startsWith('.') || p === '__MACOSX')) continue;
    if (e.flags & 1) { yield { name, error: 'archivo cifrado con contraseña' }; continue; }
    if (e.size > MAX_ENTRY_BYTES || (e.compressedSize && e.size / e.compressedSize > MAX_COMPRESSION_RATIO)) {
      yield { name, error: 'archivo sospechoso o demasiado grande' };
      continue;
    }
    const ext = extOf(e.name);
    if (!IMAGE_KINDS.includes(ext === 'jpeg' ? 'jpg' : ext)) {
      if (!IGNORED_EXTS.has(ext)) yield { name, error: 'formato no admitido dentro del ZIP' };
      continue;
    }
    try {
      yield { name: e.name, data: await readZipEntry(u.source, e) };
    } catch (err) {
      yield { name, error: err instanceof ZipProblem ? err.message : 'no se pudo leer el archivo del ZIP' };
    }
  }
}

async function* expandPdf(u: Upload, deps: IngestDeps): AsyncGenerator<Item> {
  if (!deps.pdf) { yield { name: u.name, error: 'esta versión no puede leer PDF' }; return; }
  let doc: PdfPages;
  try {
    doc = await deps.pdf(await u.source.read(0, u.source.size));
  } catch {
    yield { name: u.name, error: 'el PDF está dañado o protegido con contraseña' };
    return;
  }
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const label = `${u.name} · página ${i + 1}`;
      try {
        yield { name: label, data: await doc.render(i) };
      } catch (err) {
        console.warn(`Fallo extrayendo la página ${i + 1} del PDF`, err);
        yield { name: label, error: 'no se pudo extraer la página' };
      }
    }
  } finally {
    await doc.destroy();
  }
}

/**
 * Importa los archivos subidos. `existing`: (id, sha1, dhash) de las páginas ya presentes; `capacity`: cuántas
 * páginas más caben en el proyecto.
 */
export async function ingest(uploads: Upload[], existing: { id: string; sha1: string; dhash: string }[], capacity: number, deps: IngestDeps): Promise<ImportReport> {
  const report: ImportReport = { added: [], duplicates: [], errors: [], skipped_limit: 0 };
  const known = [...existing];
  const shaIndex = new Map(known.map((k) => [k.sha1, k.id]));
  const total = uploads.length;
  const sorted = [...uploads].sort((a, b) => naturalCompare(a.name, b.name));
  for (const [n, upload] of sorted.entries()) {
    for await (const item of expand(upload, deps)) {
      await deps.check?.();
      deps.progress?.(n / Math.max(1, total), `Importando ${basename(item.name)}`);
      if ('error' in item) { report.errors.push({ file: item.name, reason: item.error }); continue; }
      if (capacity <= 0) { report.skipped_limit += 1; continue; }
      const kind = sniff(item.data.subarray(0, 16));
      if (!kind || !IMAGE_KINDS.includes(kind)) { report.errors.push({ file: item.name, reason: 'no es una imagen JPG, PNG o WEBP' }); continue; }
      let loaded: LoadedImage;
      try {
        loaded = await deps.codec.load(basename(item.name), item.data, kind);
      } catch (err) {
        if (!(err instanceof ImportProblem)) throw err;
        report.errors.push({ file: item.name, reason: err.message });
        continue;
      }
      const sha1 = await sha1Hex(loaded.data);
      const exact = shaIndex.get(sha1);
      if (exact) { report.duplicates.push({ file: item.name, of: exact, exact: true }); continue; }
      const near = known.find((k) => hamming(k.dhash, loaded.dhash) <= 3)?.id ?? null;
      const id = await deps.add({ name: basename(item.name) || item.name, data: loaded.data, ext: loaded.ext, width: loaded.width, height: loaded.height, sha1, dhash: loaded.dhash }, near);
      if (near) report.duplicates.push({ file: item.name, of: near, exact: false, page_id: id });
      known.push({ id, sha1, dhash: loaded.dhash });
      shaIndex.set(sha1, id);
      report.added.push(id);
      capacity -= 1;
    }
  }
  deps.progress?.(1, 'Importación completada');
  return report;
}
