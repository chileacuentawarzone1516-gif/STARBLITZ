import { describe, expect, it } from 'vitest';
import { AppError, CancelledError, ModelMissingError } from '../../src/engine/core/errors';
import { UrlVisionAssets, VisionWorkerHost, reviveError, serializeError, type VisionServiceLike } from '../../src/engine/host/visionWorker';
import type { VisionConfig, VisionFlags, VisionReply, VisionRequest } from '../../src/engine/host/visionProtocol';
import { WorkerVision, type WorkerLike } from '../../src/engine/host/workerVision';
import { FakeVision, sleep } from './helpers';

const config: VisionConfig = { modelsBase: 'http://localhost/files/models', ppocrUrl: 'http://localhost/models/ppocr-rec.onnx' };
const FLAGS: VisionFlags = { detector: true, manga: false, lama: false, inpaintMode: 'fast' };

/** Worker en el mismo proceso: los mensajes se clonan y se entregan de forma asíncrona, como en un Worker real. */
class Loopback implements WorkerLike {
  terminated = false;
  hung = false;                     // simula una inferencia larga que no atiende mensajes
  received: VisionRequest[] = [];
  private listeners: ((e: { data: VisionReply }) => void)[] = [];
  private errors: ((e: { message?: string }) => void)[] = [];
  readonly host: VisionWorkerHost;

  constructor(service: () => VisionServiceLike, public configured: { flags: VisionFlags }[] = []) {
    this.host = new VisionWorkerHost({
      post: (reply) => { if (!this.terminated) queueMicrotask(() => this.listeners.forEach((l) => l({ data: structuredClone(reply) }))); },
      createService: () => service(),
    });
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    const m = structuredClone(message) as VisionRequest;
    this.received.push(m);
    if (m.op === 'configure') this.configured.push({ flags: m.flags });
    if (this.hung && m.op !== 'cancel') return;
    setTimeout(() => this.host.handle(m), 0);
  }

  addEventListener(type: string, cb: never): void {
    if (type === 'message') this.listeners.push(cb);
    else this.errors.push(cb);
  }

  terminate(): void { this.terminated = true; }
  crash(message: string): void { this.errors.forEach((l) => l({ message })); }
}

function setup(pages: Record<string, { texts: string[] }> = { a: { texts: ['一'] } }, opts: { cancelGraceMs?: number } = {}) {
  const vision = new FakeVision(pages);
  const workers: Loopback[] = [];
  let flags = FLAGS;
  const proxy = new WorkerVision(() => { const w = new Loopback(() => vision as unknown as VisionServiceLike); workers.push(w); return w; }, config, async () => flags, opts);
  return { vision, workers, proxy, setFlags: (f: VisionFlags) => { flags = f; } };
}

const blob = (key: string) => new Blob([key], { type: 'image/png' });

describe('visión en un Web Worker (proxy ↔ núcleo del worker)', () => {
  it('analiza una página a través del worker y devuelve regiones, paneles y máscara intactos', async () => {
    const { proxy, workers } = setup({ a: { texts: ['一', '二'] } });
    const res = await proxy.analyze({ original: blob('a'), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 300 });
    expect(res.regions.map((r) => r.source_text)).toEqual(['一', '二']);
    expect(res.panels).toEqual([[0, 0, 200, 300]]);
    expect(await res.mask.text()).toBe('mask:a');                       // el Blob viaja y vuelve
    expect(workers).toHaveLength(1);
  });

  it('configura el worker con los modelos disponibles antes de la primera operación y de nuevo si cambian', async () => {
    const { proxy, workers, setFlags } = setup();
    const input = { original: blob('a'), lang: 'ja', direction: 'rtl' as const, sfx: 'keep' as const, pageHeight: 300 };
    await proxy.analyze(input);
    await proxy.analyze(input);
    const cfgs = () => workers[0].received.filter((m) => m.op === 'configure');
    expect(cfgs()).toHaveLength(1);                                      // no se repite en cada página
    expect(workers[0].received[0].op).toBe('configure');                // y va antes que cualquier operación
    setFlags({ ...FLAGS, manga: true });
    proxy.refresh();                                                     // p. ej. se instaló Manga OCR
    await proxy.analyze(input);
    expect(cfgs()).toHaveLength(2);
    expect((cfgs()[1] as { flags: VisionFlags }).flags.manga).toBe(true);
  });

  it('las operaciones simultáneas se emparejan con su respuesta', async () => {
    const { proxy } = setup({ a: { texts: ['A'] }, b: { texts: ['B'] }, c: { texts: ['C'] } });
    const mk = (k: string) => proxy.analyze({ original: blob(k), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 300 });
    const [a, b, c] = await Promise.all([mk('a'), mk('b'), mk('c')]);
    expect([a, b, c].map((r) => r.regions[0].source_text)).toEqual(['A', 'B', 'C']);
  });

  it('clean, annotate y readRegion funcionan a través del worker', async () => {
    const { proxy } = setup({ a: { texts: ['一'] } });
    const analysis = await proxy.analyze({ original: blob('a'), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 300 });
    expect(await (await proxy.clean(blob('a'), analysis.mask, analysis.regions)).text()).toBe('clean:a');
    expect(Array.from(await proxy.annotate(blob('a'), [[0, 0, 5, 5]]))).toEqual([0xff, 0xd8]);
    const r = await proxy.readRegion({ original: blob('a'), mask: null, bbox: [1, 2, 3, 4], lang: 'ja', sfx: 'keep', pageHeight: 300, regionId: 'rx', order: 0 });
    expect(r.id).toBe('rx');
    expect(r.bbox).toEqual([1, 2, 3, 4]);
  });

  it('detectLanguage pide las páginas de muestra al hilo principal solo cuando las necesita', async () => {
    const { proxy, vision } = setup({ a: { texts: ['一'] } });
    const loaded: number[] = [];
    const loaders = [0, 1, 2].map((i) => async () => { loaded.push(i); return blob('a'); });
    expect(await proxy.detectLanguage(loaders)).toBe('ja');
    expect(loaded.sort()).toEqual([0, 1, 2]);                            // FakeVision lee todas las muestras
    expect(vision.detectSample).toBe(3);
  });

  it('si una página de muestra no se puede leer, el error llega sin colgar el worker', async () => {
    const { proxy } = setup();
    await expect(proxy.detectLanguage([async () => { throw new Error('disco ilegible'); }])).rejects.toThrow('disco ilegible');
  });

  it('los errores de dominio llegan con su clase para que el procesador decida (modelo que falta, cancelación)', async () => {
    const vision = new FakeVision({});
    vision.analyze = async () => { throw new ModelMissingError('text-detector', 'Detector de texto'); };
    const proxy = new WorkerVision(() => new Loopback(() => vision as unknown as VisionServiceLike), config, async () => FLAGS);
    const err = await proxy.analyze({ original: blob('a'), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelMissingError);
    expect(err.message).toContain('Detector de texto');
    expect(err.details.model_id).toBe('text-detector');
    const other = reviveError(serializeError(new AppError('x_code', 'Mensaje claro', 418, { k: 1 })));
    expect(other).toBeInstanceOf(AppError);
    expect(other).toMatchObject({ code: 'x_code', status: 418, message: 'Mensaje claro' });
    expect(reviveError(serializeError(new CancelledError()))).toBeInstanceOf(CancelledError);
    expect(reviveError(serializeError(new TypeError('raro'))).message).toBe('raro');
  });

  it('cancelar cooperativamente: el worker corta y el procesador recibe CancelledError', async () => {
    const vision = new FakeVision({});
    vision.analyze = (async (_i: unknown, signal?: AbortSignal) => {
      for (let i = 0; i < 200; i++) { if (signal?.aborted) throw new CancelledError(); await sleep(5); }
      throw new Error('no se canceló');
    }) as never;
    const proxy = new WorkerVision(() => new Loopback(() => vision as unknown as VisionServiceLike), config, async () => FLAGS);
    const ctl = new AbortController();
    const p = proxy.analyze({ original: blob('a'), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 1 }, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it('si el worker no atiende la cancelación se descarta y la siguiente operación usa uno nuevo', async () => {
    const { proxy, workers } = setup({ a: { texts: ['一'] } }, { cancelGraceMs: 40 });
    const input = { original: blob('a'), lang: 'ja', direction: 'rtl' as const, sfx: 'keep' as const, pageHeight: 300 };
    await proxy.analyze(input);
    workers[0].hung = true;                                              // inferencia larga: no responde
    const ctl = new AbortController();
    const p = proxy.analyze(input, ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0].terminated).toBe(true);
    const res = await proxy.analyze(input);                              // otro worker, reconfigurado
    expect(res.regions).toHaveLength(1);
    expect(workers).toHaveLength(2);
    expect(workers[1].received[0].op).toBe('configure');
  });

  it('una operación ya cancelada ni siquiera se envía', async () => {
    const { proxy, workers } = setup();
    const ctl = new AbortController();
    ctl.abort();
    await expect(proxy.analyze({ original: blob('a'), lang: 'ja', direction: 'rtl', sfx: 'keep', pageHeight: 1 }, ctl.signal)).rejects.toBeInstanceOf(CancelledError);
    expect(workers[0].received.filter((m) => m.op === 'analyze')).toHaveLength(0);
  });

  it('si el worker se cae (memoria agotada) rechaza lo pendiente con un mensaje claro y se recupera', async () => {
    const { proxy, workers } = setup();
    const input = { original: blob('a'), lang: 'ja', direction: 'rtl' as const, sfx: 'keep' as const, pageHeight: 300 };
    await proxy.analyze(input);
    workers[0].hung = true;
    const p = proxy.analyze(input);
    await sleep(5);
    workers[0].crash('Out of memory');
    await expect(p).rejects.toThrow('Out of memory');
    expect((await proxy.analyze(input)).regions).toHaveLength(1);
    expect(workers).toHaveLength(2);
  });

  it('dispose termina el worker (la memoria de WebAssembly solo se libera así) y se puede volver a usar', async () => {
    const { proxy, workers } = setup();
    const input = { original: blob('a'), lang: 'ja', direction: 'rtl' as const, sfx: 'keep' as const, pageHeight: 300 };
    await proxy.analyze(input);
    await proxy.dispose();
    expect(workers[0].terminated).toBe(true);
    await proxy.analyze(input);
    expect(workers).toHaveLength(2);
  });
});

describe('modelos de visión leídos por URL en el worker', () => {
  const files: Record<string, string> = {
    'http://localhost/files/models/text-detector/comictextdetector.onnx': 'DET',
    'http://localhost/models/ppocr-rec.onnx': 'OCR',
    'http://localhost/files/models/manga-ocr/encoder_model.onnx': 'ENC',
    'http://localhost/files/models/manga-ocr/decoder_model.onnx': 'DEC',
    'http://localhost/files/models/manga-ocr/vocab.txt': 'a\nb',
    'http://localhost/files/models/manga-ocr/generation_config.json': '{"max_length":9}',
    'http://localhost/files/models/lama/lama_fp32.onnx': 'LAMA',
    'http://localhost/files/models/text-detector-manga/manga_det.onnx': 'LIGHT',
  };
  const fetcher = async (url: string) => (url in files ? new Response(files[url]) : new Response('no', { status: 404 }));
  const dec = (b: Uint8Array | null | undefined) => new TextDecoder().decode(b ?? new Uint8Array());

  it('entrega detector y OCR incluido; sin permiso no carga Manga OCR ni LaMa', async () => {
    const a = new UrlVisionAssets(config, () => FLAGS, fetcher);
    expect(dec(await a.detector())).toBe('DET');
    expect(dec(await a.ppocr())).toBe('OCR');
    expect(await a.hasMangaOcr()).toBe(false);
    expect(await a.mangaOcr()).toBeNull();
    expect(await a.lama()).toBeNull();
  });

  it('con Manga OCR y LaMa permitidos los lee completos', async () => {
    const a = new UrlVisionAssets(config, () => ({ ...FLAGS, manga: true, lama: true }), fetcher);
    const m = await a.mangaOcr();
    expect([dec(m?.encoder), dec(m?.decoder), m?.vocab, m?.generationConfig]).toEqual(['ENC', 'DEC', 'a\nb', '{"max_length":9}']);
    expect(dec(await a.lama())).toBe('LAMA');
  });

  it('con el detector experimental activado lee SU modelo y lo anuncia (entra en la clave de la caché)', async () => {
    const a = new UrlVisionAssets(config, () => ({ ...FLAGS, detectorKind: 'manga-det' }), fetcher);
    expect(dec(await a.detector())).toBe('LIGHT');
    expect(await a.detectorKind()).toBe('manga-det');
    const missing = new UrlVisionAssets(config, () => ({ ...FLAGS, detector: false, detectorKind: 'manga-det' }), fetcher);
    await expect(missing.detector()).rejects.toMatchObject({ details: { model_id: 'text-detector-manga' } });
  });

  it('sin el detector instalado falla con «falta el modelo», no con un error de red', async () => {
    const a = new UrlVisionAssets(config, () => ({ ...FLAGS, detector: false }), fetcher);
    await expect(a.detector()).rejects.toBeInstanceOf(ModelMissingError);
  });

  it('el OCR incluido se lee una sola vez y un fallo no se queda guardado', async () => {
    let calls = 0, fail = true;
    const f = async (u: string) => { calls += 1; return fail ? new Response('x', { status: 500 }) : fetcher(u); };
    const a = new UrlVisionAssets(config, () => FLAGS, f);
    await expect(a.ppocr()).rejects.toThrow('500');
    fail = false;
    expect(dec(await a.ppocr())).toBe('OCR');
    await a.ppocr();
    expect(calls).toBe(2);
  });
});
