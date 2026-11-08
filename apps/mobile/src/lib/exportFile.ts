/**
 * Entrega de lo exportado. En Android el archivo se escribe por trozos en la carpeta privada de la app (un PDF de 50 páginas
 * puede pesar cientos de MB: no cabe de una vez en el puente), se copia a «Descargas/STARBLITZ» (MediaStore, sin permisos) y
 * se ofrece compartir. En el navegador se descarga con un enlace.
 */
import { Share } from '@capacitor/share';
import type { ExportFile } from '@starblitz/shared';
import { isAndroidApp, nativePlugin } from '../engine/host/native';

const CHUNK = 3 * 1024 * 1024; // múltiplo de 3: cada trozo es base64 sin relleno intermedio

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

/** Escribe un Blob en la carpeta privada de la app por trozos. */
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  const native = nativePlugin();
  let first = true;
  for (let off = 0; off < blob.size || first; off += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    await native.fsAppendBase64({ path, data: toBase64(bytes), truncate: first });
    first = false;
  }
}

export interface SavedExport { name: string; location: string; shareUri: string | null }

export async function saveExports(files: ExportFile[], opts: { share: boolean }): Promise<SavedExport[]> {
  if (!isAndroidApp()) {
    for (const f of files) {
      const url = URL.createObjectURL(f.blob);
      Object.assign(document.createElement('a'), { href: url, download: f.name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }
    return files.map((f) => ({ name: f.name, location: 'Descargas del navegador', shareUri: null }));
  }
  const native = nativePlugin();
  const out: SavedExport[] = [];
  for (const f of files) {
    const path = `exports/${f.name.replace(/[^\w .()+@=,-]/g, '_')}`;
    await writeBlob(path, f.blob);
    let location = 'Carpeta privada de STARBLITZ';
    try { location = (await native.saveToDownloads({ path, name: f.name, mime: f.blob.type || 'application/octet-stream' })).location; } catch { /* Android 9: solo compartir */ }
    out.push({ name: f.name, location, shareUri: `file://${(await native.fsAbsolutePath({ path })).path}` });
  }
  if (opts.share) {
    await Share.share({ title: 'STARBLITZ', files: out.map((o) => o.shareUri!).filter(Boolean), dialogTitle: 'Compartir traducción' }).catch(() => undefined);
  }
  return out;
}

/** Libera lo que quedó en la carpeta de exportaciones temporales. */
export async function clearExportCache(): Promise<void> {
  if (isAndroidApp()) await nativePlugin().fsRemove({ path: 'exports' }).catch(() => undefined);
}
