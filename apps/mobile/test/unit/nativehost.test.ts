import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from '../../src/engine/core/settings';
import { AndroidDevice } from '../../src/engine/host/androidDevice';
import { computeVisionFlags } from '../../src/engine/host/flags';
import { mapNativeError, NativeFiles } from '../../src/engine/host/nativeFiles';
import { NativeLlamaHost } from '../../src/engine/host/nativeLlamaHost';
import { WakeController } from '../../src/engine/host/wake';
import { CancelledError } from '../../src/engine/core/errors';
import { LlamaStartError } from '../../src/engine/models/runtime';
import { OK_STATUS, FakeNative, NativeFail } from './fakenative';
import type { Job } from '@starblitz/shared';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 13) % 251);

let native: FakeNative;
let files: NativeFiles;
beforeEach(() => {
  native = new FakeNative();
  files = new NativeFiles(native, { convertFileSrc: (p) => `http://localhost/_capacitor_file_${p}` });
});
afterEach(() => native.dispose());

describe('NativeFiles (contrato con el plugin nativo)', () => {
  it('escribe, lee, lista, mide y borra archivos de texto dentro de la carpeta privada', async () => {
    await files.writeText('llm/index.json', '{"a":1}');
    expect(await files.readText('llm/index.json')).toBe('{"a":1}');
    expect(await files.readText('llm/nada.json')).toBeUndefined();
    expect(await files.stat('llm/index.json')).toEqual({ exists: true, isDir: false, size: 7 });
    expect((await files.list('llm')).map((e) => e.name)).toEqual(['index.json']);
    await files.remove('llm');
    expect((await files.stat('llm')).exists).toBe(false);
  });

  it('rechaza rutas que se salen de la carpeta antes de llegar al plugin', async () => {
    for (const bad of ['../fuera', '/etc/passwd', 'a/../../b', 'a\\b', '']) {
      await expect(files.stat(bad)).rejects.toThrow();
    }
    expect(native.downloads).toHaveLength(0);
  });

  it('descarga con progreso, verifica tamaño y huella y deja el archivo con ruta absoluta para llama-server', async () => {
    const data = bytes(40_000);
    native.served.set('https://hf.test/model.gguf', data);
    const seen: number[] = [];
    await files.download({ url: 'https://hf.test/model.gguf', path: 'llm/m/model.gguf', expectedSize: data.length, sha256: sha(data) }, { onProgress: (d) => seen.push(d) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(data.length);
    expect(await files.sha256('llm/m/model.gguf')).toBe(sha(data));
    expect(await files.absolutePath('llm/m/model.gguf')).toBe(native.abs('llm/m/model.gguf'));
  });

  it('una huella que no coincide se informa como integridad y no deja el archivo', async () => {
    native.served.set('https://hf.test/x.gguf', bytes(1000));
    const err = await files.download({ url: 'https://hf.test/x.gguf', path: 'llm/x.gguf', sha256: 'f'.repeat(64) }).catch((e) => e);
    expect(err.code).toBe('integrity');
    expect((await files.stat('llm/x.gguf')).exists).toBe(false);
  });

  it('cancelar la descarga avisa al plugin y devuelve CancelledError', async () => {
    native.served.set('https://hf.test/big.gguf', bytes(200_000));
    const ctl = new AbortController();
    const p = files.download({ url: 'https://hf.test/big.gguf', path: 'llm/big.gguf' }, { signal: ctl.signal, onProgress: () => ctl.abort() });
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(native.cancelled).toHaveLength(1);
  });

  it('una señal ya cancelada ni siquiera inicia la descarga', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(files.download({ url: 'https://hf.test/a', path: 'a.bin' }, { signal: ctl.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(native.downloads).toHaveLength(0);
  });

  it('solo se permiten descargas cifradas', async () => {
    const err = await files.download({ url: 'http://evil.test/m.gguf', path: 'llm/m.gguf' }).catch((e) => e);
    expect(err.code).toBe('insecure');
  });

  it('lee los modelos por la URL que sirve la app, sin pasar sus bytes por el puente', async () => {
    const urls: string[] = [];
    const reader = new NativeFiles(native, { convertFileSrc: (p) => `http://localhost/f${p}`, fetcher: async (u) => { urls.push(u); return new Response(bytes(10)); } });
    await native.fsWriteText({ path: 'models/a/b.onnx', text: 'x' });
    expect(await reader.readBytes('models/a/b.onnx')).toHaveLength(10);
    expect(urls[0]).toBe(`http://localhost/f${native.abs('models/a/b.onnx')}`);
  });

  it('traduce cada código del plugin a un error de dominio con mensaje claro', () => {
    expect(mapNativeError(new NativeFail('disk_full'), 'a').message).toMatch(/espacio/);
    expect(mapNativeError(new NativeFail('auth_required'), 'a')).toMatchObject({ status: 403 });
    expect(mapNativeError(new NativeFail('not_found'), 'a')).toMatchObject({ status: 404 });
    expect(mapNativeError(new NativeFail('busy'), 'a').message).toMatch(/descargando/);
    expect(mapNativeError(new NativeFail('cancelled'), 'a')).toBeInstanceOf(CancelledError);
  });
});

describe('NativeLlamaHost', () => {
  it('arranca llama-server con el tiempo máximo configurado y devuelve su dirección local', async () => {
    const host = new NativeLlamaHost(native, 90_000);
    expect(await host.available()).toBe(true);
    const r = await host.start({ model: 'llm/m/model.gguf', args: ['-c', '4096'] });
    expect(r).toEqual({ baseUrl: 'http://127.0.0.1:43210', pid: 4242 });
    expect(native.llamaState.starts[0]).toMatchObject({ model: 'llm/m/model.gguf', timeoutMs: 90_000 });
    expect(await host.isRunning()).toBe(true);
    await host.stop();
    expect(await host.isRunning()).toBe(false);
  });

  it('sin llama-server para esta arquitectura se informa como no disponible (y se recuerda)', async () => {
    native.llamaPresent = false;
    const host = new NativeLlamaHost(native);
    expect(await host.available()).toBe(false);
    native.llamaPresent = true;
    expect(await host.available()).toBe(false);
  });

  it('un fallo de arranque conserva el motivo y el registro para mostrarlo', async () => {
    native.llamaFail = new NativeFail('exited', 'El proceso terminó', { log: ['error: out of memory'] });
    const err = await new NativeLlamaHost(native).start({ model: 'm', args: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlamaStartError);
    expect(err).toMatchObject({ reason: 'exited', log: ['error: out of memory'] });
    native.llamaFail = new NativeFail('timeout');
    expect(await new NativeLlamaHost(native).start({ model: 'm', args: [] }).catch((e) => e)).toMatchObject({ reason: 'timeout' });
  });

  it('cancelar durante el arranque detiene el proceso', async () => {
    const ctl = new AbortController();
    const host = new NativeLlamaHost(native);
    ctl.abort();
    await expect(host.start({ model: 'm', args: [], signal: ctl.signal })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(native.llamaState.starts).toHaveLength(0);
  });

  it('devuelve la cola del registro del motor', async () => {
    native.llamaState.log = ['a', 'b', 'c'];
    expect(await new NativeLlamaHost(native).logTail(2)).toEqual(['b', 'c']);
  });
});

describe('AndroidDevice', () => {
  it('describe el teléfono y calcula las capacidades para elegir perfil y modelo', async () => {
    const dev = new AndroidDevice(native);
    expect(dev.mobile).toBe(true);
    const caps = await dev.caps();
    expect(caps).toMatchObject({ ram_gb: 8, vram_gb: 0, cpu: 'arm64', threads: 8 });
    const info = await dev.info();
    expect(info).toMatchObject({ os: 'Android 14', cores: 8, ram_mb: 8192, free_bytes: native.free });
  });

  it('si el sistema no responde asume un teléfono modesto en lugar de fallar', async () => {
    native.deviceInfo = async () => { throw new Error('no disponible'); };
    const caps = await new AndroidDevice(native).caps();
    expect(caps.ram_gb).toBe(4);
  });

  it('estado en vivo: devuelve null si no se puede leer y expone el espacio libre', async () => {
    const dev = new AndroidDevice(native);
    expect(await dev.status()).toEqual(OK_STATUS);
    native.status = new Error('sin permiso');
    expect(await dev.status()).toBeNull();
    expect(await dev.freeBytes()).toBe(native.free);
  });

  it('mantener la pantalla encendida nunca lanza error', async () => {
    native.keepAwake = async () => { throw new Error('x'); };
    await expect(new AndroidDevice(native).keepAwake(true)).resolves.toBeUndefined();
  });
});

describe('computeVisionFlags (qué modelos opcionales usa el procesamiento)', () => {
  const caps = (ram_gb: number) => ({ ram_gb, vram_gb: 0, gpu: '', cpu: 'arm64', threads: 8 });
  const models = (installed: string[]) => ({ isInstalled: async (id: string) => installed.includes(id) });
  const all = ['text-detector', 'manga-ocr', 'lama'];

  it('un teléfono potente con todo instalado usa Manga OCR; LaMa solo si la persona lo pide (igual que en el PC sin GPU)', async () => {
    const auto = await computeVisionFlags({ models: models(all), settings: defaultSettings(), caps: caps(12), mobile: true });
    expect(auto).toMatchObject({ detector: true, manga: true, lama: false, inpaintMode: 'fast' });
    const asked = mergeSettings(defaultSettings(), { processing: { inpaint: 'lama' } });
    expect(await computeVisionFlags({ models: models(all), settings: asked, caps: caps(12), mobile: true })).toMatchObject({ lama: true, inpaintMode: 'lama' });
  });

  it('un teléfono modesto no usa los modelos pesados aunque estén instalados', async () => {
    const f = await computeVisionFlags({ models: models(all), settings: defaultSettings(), caps: caps(3), mobile: true });
    expect(f.detector).toBe(true);
    expect(f.manga).toBe(false);
    expect(f.lama).toBe(false);
    expect(f.inpaintMode).toBe('fast');
  });

  it('el modo fijado en Ajustes manda sobre el perfil, y LaMa solo cuenta si está instalado', async () => {
    const fast = mergeSettings(defaultSettings(), { processing: { inpaint: 'fast' } });
    expect((await computeVisionFlags({ models: models(all), settings: fast, caps: caps(12), mobile: true })).lama).toBe(false);
    const lama = mergeSettings(defaultSettings(), { processing: { inpaint: 'lama' } });
    const f = await computeVisionFlags({ models: models(['text-detector']), settings: lama, caps: caps(12), mobile: true });
    expect(f).toMatchObject({ lama: false, inpaintMode: 'lama' });
  });

  it('sin el detector instalado lo indica para que el procesamiento pida descargarlo', async () => {
    expect((await computeVisionFlags({ models: models([]), settings: defaultSettings(), caps: caps(8), mobile: true })).detector).toBe(false);
  });

  it('detector EXPERIMENTAL: solo si se activa; si falta su modelo lo dice (no cambia de detector en silencio)', async () => {
    const def = await computeVisionFlags({ models: models([...all, 'text-detector-manga']), settings: defaultSettings(), caps: caps(8), mobile: true });
    expect(def).toMatchObject({ detectorKind: 'default', detector: true });          // por defecto, el de siempre aunque el ligero esté instalado
    const light = { ...defaultSettings(), processing: { ...defaultSettings().processing, detector: 'manga-det' as const } };
    expect(await computeVisionFlags({ models: models([...all, 'text-detector-manga']), settings: light, caps: caps(8), mobile: true }))
      .toMatchObject({ detectorKind: 'manga-det', detector: true });
    expect(await computeVisionFlags({ models: models(all), settings: light, caps: caps(8), mobile: true }))
      .toMatchObject({ detectorKind: 'manga-det', detector: false });               // pedido pero sin instalar → «falta el modelo»
  });
});

describe('WakeController (pantalla encendida solo mientras se trabaja)', () => {
  const job = (id: string, status: Job['status']) => ({ type: 'job' as const, job: { id, status } as Job });

  it('enciende con la primera tarea en marcha y apaga cuando ya no queda ninguna', () => {
    const calls: boolean[] = [];
    const w = new WakeController((on) => { calls.push(on); });
    w.onEvent(job('a', 'running'));
    w.onEvent(job('b', 'running'));
    w.onEvent(job('a', 'done'));
    expect(calls).toEqual([true]);
    w.onEvent(job('b', 'paused'));
    expect(calls).toEqual([true, false]);
  });

  it('ignora eventos que no son de tareas, no repite avisos y libera al cerrar', () => {
    const calls: boolean[] = [];
    const w = new WakeController((on) => { calls.push(on); });
    w.onEvent({ type: 'page', project_id: 'p', page_id: 'g', state: 'done', error: '' });
    w.onEvent(job('a', 'running'));
    w.onEvent(job('a', 'running'));
    w.release();
    expect(calls).toEqual([true, false]);
  });

  it('un fallo al cambiar la pantalla no rompe el procesamiento', () => {
    const w = new WakeController(() => { throw new Error('x'); });
    expect(() => { w.onEvent(job('a', 'running')); }).not.toThrow();
  });
});
