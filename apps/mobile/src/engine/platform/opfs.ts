/**
 * Archivos en el sistema de archivos privado del navegador (OPFS): la implementación de `DeviceFiles` cuando la app
 * se abre sin el plugin nativo (navegador, vista previa, pruebas en Chromium). Funciona igual en la página y en un Worker.
 * No tiene rutas reales, así que `llama-server` no puede usar estos archivos: sirve para la visión y para probar el flujo.
 */
import { Sha256 } from './sha256';
import { safePath, type DeviceFiles, type DirEntry, type DownloadHooks, type DownloadRequest, type FileStat } from './files';
import { resumableDownload, type Fetcher, type PartStore, type PartWriter, type TransferOptions } from './transfer';

const SHA_CHUNK = 8 * 1024 * 1024;

type Dir = FileSystemDirectoryHandle;

export class OpfsFiles implements DeviceFiles, PartStore {
  constructor(private rootName = 'starblitz', private fetcher?: Fetcher, private transfer: TransferOptions = {}) {}

  private async root(): Promise<Dir> {
    return (await navigator.storage.getDirectory()).getDirectoryHandle(this.rootName, { create: true });
  }

  private async dirOf(parts: string[], create: boolean): Promise<Dir | null> {
    let dir = await this.root();
    for (const p of parts) {
      try { dir = await dir.getDirectoryHandle(p, { create }); } catch { return null; }
    }
    return dir;
  }

  private split(path: string): { parent: string[]; name: string } {
    const parts = safePath(path).split('/');
    return { parent: parts.slice(0, -1), name: parts[parts.length - 1] };
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle | null> {
    const { parent, name } = this.split(path);
    const dir = await this.dirOf(parent, create);
    if (!dir) return null;
    try { return await dir.getFileHandle(name, { create }); } catch { return null; }
  }

  async stat(path: string): Promise<FileStat> {
    const h = await this.fileHandle(path);
    if (h) return { exists: true, size: (await h.getFile()).size, isDir: false };
    const { parent, name } = this.split(path);
    const dir = await this.dirOf(parent, false);
    if (dir) {
      try { await dir.getDirectoryHandle(name); return { exists: true, size: 0, isDir: true }; } catch { /* no existe */ }
    }
    return { exists: false, size: 0, isDir: false };
  }

  async list(path: string): Promise<DirEntry[]> {
    const dir = await this.dirOf(safePath(path).split('/'), false);
    if (!dir) return [];
    const out: DirEntry[] = [];
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind === 'directory') out.push({ name, size: 0, isDir: true });
      else out.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size, isDir: false });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const h = await this.fileHandle(path);
    if (!h) throw new Error(`No existe ${path}`);
    return new Uint8Array(await (await h.getFile()).arrayBuffer());
  }

  async readText(path: string): Promise<string | undefined> {
    const h = await this.fileHandle(path);
    return h ? (await h.getFile()).text() : undefined;
  }

  async writeText(path: string, text: string): Promise<void> {
    const h = (await this.fileHandle(path, true))!;
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
  }

  async remove(path: string): Promise<void> {
    const { parent, name } = this.split(path);
    const dir = await this.dirOf(parent, false);
    if (!dir) return;
    try { await dir.removeEntry(name, { recursive: true }); } catch { /* no existía */ }
  }

  async freeBytes(): Promise<number> {
    const e = await navigator.storage.estimate();
    return Math.max(0, (e.quota ?? 0) - (e.usage ?? 0));
  }

  async sha256(path: string): Promise<string> {
    const h = await this.fileHandle(path);
    if (!h) throw new Error(`No existe ${path}`);
    const file = await h.getFile();
    const sha = new Sha256();
    for (let off = 0; off < file.size; off += SHA_CHUNK) sha.update(new Uint8Array(await file.slice(off, off + SHA_CHUNK).arrayBuffer()));
    return sha.hex();
  }

  async absolutePath(): Promise<string | null> { return null; }

  download(req: DownloadRequest, hooks?: DownloadHooks): Promise<void> {
    safePath(req.path);
    return resumableDownload(this, req, hooks, { ...this.transfer, fetcher: this.fetcher });
  }

  // -- PartStore ---------------------------------------------------------------------------
  async size(path: string): Promise<number> {
    const h = await this.fileHandle(path);
    return h ? (await h.getFile()).size : 0;
  }

  async open(path: string, append: boolean): Promise<PartWriter> {
    const h = (await this.fileHandle(path, true))!;
    const size = append ? (await h.getFile()).size : 0;
    const w = await h.createWritable({ keepExistingData: append });
    if (append) await w.seek(size);
    return {
      write: (chunk) => w.write(chunk.slice()),
      close: () => w.close(),
    };
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.fileHandle(from);
    if (!src) throw new Error(`No existe ${from}`);
    await this.remove(to);
    const target = this.split(to);
    const destDir = await this.dirOf(target.parent, true);
    const move = (src as unknown as { move?: (dir: Dir, name: string) => Promise<void> }).move;
    if (destDir && move) { // Chromium ≥ 110: renombrado real, sin copiar
      try { await move.call(src, destDir, target.name); return; } catch { /* se copia */ }
    }
    const file = await src.getFile();
    const dst = (await this.fileHandle(to, true))!;
    const w = await dst.createWritable();
    for (let off = 0; off < file.size; off += SHA_CHUNK) await w.write(await file.slice(off, off + SHA_CHUNK).arrayBuffer());
    await w.close();
    await this.remove(from);
  }
}
