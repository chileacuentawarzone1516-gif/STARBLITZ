import { describe, expect, it } from 'vitest';
import cases from './fixtures/llm_cases.json';
import {
  CATALOG, HuggingFace, advise, classify, describeRepo, estimateMemoryGb, fitModel, licenseInfo, modelId, pickDefault, quantOf,
  resolveModel, shardsOf, validatePath, validateRepo,
} from '../src';
import type { DeviceCaps, InstalledModel } from '../src';

// Paridad con Python: los casos los calcula `engine/.../llm/catalog.py` (tools/export_llm_catalog.py).
describe('paridad con el catálogo de Python', () => {
  it('classify', () => {
    for (const c of cases.classify) expect(classify(c.ram, c.vram, c.mobile), JSON.stringify(c)).toBe(c.out);
  });
  it('pick_default', () => {
    for (const c of cases.pick_default) expect(pickDefault(c.tier as 'low', c.vram), JSON.stringify(c)).toBe(c.out);
  });
  it('estimate_memory_gb', () => {
    for (const c of cases.estimate) expect(estimateMemoryGb(c.size, c.params, c.ctx, c.mm, c.arch)).toBeCloseTo(c.out, 9);
  });
  it('fit_model', () => {
    for (const c of cases.fit) {
      const got = fitModel(c.need, c.ram, c.vram, c.mobile);
      const want = c.out;
      expect({ ...got, need_gb: undefined, note: undefined }, JSON.stringify(c)).toEqual({ ...want, need_gb: undefined, note: undefined });
      expect(Math.abs(got.need_gb - want.need_gb)).toBeLessThan(0.11);
      expect(got.note.replace(/\d+\.\d/g, 'N')).toBe(want.note.replace(/\d+\.\d/g, 'N'));
    }
  });
  it('license_info', () => {
    for (const c of cases.license) expect(licenseInfo(c.id), c.id).toEqual(c.out);
  });
});

const PHONE = (ram: number): DeviceCaps => ({ ram_gb: ram, vram_gb: 0, gpu: '', cpu: 'arm64', threads: 8 });

describe('asesor de modelos del teléfono', () => {
  it('elige el perfil por la RAM y recomienda un modelo que cabe', () => {
    const low = advise(PHONE(5), [], '', 'auto', true);
    expect(low.profile.id).toBe('low');
    expect(low.recommended).toBe('qwen3.5-2b-q4km');
    expect(low.options.find((o) => o.recommended)!.fit.fits).toBe('cpu');
    const mid = advise(PHONE(7.4), [], '', 'auto', true);
    expect(mid.profile.id).toBe('mid');
    expect(mid.options.find((o) => o.id === 'qwen3.5-4b-q4km')!.fit.fits).toBe('cpu');
    const high = advise(PHONE(11.2), ['qwen3.5-9b-q4km'], 'qwen3.5-9b-q4km', 'auto', true);
    expect(high.profile.id).toBe('high');
    expect(high.options.find((o) => o.active)!.installed).toBe(true);
  });
  it('un móvil modesto no recibe modelos que no caben ni descargas gigantes', () => {
    const a = advise(PHONE(5), [], '', 'auto', true);
    expect(a.options.find((o) => o.id === 'gemma4-26b-a4b-qat')!.fit.fits).toBe('no');
    expect(a.options.find((o) => o.id === 'qwen3.5-9b-q4km')!.fit.fits).toBe('no');
  });
  it('un teléfono de 4 GB o menos no es compatible y lo dice con honestidad', () => {
    const a = advise(PHONE(4), [], '', 'auto', true);
    expect(a.supported).toBe(false);
    expect(a.reason).toMatch(/no tiene memoria suficiente/);
  });
  it('resolveModel prefiere el pedido, si no el que encaja con el equipo', () => {
    const mk = (id: string, params_b: number, size: number): InstalledModel => ({ id, params_b, size, arch: 'qwen35' } as InstalledModel);
    const list = [mk('big', 9, 5.7e9), mk('small', 2, 1.3e9)];
    expect(resolveModel(list, 'big', PHONE(6), 'auto', true)!.id).toBe('big');
    expect(resolveModel(list, '', PHONE(6), 'auto', true)!.id).toBe('small'); // el grande no cabe
    expect(resolveModel([], '', PHONE(8), 'auto', true)).toBeNull();
  });
  it('el catálogo solo contiene modelos con licencia permisiva', () => {
    for (const m of CATALOG) expect(licenseInfo(m.license).class, m.id).toBe('permissive');
  });
});

// -- Hugging Face con un servidor simulado en memoria ----------------------------------------------------

const REPO = {
  id: 'org/Tiny-GGUF', sha: 'a'.repeat(40), gated: false, cardData: { license: 'apache-2.0' }, tags: ['gguf', 'license:apache-2.0', 'ja', 'en'],
  gguf: { total: 4e9, architecture: 'qwen35', context_length: 262144 },
};
const TREE = [
  { type: 'file', path: 'Tiny-Q4_K_M.gguf', lfs: { size: 3_000_000_000, oid: 'b'.repeat(64) } },
  { type: 'file', path: 'Tiny-Q8_0.gguf', lfs: { size: 5_000_000_000, oid: 'c'.repeat(64) } },
  { type: 'file', path: 'Big-00001-of-00002.gguf', lfs: { size: 1_200_000_000, oid: 'd'.repeat(64) } },
  { type: 'file', path: 'Big-00002-of-00002.gguf', lfs: { size: 1_100_000_000, oid: 'e'.repeat(64) } },
  { type: 'file', path: 'mmproj-F16.gguf', lfs: { size: 800_000_000, oid: 'f'.repeat(64) } },
  { type: 'file', path: 'README.md', size: 10 },
  { type: 'directory', path: 'sub' },
];
const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(): (u: string, i?: RequestInit) => Promise<Response> {
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/models') return json([{ id: 'org/Tiny-GGUF', downloads: 1234, likes: 5, tags: ['gguf', 'license:apache-2.0', 'ja', 'multilingual'] }, { id: '../x', tags: [] }]);
    if (u.pathname === '/api/models/org/Tiny-GGUF') return json(REPO);
    if (u.pathname === `/api/models/org/Tiny-GGUF/tree/${REPO.sha}`) {
      if (u.searchParams.get('page') === '2') return json(TREE.slice(4));
      return json(TREE.slice(0, 4), { link: `<http://hf.test${u.pathname}?recursive=true&page=2>; rel="next"` });
    }
    return new Response('{}', { status: 404 });
  };
}

describe('cliente de Hugging Face', () => {
  const hf = new HuggingFace('http://hf.test/', '', fakeFetch());
  it('busca, ignora repos con nombre inválido y clasifica la licencia', async () => {
    const r = await hf.search('qwen');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ repo: 'org/Tiny-GGUF', downloads: 1234, license: 'apache-2.0', languages: ['ja', 'multilingual'] });
    expect(r[0].license_info.class).toBe('permissive');
  });
  it('lista los archivos con tamaño y sha256, siguiendo la paginación', async () => {
    const m = await hf.fetchModel('org/Tiny-GGUF');
    expect(m.revision).toBe(REPO.sha);
    expect(Object.keys(m.files)).toEqual(expect.arrayContaining(['Tiny-Q4_K_M.gguf', 'mmproj-F16.gguf', 'README.md']));
    expect(m.files['Tiny-Q4_K_M.gguf']).toMatchObject({ size: 3_000_000_000, sha256: 'b'.repeat(64) });
    expect(hf.url(m, 'Tiny-Q4_K_M.gguf')).toBe(`http://hf.test/org/Tiny-GGUF/resolve/${REPO.sha}/Tiny-Q4_K_M.gguf`);
    expect(shardsOf(m, 'Big-00001-of-00002.gguf').map((f) => f.path)).toEqual(['Big-00001-of-00002.gguf', 'Big-00002-of-00002.gguf']);
  });
  it('describe el repositorio con compatibilidad por teléfono', async () => {
    const m = await hf.fetchModel('org/Tiny-GGUF');
    const info = describeRepo(m, { ram_gb: 7, vram_gb: 0 }, 6144, true);
    expect(info.files.map((f) => f.path)).toEqual(['Big-00001-of-00002.gguf', 'Tiny-Q4_K_M.gguf', 'Tiny-Q8_0.gguf']);
    expect(info.files[0]).toMatchObject({ shards: 2, size: 2_300_000_000 });
    expect(info.mmproj_suggested?.path).toBe('mmproj-F16.gguf');
    const q8 = info.files.find((f) => f.quant === 'Q8_0')!;
    expect(q8.fit.fits).toBe('no'); // 5 GB + caché no caben en un móvil de 7 GB con la reserva del sistema
    expect(info.files.find((f) => f.quant === 'Q4_K_M')!.fit.fits).toBe('cpu');
  });
  it('rechaza ids y rutas peligrosos y traduce los errores HTTP', async () => {
    expect(() => validateRepo('../etc/passwd')).toThrow();
    expect(() => validatePath('a/../../b.gguf')).toThrow();
    await expect(hf.fetchModel('org/NoExiste')).rejects.toMatchObject({ code: 'not_found' });
    const gated = new HuggingFace('http://hf.test', '', async () => new Response('', { status: 403 }));
    await expect(gated.fetchModel('org/Gated')).rejects.toMatchObject({ code: 'auth_required' });
    const offline = new HuggingFace('http://hf.test', '', async () => { throw new TypeError('fail'); });
    await expect(offline.search('x')).rejects.toMatchObject({ code: 'hf_unreachable' });
  });
  it('quantOf y modelId', () => {
    expect(quantOf('Qwen3.5-4B-Q4_K_M.gguf')).toBe('Q4_K_M');
    expect(quantOf('x-UD-IQ2_XXS.gguf')).toBe('UD-IQ2_XXS');
    expect(modelId('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf')).toBe('qwen3-5-4b-gguf-qwen3-5-4b-q4-k-m');
  });
});
