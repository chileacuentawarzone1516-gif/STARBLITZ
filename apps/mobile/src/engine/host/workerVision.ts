/**
 * `VisionPort` que ejecuta la visión en un Web Worker: la detección de texto, el OCR y la reconstrucción son cálculos de
 * varios segundos por página y, en el hilo de la interfaz, congelarían la pantalla (y la animación de progreso).
 *
 * - Cada petición lleva un número; la respuesta vuelve con el mismo.
 * - Cancelar avisa al worker; si no responde en unos segundos (está dentro de una inferencia larga) se descarta el worker y
 *   se crea otro cuando haga falta.
 * - `dispose()` termina el worker: la memoria de WebAssembly no se encoge, y esta es la única forma de devolverla al sistema.
 */
import type { BBox, Region } from '@starblitz/shared';
import { CancelledError } from '../core/errors';
import type { AnalysisResult, AnalyzeInput, ReadRegionInput, VisionPort } from '../pipeline/ports';
import type { VisionCall, VisionConfig, VisionFlags, VisionReply, VisionRequest, VisionResult } from './visionProtocol';
import { reviveError } from './visionWorker';

export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: VisionReply }) => void): void;
  addEventListener(type: 'error', cb: (e: { message?: string }) => void): void;
  terminate(): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  loaders?: (() => Promise<Blob>)[];
  onSettle?(): void;
}

export interface WorkerVisionOptions {
  /** Cuánto esperar a que el worker atienda una cancelación antes de descartarlo (ms). */
  cancelGraceMs?: number;
}

export class WorkerVision implements VisionPort {
  private worker: WorkerLike | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private dirty = true;
  private configuring: Promise<void> | null = null;

  constructor(
    private makeWorker: () => WorkerLike,
    private config: VisionConfig,
    private flags: () => Promise<VisionFlags>,
    private opts: WorkerVisionOptions = {},
  ) {}

  // -- worker -----------------------------------------------------------------------------------------------------
  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.makeWorker();
    w.addEventListener('message', (e) => this.onMessage(w, e.data));
    w.addEventListener('error', (e) => this.fail(w, new Error(`El motor de visión se detuvo: ${e.message ?? 'error desconocido'}`)));
    this.worker = w;
    this.dirty = true;
    return w;
  }

  private onMessage(w: WorkerLike, m: VisionReply): void {
    if (w !== this.worker) return; // respuesta de un worker ya descartado
    if ('op' in m) {
      const p = this.pending.get(m.callId);
      const load = p?.loaders?.[m.index];
      if (!load) { w.postMessage({ op: 'page', callId: m.callId, index: m.index, blob: null, error: 'Página no disponible' } satisfies VisionRequest); return; }
      load().then(
        (blob) => w.postMessage({ op: 'page', callId: m.callId, index: m.index, blob } satisfies VisionRequest),
        (e) => w.postMessage({ op: 'page', callId: m.callId, index: m.index, blob: null, error: e instanceof Error ? e.message : String(e) } satisfies VisionRequest),
      );
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    p.onSettle?.();
    if (m.ok) p.resolve(m.result); else p.reject(reviveError(m.error));
  }

  private fail(w: WorkerLike, error: Error): void {
    if (w !== this.worker) return;
    this.discard(error);
  }

  /** Descarta el worker actual y rechaza lo que estaba en curso. */
  private discard(error: Error): void {
    const w = this.worker;
    this.worker = null;
    this.configuring = null;
    try { w?.terminate(); } catch { /* ya terminado */ }
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { p.onSettle?.(); p.reject(error); }
  }

  private send<K extends VisionCall['op']>(w: WorkerLike, call: Extract<VisionCall, { op: K }>, signal?: AbortSignal, loaders?: Pending['loaders']): Promise<VisionResult[K]> {
    if (signal?.aborted) return Promise.reject(new CancelledError());
    const id = this.nextId++;
    return new Promise<VisionResult[K]>((resolve, reject) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        w.postMessage({ op: 'cancel', target: id } satisfies VisionRequest);
        grace = setTimeout(() => { if (this.pending.has(id)) this.discard(new CancelledError()); }, this.opts.cancelGraceMs ?? 4000);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void, reject, loaders,
        onSettle: () => { clearTimeout(grace); signal?.removeEventListener('abort', onAbort); },
      });
      w.postMessage({ id, ...call } satisfies VisionRequest);
    });
  }

  /** Antes de cada operación, el worker conoce qué modelos opcionales hay (se vuelve a enviar si cambiaron). */
  private async call<K extends VisionCall['op']>(call: Extract<VisionCall, { op: K }>, signal?: AbortSignal, loaders?: Pending['loaders']): Promise<VisionResult[K]> {
    const w = this.ensure();
    if (this.dirty || !this.configuring) {
      this.dirty = false;
      this.configuring = this.flags().then((flags) => this.send(w, { op: 'configure', config: this.config, flags }));
    }
    try { await this.configuring; } catch (e) { this.configuring = null; this.dirty = true; throw e; }
    return this.send(w, call, signal, loaders);
  }

  // -- VisionPort ------------------------------------------------------------------------------------------------
  analyze(input: AnalyzeInput, signal?: AbortSignal): Promise<AnalysisResult> {
    return this.call({ op: 'analyze', input }, signal);
  }

  detectLanguage(pages: (() => Promise<Blob>)[], signal?: AbortSignal): Promise<string> {
    return this.call({ op: 'detectLanguage', count: pages.length }, signal, pages);
  }

  clean(original: Blob, mask: Blob | null, regions: Region[], signal?: AbortSignal): Promise<Blob> {
    return this.call({ op: 'clean', original, mask, regions }, signal);
  }

  annotate(original: Blob, boxes: BBox[]): Promise<Uint8Array> {
    return this.call({ op: 'annotate', original, boxes });
  }

  readRegion(input: ReadRegionInput): Promise<Region> {
    return this.call({ op: 'readRegion', input });
  }

  refresh(): void { this.dirty = true; }

  /** Qué motor de lectura se usaría para este idioma (parte de la clave de la caché de OCR). */
  async fingerprint(lang: string): Promise<string> {
    const f = await this.flags();
    return lang === 'ja' && f.manga ? 'manga-ocr' : `ppocr-${lang}`;
  }

  /** Poca memoria: el worker suelta los modelos grandes opcionales (Manga OCR, LaMa) y los recarga si hacen falta. */
  async trim(): Promise<void> {
    if (!this.worker) return;
    await this.call({ op: 'trim' }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.discard(new CancelledError());
  }
}
