/**
 * Núcleo del hilo de visión: recibe las peticiones de la página, las ejecuta con `VisionService` (OpenCV + ONNX Runtime
 * en WebAssembly) y responde. Está separado de `visionWorker.entry.ts` (que solo conecta con `self`) para poder probarlo en Node.
 */
import type { VisionAssets } from '../vision/service';
import { VisionService } from '../vision/service';
import type { MangaOcrFiles } from '../vision/ocr/mangaOcr';
import { AppError, CancelledError, ModelMissingError } from '../core/errors';
import type { VisionConfig, VisionFlags, VisionReply, VisionRequest, SerializedError } from './visionProtocol';

export type Fetch = (url: string) => Promise<Response>;

/** Modelos de visión leídos a través de URL (el servidor local de la app sirve la carpeta privada de modelos). */
export class UrlVisionAssets implements VisionAssets {
  private ppocrBytes: Promise<Uint8Array> | null = null;

  constructor(private config: VisionConfig, private flags: () => VisionFlags, private fetcher: Fetch = (u) => fetch(u)) {}

  private async bytes(url: string): Promise<Uint8Array> {
    const res = await this.fetcher(url);
    if (!res.ok) throw new Error(`No se pudo leer el modelo (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }

  private model(id: string, rel: string) { return `${this.config.modelsBase}/${id}/${rel}`; }

  async detector(): Promise<Uint8Array> {
    if (!this.flags().detector) throw new ModelMissingError('text-detector', 'Detector de texto');
    return this.bytes(this.model('text-detector', 'comictextdetector.onnx'));
  }

  ppocr(): Promise<Uint8Array> {
    this.ppocrBytes ??= this.bytes(this.config.ppocrUrl).catch((e) => { this.ppocrBytes = null; throw e; });
    return this.ppocrBytes;
  }

  async hasMangaOcr(): Promise<boolean> { return this.flags().manga; }

  async mangaOcr(): Promise<MangaOcrFiles | null> {
    if (!this.flags().manga) return null;
    const text = async (rel: string) => new TextDecoder().decode(await this.bytes(this.model('manga-ocr', rel)));
    const [encoder, decoder, vocab, generationConfig] = await Promise.all([
      this.bytes(this.model('manga-ocr', 'encoder_model.onnx')), this.bytes(this.model('manga-ocr', 'decoder_model.onnx')),
      text('vocab.txt'), text('generation_config.json'),
    ]);
    return { encoder, decoder, vocab, generationConfig };
  }

  async lama(): Promise<Uint8Array | null> {
    return this.flags().lama ? this.bytes(this.model('lama', 'lama_fp32.onnx')) : null;
  }
}

export function serializeError(e: unknown): SerializedError {
  // Las subclases primero: `instanceof AppError` también las acepta.
  if (e instanceof CancelledError) return { name: 'CancelledError', message: e.message, code: e.code, status: e.status };
  if (e instanceof ModelMissingError) return { name: 'ModelMissingError', message: e.message, code: e.code, status: e.status, details: e.details };
  if (e instanceof AppError) return { name: 'AppError', message: e.message, code: e.code, status: e.status, details: e.details };
  const err = e as Error;
  return { name: err?.name ?? 'Error', message: err?.message ?? String(e) };
}

export function reviveError(s: SerializedError): Error {
  if (s.name === 'CancelledError') return new CancelledError();
  if (s.name === 'ModelMissingError') {
    const e = new ModelMissingError(String(s.details?.model_id ?? ''), '');
    e.message = s.message;
    return e;
  }
  if (s.name === 'AppError') return new AppError(s.code ?? 'error', s.message, s.status ?? 400, s.details ?? {});
  return new Error(s.message);
}

export interface WorkerHostDeps {
  post(reply: VisionReply): void;
  /** Crea el servicio de visión (en producción, `VisionService`; las pruebas ponen uno simulado). */
  createService(assets: VisionAssets, flags: () => VisionFlags, config: VisionConfig): VisionServiceLike;
  fetcher?: Fetch;
}

export type VisionServiceLike = Pick<VisionService, 'analyze' | 'detectLanguage' | 'clean' | 'annotate' | 'readRegion' | 'refresh' | 'dispose'>;

export class VisionWorkerHost {
  private service: VisionServiceLike | null = null;
  private flags: VisionFlags = { detector: false, manga: false, lama: false, inpaintMode: 'fast' };
  private aborts = new Map<number, AbortController>();
  private pageWaiters = new Map<string, (blob: Blob | null, error?: string) => void>();

  constructor(private d: WorkerHostDeps) {}

  handle(msg: VisionRequest): void {
    if (msg.op === 'cancel') { this.aborts.get(msg.target)?.abort(); return; }
    if (msg.op === 'page') { this.pageWaiters.get(`${msg.callId}:${msg.index}`)?.(msg.blob, msg.error); return; }
    void this.run(msg);
  }

  private pageLoader(callId: number, index: number): () => Promise<Blob> {
    return () => new Promise<Blob>((resolve, reject) => {
      const key = `${callId}:${index}`;
      this.pageWaiters.set(key, (blob, error) => {
        this.pageWaiters.delete(key);
        if (blob) resolve(blob); else reject(new Error(error || 'No se pudo leer la página.'));
      });
      this.d.post({ op: 'needPage', callId, index });
    });
  }

  private async run(msg: Extract<VisionRequest, { id: number }>): Promise<void> {
    const ctl = new AbortController();
    this.aborts.set(msg.id, ctl);
    try {
      this.d.post({ id: msg.id, ok: true, result: await this.exec(msg, ctl.signal) });
    } catch (e) {
      this.d.post({ id: msg.id, ok: false, error: serializeError(e) });
    } finally {
      this.aborts.delete(msg.id);
    }
  }

  private svc(): VisionServiceLike {
    if (!this.service) throw new Error('El motor de visión no está configurado.');
    return this.service;
  }

  private async exec(msg: Extract<VisionRequest, { id: number }>, signal: AbortSignal): Promise<unknown> {
    switch (msg.op) {
      case 'configure': {
        this.flags = msg.flags;
        if (!this.service) {
          const assets = new UrlVisionAssets(msg.config, () => this.flags, this.d.fetcher);
          this.service = this.d.createService(assets, () => this.flags, msg.config);
        } else {
          this.service.refresh?.();
        }
        return undefined;
      }
      case 'analyze': return this.svc().analyze(msg.input, signal);
      case 'detectLanguage': return this.svc().detectLanguage(Array.from({ length: msg.count }, (_, i) => this.pageLoader(msg.id, i)), signal);
      case 'clean': return this.svc().clean(msg.original, msg.mask, msg.regions, signal);
      case 'annotate': return this.svc().annotate(msg.original, msg.boxes);
      case 'readRegion': return this.svc().readRegion(msg.input);
      case 'dispose': await this.service?.dispose?.(); this.service = null; return undefined;
    }
  }
}
