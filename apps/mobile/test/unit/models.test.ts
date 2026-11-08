import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeviceCaps, Settings } from '@starblitz/shared';
import { CancelledError } from '../../src/engine/core/errors';
import { defaultSettings, mergeSettings } from '../../src/engine/core/settings';
import { LlmLibrary } from '../../src/engine/models/library';
import {
  FLAG_LEVELS, LlamaStartError, NativeLlmRuntime, llamaArgs, llamaThreads, type LlamaHost,
} from '../../src/engine/models/runtime';
import { DeviceVisionAssets, VISION_REGISTRY, VisionModelManager } from '../../src/engine/models/vision';
import { FakeDevice, sleep } from './helpers';
import { startFakeHf, type FakeHf } from './fakehf';
import { blob, NodeFiles, serveFiles, sha256 } from './nodefiles';

const PHONE: DeviceCaps = { ram_gb: 8, vram_gb: 0, gpu: '', cpu: 'arm64-v8a', threads: 8 };
const SMALL_PHONE: DeviceCaps = { ram_gb: 3, vram_gb: 0, gpu: '', cpu: 'arm64-v8a', threads: 8 };

describe('biblioteca de modelos de traducción (Hugging Face simulado)', () => {
  let files: NodeFiles, hf: FakeHf, lib: LlmLibrary;
  beforeEach(async () => { files = new NodeFiles(); hf = await startFakeHf(); lib = new LlmLibrary(files, { endpoint: hf.url, mobile: true }); });
  afterEach(async () => { files.dispose(); await hf.close(); });
  const base = { caps: PHONE, context: 8192 };

  it('busca y muestra la ficha con cada cuantización, troceados y proyector', async () => {
    const found = await lib.search('tiny', '');
    expect(found.map((r) => r.repo)).toEqual(['fake-org/Tiny-Qwen-GGUF']);
    expect(found[0].license_info.class).toBe('permissive');
    const info = await lib.inspect('fake-org/Tiny-Qwen-GGUF', '', PHONE, 8192);
    expect(info.files.map((f) => [f.path, f.quant, f.shards])).toEqual([
      ['Big-00001-of-00002.gguf', '', 2], ['Tiny-Q4_K_M.gguf', 'Q4_K_M', 1], ['Tiny-Q8_0.gguf', 'Q8_0', 1],
    ]);
    expect(info.files.find((f) => f.path.startsWith('Big'))!.size).toBe(230_000);
    expect(info.mmproj_suggested?.path).toBe('mmproj-F16.gguf');
    expect(info.files.every((f) => f.fit.fits !== 'gpu' && f.fit.fits !== 'hybrid')).toBe(true); // en un teléfono nunca se asume GPU
  });

  it('instala (con troceado y proyector), lista y elimina', async () => {
    const seen: number[] = [];
    const m = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Big-00001-of-00002.gguf', { ...base, mmproj: 'mmproj-F16.gguf', progress: (p) => seen.push(p) });
    expect(m.files).toEqual(['Big-00001-of-00002.gguf', 'Big-00002-of-00002.gguf']);
    expect(m.size).toBe(120_000 + 110_000 + 80_000);
    expect(m.source).toBe('custom');
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((p, i) => i === 0 || p >= seen[i - 1])).toBe(true);
    const [one] = await lib.installed();
    expect(one.vision).toBe(true);
    expect(one.license_info.class).toBe('permissive');
    expect(await lib.modelPath(m.id)).toContain('Big-00001-of-00002.gguf');
    expect(await lib.diskUsage()).toBe(m.size);
    await lib.remove(m.id);
    expect(await lib.installed()).toEqual([]);
    await expect(lib.remove(m.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(lib.remove('../x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('bloquea lo que no cabe en el teléfono salvo que se fuerce, y no descarga nada', async () => {
    const err = await lib.install('fake-org/Huge-GGUF', 'Huge-Q4_K_M.gguf', base).catch((e) => e);
    expect(err.code).toBe('incompatible');
    expect(hf.requests.filter((r) => r.kind === 'resolve')).toHaveLength(0);
    // Un teléfono de 3 GB tampoco puede con el modelo pequeño (descontada la memoria del sistema), salvo que la persona fuerce la instalación.
    const small = { ...base, caps: SMALL_PHONE };
    expect(await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', small).catch((e) => e.code)).toBe('incompatible');
    const forced = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', { ...small, force: true });
    expect(forced.id).toBe('tiny-qwen-gguf-tiny-q4-k-m');
  });

  it('comprueba el espacio libre antes de descargar', async () => {
    files.free = 10_000;
    const err = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', base).catch((e) => e);
    expect(err.code).toBe('disk_full');
    expect(hf.requests.filter((r) => r.kind === 'resolve')).toHaveLength(0);
  });

  it('un repositorio restringido pide token y el token solo viaja a Hugging Face', async () => {
    expect(await lib.install('fake-org/Gated-GGUF', 'Gated-Q4_0.gguf', base).catch((e) => e.code)).toBe('auth_required');
    const m = await lib.install('fake-org/Gated-GGUF', 'Gated-Q4_0.gguf', { ...base, token: 'good' });
    expect(m.license).toBe('gemma');
    expect(hf.requests.find((r) => r.kind === 'resolve')!.auth).toBe('Bearer good');
  });

  it('valida los nombres de repositorio y de archivo', async () => {
    for (const bad of ['no-es-repo', '../../etc/passwd', 'a/b/c']) expect(await lib.inspect(bad, '', PHONE, 4096).catch((e) => e.code)).toBe('invalid_repo');
    expect(await lib.install('fake-org/Tiny-Qwen-GGUF', '../secreto.gguf', base).catch((e) => e.code)).toBe('invalid_file');
    expect(await lib.install('fake-org/Tiny-Qwen-GGUF', 'README.md', base).catch((e) => e.code)).toBe('not_gguf');
    expect(await lib.inspect('fake-org/No-Existe', '', PHONE, 4096).catch((e) => e.code)).toBe('not_found');
  });

  it('se recupera de un corte de conexión y rechaza un archivo corrupto sin dejar un modelo a medias', async () => {
    hf.failOnce.add('Tiny-Q4_K_M.gguf');
    const ok = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', base);
    expect(sha256(await files.readBytes(`llm/${ok.id}/Tiny-Q4_K_M.gguf`))).toBe(sha256(blob('q4', 300_000)));
    expect(hf.requests.some((r) => r.kind === 'resolve' && r.range.startsWith('bytes='))).toBe(true);
    await lib.remove(ok.id);

    hf.corrupt.add('Tiny-Q8_0.gguf');
    expect(await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf', base).catch((e) => e.code)).toBe('integrity');
    expect(await lib.installed()).toEqual([]);
  });

  it('cancelar la descarga conserva lo descargado, no deja un modelo instalado y la siguiente continúa', async () => {
    const ctrl = new AbortController();
    const err = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf', { ...base, signal: ctrl.signal, progress: (p) => { if (p > 0.1) ctrl.abort(); } }).catch((e) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect(await lib.installed()).toEqual([]);
    expect(lib.installing()).toEqual([]);
    const m = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf', base);
    expect(m.quant).toBe('Q8_0');
  });

  it('pausar corta la transferencia y al reanudar continúa con Range', async () => {
    let paused = false;
    let release: (() => void) | null = null;
    const wait = () => (paused ? new Promise<void>((r) => { release = r; }) : Promise.resolve());
    const job = lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf', {
      ...base, isPaused: () => paused, waitIfPaused: wait, progress: (p) => { if (p > 0.1 && !paused && !release) paused = true; },
    });
    for (let i = 0; i < 200 && !release; i++) await sleep(10);
    expect(release).not.toBeNull();
    expect(await lib.installed()).toEqual([]);
    paused = false;
    release!();
    const m = await job;
    expect(sha256(await files.readBytes(`llm/${m.id}/Tiny-Q8_0.gguf`))).toBe(sha256(blob('q8', 500_000)));
    expect(hf.requests.some((r) => r.kind === 'resolve' && r.range.startsWith('bytes='))).toBe(true);
  });

  it('no permite dos descargas del mismo modelo a la vez', async () => {
    const a = lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', base);
    const b = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', base).catch((e) => e);
    expect(b.code).toBe('busy');
    await a;
  });

  it('ignora manifiestos dañados y modelos con archivos que faltan', async () => {
    const m = await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', base);
    await files.writeText('llm/roto-uno/manifest.json', '{no es json');
    await files.remove(`llm/${m.id}/Tiny-Q4_K_M.gguf`);
    expect(await lib.installed()).toEqual([]);
  });
});

describe('modelos de visión', () => {
  let files: NodeFiles, http: Awaited<ReturnType<typeof serveFiles>>;
  const content: Record<string, Buffer> = {};
  const pinned = VISION_REGISTRY.map((s) => ({ ...s, files: s.files.map((f) => ({ ...f })) }));
  beforeEach(async () => {
    files = new NodeFiles();
    for (const s of VISION_REGISTRY) for (const f of s.files) content[`/${s.id}/${f.rel}`] = blob(s.id + f.rel, 5000);
    http = await serveFiles(content);
  });
  afterEach(async () => { files.dispose(); await http.close(); });

  it('el registro de Android es el mismo que el de Python (JSON exportado)', () => {
    expect(VISION_REGISTRY.map((s) => s.id)).toEqual(['text-detector', 'manga-ocr', 'lama']);
    expect(VISION_REGISTRY.find((s) => s.id === 'text-detector')!.files[0].sha256).toBe('1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f');
    expect(pinned).toEqual(VISION_REGISTRY);
  });

  it('instala con verificación y los modelos opcionales quedan disponibles para el motor de visión', async () => {
    // El registro real trae huellas SHA-256 de los archivos de verdad: aquí se sustituyen por las del contenido de prueba.
    const spec = VISION_REGISTRY.find((s) => s.id === 'lama')!;
    spec.files[0].sha256 = sha256(content['/lama/lama_fp32.onnx']);
    const mgr = new VisionModelManager(files, { mapUrl: (u) => `${http.url}/${spec.id}/${u.split('/').pop()}` });
    expect((await mgr.status()).find((s) => s.id === 'lama')).toMatchObject({ installed: false, downloading: false, offline: true });
    const progress: number[] = [];
    await mgr.install('lama', { progress: (p) => progress.push(p) });
    expect(progress.at(-1)).toBe(1);
    expect((await mgr.status()).find((s) => s.id === 'lama')!.installed).toBe(true);
    const assets = new DeviceVisionAssets(mgr, async () => new Uint8Array([1, 2, 3]));
    expect(await assets.lama()).toEqual(new Uint8Array(content['/lama/lama_fp32.onnx']));
    expect(await assets.hasMangaOcr()).toBe(false);
    expect(await assets.mangaOcr()).toBeNull();
    expect(await assets.ppocr('ja')).toEqual(new Uint8Array([1, 2, 3]));
    await expect(assets.detector()).rejects.toMatchObject({ code: 'model_missing' });
    await mgr.remove('lama');
    expect(await assets.lama()).toBeNull();
    expect(await mgr.remove('nada').catch((e) => e.code)).toBe('not_found');
  });

  it('el perfil del dispositivo puede desactivar Manga OCR aunque esté instalado', async () => {
    const mgr = new VisionModelManager(files);
    for (const f of VISION_REGISTRY.find((s) => s.id === 'manga-ocr')!.files) await files.writeText(`models/manga-ocr/${f.rel}`, 'x');
    let allowed = false;
    const assets = new DeviceVisionAssets(mgr, async () => new Uint8Array(), async () => allowed);
    expect(await assets.hasMangaOcr()).toBe(false);
    allowed = true;
    expect(await assets.hasMangaOcr()).toBe(true);
  });

  it('no empieza si no hay espacio', async () => {
    files.free = 1000;
    const mgr = new VisionModelManager(files);
    expect(await mgr.install('text-detector').catch((e) => e.code)).toBe('disk_full');
  });
});

class FakeHost implements LlamaHost {
  running = false;
  starts: { model: string; args: string[] }[] = [];
  stops = 0;
  rejectFlags: string[] = [];
  delay = 0;
  hasBinary = true;
  async available() { return this.hasBinary; }
  async start(o: { model: string; args: string[]; signal?: AbortSignal }) {
    this.starts.push({ model: o.model, args: o.args });
    if (this.delay) await sleep(this.delay);
    if (o.signal?.aborted) throw new LlamaStartError('cancelled', 'cancelado');
    const bad = o.args.find((a) => this.rejectFlags.includes(a));
    if (bad) throw new LlamaStartError('exited', 'salió', [`error: invalid argument: ${bad}`]);
    this.running = true;
    return { baseUrl: 'http://127.0.0.1:5555', pid: 100 + this.starts.length };
  }
  async stop() { this.running = false; this.stops += 1; }
  async isRunning() { return this.running; }
  async logTail() { return ['listo']; }
}

describe('motor de lenguaje del teléfono (llama-server)', () => {
  let files: NodeFiles, hf: FakeHf, lib: LlmLibrary, host: FakeHost, settings: Settings, rt: NativeLlmRuntime, clock: number, caps: DeviceCaps;
  const MODEL = 'tiny-qwen-gguf-tiny-q4-k-m';
  beforeEach(async () => {
    files = new NodeFiles(); hf = await startFakeHf(); lib = new LlmLibrary(files, { endpoint: hf.url });
    host = new FakeHost(); settings = defaultSettings(); clock = 1_000_000; caps = PHONE;
    await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf', { caps: PHONE, context: 8192, mmproj: 'mmproj-F16.gguf' });
    const device = new FakeDevice(); device.caps = async () => caps;
    rt = new NativeLlmRuntime({ host, library: lib, settings: () => settings, device, now: () => clock, watchMs: 0 });
  });
  afterEach(async () => { await rt.dispose(); files.dispose(); await hf.close(); });

  it('arranca bajo demanda, reutiliza el proceso y usa una petición simple de CORS (sin clave)', async () => {
    const a = await rt.acquire(MODEL);
    expect(a).toMatchObject({ baseUrl: 'http://127.0.0.1:5555', apiKey: '', contentType: 'text/plain' });
    a.release();
    (await rt.acquire(MODEL)).release();
    expect(host.starts).toHaveLength(1);
    const args = host.starts[0].args;
    expect(args).toEqual(expect.arrayContaining(['--parallel', '1', '--jinja', '--no-webui', '-ngl', '0']));
    expect(args[args.indexOf('-c') + 1]).toBe('6144'); // perfil «mid» (8 GB de RAM): contexto acotado por el perfil
    expect(args).not.toContain('--mmproj'); // los teléfonos traducen solo con texto: la imagen cuesta memoria
    expect(host.starts[0].model).toContain('Tiny-Q4_K_M.gguf');
    const st = await rt.status();
    expect(st).toMatchObject({ available: true, running: true, model: MODEL });
  });

  it('el proyector de imágenes solo se carga si el perfil y los ajustes lo permiten', async () => {
    settings = mergeSettings(settings, { processing: { profile: 'pc-gpu' } }); // perfil con visión en el modelo de lenguaje
    (await rt.acquire(MODEL)).release();
    expect(host.starts[0].args).toContain('--mmproj');
    expect(host.starts[0].args[host.starts[0].args.indexOf('-c') + 1]).toBe('12288');
    await rt.unload();
    settings = mergeSettings(settings, { llm: { use_vision: false } });
    (await rt.acquire(MODEL)).release();
    expect(host.starts[1].args).not.toContain('--mmproj');
  });

  it('reintenta con menos opciones si la versión incluida no conoce alguna', async () => {
    host.rejectFlags = ['--reasoning-budget'];
    (await rt.acquire(MODEL)).release();
    expect(host.starts.map((s) => s.args.includes('--no-webui'))).toEqual([true, false]);
    expect((await rt.status()).flags).toEqual(['--parallel', '--jinja']);
  });

  it('informa con claridad cuando no arranca de ninguna manera', async () => {
    host.rejectFlags = ['-c'];
    const err = await rt.acquire(MODEL).catch((e) => e);
    expect(err.code).toBe('llm_unavailable');
    expect(err.message).toContain('invalid argument: -c');
    expect(host.starts).toHaveLength(FLAG_LEVELS.length);
  });

  it('sin el servidor para esta arquitectura o sin modelo lo dice', async () => {
    host.hasBinary = false;
    expect(await rt.ready()).toBe(false);
    expect((await rt.acquire(MODEL).catch((e) => e)).message).toContain('arquitectura');
    host.hasBinary = true;
    expect((await rt.acquire('otro-modelo').catch((e) => e)).message).toContain('No hay un modelo');
  });

  it('un modelo que no cabe en la memoria no se intenta cargar', async () => {
    caps = { ...PHONE, ram_gb: 2 };
    const err = await rt.acquire(MODEL).catch((e) => e);
    expect(err.message).toContain('no cabe');
    expect(host.starts).toHaveLength(0);
  });

  it('cambiar de modelo reinicia el servidor', async () => {
    await lib.install('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf', { caps: PHONE, context: 8192 });
    (await rt.acquire(MODEL)).release();
    (await rt.acquire('tiny-qwen-gguf-tiny-q8-0')).release();
    expect(host.starts.map((s) => s.model.split('/').pop())).toEqual(['Tiny-Q4_K_M.gguf', 'Tiny-Q8_0.gguf']);
  });

  it('si el sistema cierra el servidor por falta de memoria, vuelve a iniciarse', async () => {
    (await rt.acquire(MODEL)).release();
    host.running = false;
    (await rt.acquire(MODEL)).release();
    expect(host.starts).toHaveLength(2);
  });

  it('descarga el modelo por inactividad, pero nunca mientras hay una petición en curso', async () => {
    const rt2 = new NativeLlmRuntime({ host, library: lib, settings: () => settings, device: new FakeDevice(), now: () => clock, watchMs: 5 });
    settings = mergeSettings(settings, { llm: { idle_unload_minutes: 1 } });
    const lease = await rt2.acquire(MODEL);
    clock += 120_000;
    await sleep(30);
    expect(host.running).toBe(true); // petición en curso
    lease.release();
    clock += 120_000;
    for (let i = 0; i < 50 && host.running; i++) await sleep(10);
    expect(host.running).toBe(false);
    expect((await rt2.status()).running).toBe(false);
    await rt2.dispose();
  });

  it('cancelar a mitad del arranque lo detiene', async () => {
    host.delay = 50;
    const ctrl = new AbortController();
    const p = rt.acquire(MODEL, ctrl.signal).catch((e) => e);
    await sleep(10);
    ctrl.abort();
    expect(await p).toBeInstanceOf(CancelledError);
    expect(host.running).toBe(false);
  });

  it('opciones y reparto de hilos', () => {
    expect(llamaArgs({ ctx: 4096, threads: 4, gpuLayers: null, mmproj: '/m.gguf', level: 'bare' })).toEqual(['-c', '4096', '--parallel', '1', '-t', '4']);
    expect(llamaArgs({ ctx: 4096, threads: 4, gpuLayers: 0, mmproj: '/m.gguf', level: 'full' })).toEqual(
      ['-c', '4096', '--parallel', '1', '-t', '4', '-ngl', '0', '--jinja', '--no-webui', '--reasoning-budget', '0', '--mmproj', '/m.gguf']);
    expect([2, 4, 6, 8, 12].map((threads) => llamaThreads({ threads }))).toEqual([2, 2, 4, 5, 6]);
  });
});
