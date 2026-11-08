/**
 * `DeviceFiles` sobre el plugin nativo: archivos reales en la carpeta privada de la app. Las descargas las hace el
 * sistema (reanudables, verificadas con SHA-256) y los modelos de lenguaje quedan con una ruta absoluta que
 * `llama-server` puede abrir; los modelos de visión se leen sin copiarlos a base64 a través del servidor local de
 * Capacitor (`/_capacitor_file_/…`).
 */
import { AppError, CancelledError } from '../core/errors';
import { safePath, type DeviceFiles, type DirEntry, type DownloadHooks, type DownloadRequest, type FileStat } from '../platform/files';
import { downloadError } from '../platform/transfer';
import type { NativeError, NativeListener, StarblitzNativePlugin } from './native';

export interface NativeFilesOptions {
  /** Convierte una ruta absoluta del teléfono en una URL que la WebView puede leer (`Capacitor.convertFileSrc`). */
  convertFileSrc: (absolutePath: string) => string;
  fetcher?: (url: string) => Promise<Response>;
}

const basename = (p: string) => p.split('/').pop() ?? p;

/** Traduce los códigos del plugin a los mismos errores de dominio que el resto del motor. */
export function mapNativeError(e: unknown, path: string): Error {
  const err = e as NativeError;
  switch (err?.code) {
    case 'cancelled': return new CancelledError();
    case 'auth_required': return downloadError(403);
    case 'not_found': return downloadError(404);
    case 'integrity': return new AppError('integrity', `La descarga de ${basename(path)} no está íntegra (tamaño o huella SHA-256 distintos). Reinténtala.`, 502);
    case 'disk_full': return new AppError('disk_full', 'No queda espacio en el teléfono para terminar la descarga. Libera espacio y reanúdala: continuará donde se quedó.', 507);
    case 'insecure': return new AppError('insecure', 'Solo se permiten descargas cifradas (HTTPS).', 422);
    case 'invalid_path': return new AppError('invalid_path', 'Ruta de archivo no válida.', 422);
    case 'busy': return new AppError('busy', 'Este archivo ya se está descargando.', 409);
    case 'download_failed': return downloadError(0);
    default: return err instanceof Error ? err : new Error(String(e));
  }
}

export class NativeFiles implements DeviceFiles {
  private seq = 0;
  private progress = new Map<string, (done: number, total: number) => void>();
  private listener: Promise<NativeListener> | null = null;

  constructor(private native: StarblitzNativePlugin, private opts: NativeFilesOptions) {}

  private ensureListener(): void {
    this.listener ??= this.native.addListener('downloadProgress', (e) => this.progress.get(e.id)?.(e.done, e.total));
  }

  async stat(path: string): Promise<FileStat> {
    return this.native.fsStat({ path: safePath(path) });
  }

  async list(dir: string): Promise<DirEntry[]> {
    return (await this.native.fsList({ path: safePath(dir) })).entries;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const abs = await this.absolutePath(path);
    if (!abs) throw new Error(`No existe ${path}`);
    const res = await (this.opts.fetcher ?? fetch)(this.opts.convertFileSrc(abs));
    if (!res.ok) throw new Error(`No se pudo leer ${basename(path)} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async readText(path: string): Promise<string | undefined> {
    return (await this.native.fsReadText({ path: safePath(path) })).text;
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.native.fsWriteText({ path: safePath(path), text });
  }

  async remove(path: string): Promise<void> {
    await this.native.fsRemove({ path: safePath(path) });
  }

  async freeBytes(): Promise<number> {
    return (await this.native.fsFreeBytes()).bytes;
  }

  async sha256(path: string): Promise<string> {
    return (await this.native.fsSha256({ path: safePath(path) })).sha256;
  }

  async absolutePath(path: string): Promise<string | null> {
    return (await this.native.fsAbsolutePath({ path: safePath(path) })).path;
  }

  async download(req: DownloadRequest, hooks: DownloadHooks = {}): Promise<void> {
    const path = safePath(req.path);
    if (hooks.signal?.aborted) throw new CancelledError();
    this.ensureListener();
    const id = `d${Date.now().toString(36)}${++this.seq}`;
    if (hooks.onProgress) this.progress.set(id, hooks.onProgress);
    const onAbort = () => { void this.native.cancelDownload({ id }).catch(() => undefined); };
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.native.download({ id, url: req.url, path, headers: req.headers, expectedSize: req.expectedSize ?? 0, sha256: req.sha256 ?? null });
    } catch (e) {
      throw mapNativeError(e, path);
    } finally {
      this.progress.delete(id);
      hooks.signal?.removeEventListener('abort', onAbort);
    }
  }
}
