import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, CancelledError } from '../../src/engine/core/errors';
import { safePath } from '../../src/engine/platform/files';
import { Sha256, sha256Hex } from '../../src/engine/platform/sha256';
import { blob, NodeFiles, serveFiles, sha256, type HttpFixture } from './nodefiles';

describe('SHA-256 incremental', () => {
  it('coincide con la referencia para cualquier tamaño y troceado', () => {
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
      const data = blob('x' + size, size);
      expect(sha256Hex(data)).toBe(sha256(data));
      // Troceado irregular
      const s = new Sha256();
      for (let i = 0; i < data.length; i += 37) s.update(data.subarray(i, i + 37));
      expect(s.hex()).toBe(sha256(data));
    }
  });
  it('vectores conocidos', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('rutas seguras', () => {
  it('rechaza escapes y caracteres peligrosos', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', 'a/b/..', 'a//..', 'a/$(x)', 'a\\b']) expect(() => safePath(bad), bad).toThrow();
    expect(safePath('llm/qwen3.5-4b/model.gguf')).toBe('llm/qwen3.5-4b/model.gguf');
    expect(safePath('./models//x.onnx')).toBe('models/x.onnx');
  });
});

describe('descarga reanudable', () => {
  let files: NodeFiles, http: HttpFixture;
  const data = blob('modelo', 600_000);
  beforeEach(async () => { files = new NodeFiles(); http = await serveFiles({ '/m.bin': data }); });
  afterEach(async () => { files.dispose(); await http.close(); });

  const req = (over = {}) => ({ url: `${http.url}/m.bin`, path: 'models/a/m.bin', expectedSize: data.length, sha256: sha256(data), ...over });

  it('descarga, verifica y deja el archivo con su nombre final', async () => {
    const seen: number[] = [];
    await files.download(req(), { onProgress: (d) => seen.push(d) });
    expect(sha256(await files.readBytes('models/a/m.bin'))).toBe(sha256(data));
    expect((await files.stat('models/a/m.bin.part')).exists).toBe(false);
    expect(seen.at(-1)).toBe(data.length);
  });

  it('continúa con Range tras un corte de conexión', async () => {
    http.failOnce.add('/m.bin');
    await files.download(req());
    expect(sha256(await files.readBytes('models/a/m.bin'))).toBe(sha256(data));
    expect(http.requests.some((r) => r.range.startsWith('bytes='))).toBe(true);
  });

  it('una descarga cancelada deja el .part y la siguiente continúa donde se quedó', async () => {
    const ctrl = new AbortController();
    await expect(files.download(req(), { signal: ctrl.signal, onProgress: (d) => { if (d > 0) ctrl.abort(); } })).rejects.toBeInstanceOf(CancelledError);
    const partial = await files.size('models/a/m.bin.part');
    expect(partial).toBeGreaterThan(0);
    expect((await files.stat('models/a/m.bin')).exists).toBe(false);
    http.requests.length = 0;
    await files.download(req());
    expect(http.requests[0].range).toBe(`bytes=${partial}-`);
    expect(sha256(await files.readBytes('models/a/m.bin'))).toBe(sha256(data));
  });

  it('detecta contenido corrupto, borra el archivo y avisa', async () => {
    http.corrupt.add('/m.bin');
    const err = await files.download(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('integrity');
    expect((await files.stat('models/a/m.bin')).exists).toBe(false);
    expect((await files.stat('models/a/m.bin.part')).exists).toBe(false);
  });

  it('un archivo completo y verificado no se vuelve a descargar', async () => {
    await files.download(req());
    http.requests.length = 0;
    await files.download(req());
    expect(http.requests).toHaveLength(0);
  });

  it('un archivo con el tamaño correcto pero corrupto se descarga de nuevo', async () => {
    await files.writeText('models/a/m.bin', 'x'.repeat(data.length));
    await files.download(req());
    expect(sha256(await files.readBytes('models/a/m.bin'))).toBe(sha256(data));
  });

  it('distingue repositorios restringidos y archivos que ya no existen', async () => {
    http.needsToken.set('/m.bin', 'tok');
    expect(await files.download(req()).catch((e) => e.code)).toBe('auth_required');
    await files.download(req({ headers: { Authorization: 'Bearer tok' } }));
    expect(await files.download(req({ url: `${http.url}/nada`, path: 'models/a/n.bin', sha256: null })).catch((e) => e.code)).toBe('not_found');
  });

  it('si el servidor ignora Range (200) empieza de cero sin duplicar bytes', async () => {
    await files.writeText('models/a/m.bin.part', 'basura');
    http.ignoreRange.add('/m.bin');
    await files.download(req());
    expect(sha256(await files.readBytes('models/a/m.bin'))).toBe(sha256(data));
  });
});
