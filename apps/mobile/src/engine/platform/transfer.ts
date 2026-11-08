/**
 * Descarga de archivos grandes con reanudación, verificación de integridad y cancelación (equivalente a
 * `core/download.py`). La usan los almacenes que escriben desde JavaScript (navegador y pruebas); en Android la
 * descarga la hace el plugin nativo con las mismas reglas:
 *
 *  - se escribe en `<destino>.part` y solo se renombra al terminar y verificar: un archivo con su nombre final está completo;
 *  - una descarga interrumpida (red, cierre de la app, cancelación) continúa donde se quedó con `Range`;
 *  - si se conoce el SHA-256 se verifica y, si no coincide, se borra el archivo y se informa;
 *  - las credenciales solo viajan al servidor original (el navegador las retira en las redirecciones entre dominios).
 */
import { AppError, CancelledError } from '../core/errors';
import type { DownloadHooks, DownloadRequest } from './files';

export interface PartWriter { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }

/** Primitivas de escritura que necesita el descargador. */
export interface PartStore {
  /** Tamaño del archivo; 0 si no existe. */
  size(path: string): Promise<number>;
  open(path: string, append: boolean): Promise<PartWriter>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  sha256(path: string): Promise<string>;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface TransferOptions {
  fetcher?: Fetcher;
  retries?: number;
  /** Pausa entre reintentos (ms) por intento; las pruebas la reducen. */
  backoffMs?: number;
  /** Tiempo máximo sin recibir datos (ms). */
  idleMs?: number;
}

class HttpFailure extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new CancelledError()); }, { once: true });
});

export async function resumableDownload(store: PartStore, req: DownloadRequest, hooks: DownloadHooks = {}, opts: TransferOptions = {}): Promise<void> {
  const fetcher = opts.fetcher ?? ((u, i) => fetch(u, i));
  const retries = opts.retries ?? 4;
  const backoff = opts.backoffMs ?? 2000;
  const expected = req.expectedSize ?? 0;
  const dest = req.path, part = `${req.path}.part`;
  const sha = req.sha256?.toLowerCase() || null;

  const existing = await store.size(dest);
  if (existing && (!expected || existing === expected)) {
    if (!sha || (await store.sha256(dest)) === sha) { hooks.onProgress?.(existing, existing); return; }
  }
  if (existing) await store.remove(dest); // existe pero está incompleto o corrupto

  let lastStatus = 0;
  let ok = false;
  for (let attempt = 0; attempt < retries && !ok; attempt++) {
    try {
      await stream(store, fetcher, req, part, expected, hooks, opts.idleMs ?? 90_000);
      ok = true;
    } catch (e) {
      if (e instanceof CancelledError || e instanceof AppError) throw e;
      if (hooks.signal?.aborted) throw new CancelledError();
      if (e instanceof HttpFailure) {
        lastStatus = e.status;
        if ([401, 403, 404, 410].includes(e.status)) break; // reintentar no serviría de nada
      } else {
        lastStatus = 0;
      }
      console.warn(`Descarga interrumpida (${req.url}), intento ${attempt + 1}/${retries}`, e);
      await sleep(Math.min(backoff * (attempt + 1), 8000), hooks.signal);
    }
  }
  if (!ok) throw downloadError(lastStatus);

  const size = await store.size(part);
  if (expected && size !== expected) {
    await store.remove(part);
    throw new AppError('integrity', `La descarga de ${basename(dest)} quedó incompleta (${size} de ${expected} bytes). Reinténtala.`, 502);
  }
  if (sha && (await store.sha256(part)) !== sha) {
    await store.remove(part);
    throw new AppError('integrity', `La descarga de ${basename(dest)} está corrupta (huella SHA-256 distinta). Reinténtala.`, 502);
  }
  await store.rename(part, dest);
}

const basename = (p: string) => p.split('/').pop() ?? p;

export function downloadError(status: number): AppError {
  if (status === 401 || status === 403) {
    return new AppError('auth_required', 'Este archivo exige iniciar sesión en Hugging Face (modelo restringido). Añade tu token en Modelos → Avanzado y acepta la licencia en la web del modelo.', 403);
  }
  if (status === 404 || status === 410) return new AppError('not_found', 'El archivo ya no existe en el repositorio.', 404);
  return new AppError('download_failed', 'No se pudo descargar el archivo. Comprueba tu conexión a Internet y vuelve a intentarlo; la descarga continuará donde se quedó.', 502);
}

async function stream(store: PartStore, fetcher: Fetcher, req: DownloadRequest, part: string, expected: number, hooks: DownloadHooks, idleMs: number): Promise<void> {
  let offset = await store.size(part);
  if (expected && offset > expected) { await store.remove(part); offset = 0; }
  if (expected && offset === expected) return;

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (offset) headers.Range = `bytes=${offset}-`;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  hooks.signal?.addEventListener('abort', onAbort, { once: true });
  if (hooks.signal?.aborted) throw new CancelledError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), idleMs); };
  let writer: PartWriter | null = null;
  try {
    arm();
    const res = await fetcher(req.url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (res.status === 416) return; // el servidor dice que ya tenemos todo
    if (!res.ok) throw new HttpFailure(res.status);
    if (offset && res.status === 200) offset = 0; // no admite reanudar: se empieza de cero
    const length = Number(res.headers.get('content-length') || 0);
    const total = expected || (length ? length + offset : 0);
    writer = await store.open(part, offset > 0);
    let written = offset, last = 0;
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      await writer.write(value);
      written += value.length;
      const t = Date.now();
      if (hooks.onProgress && t - last > 200) { last = t; hooks.onProgress(written, total || written); }
    }
    hooks.onProgress?.(written, total || written);
  } finally {
    clearTimeout(timer);
    hooks.signal?.removeEventListener('abort', onAbort);
    await writer?.close().catch(() => undefined);
  }
}
