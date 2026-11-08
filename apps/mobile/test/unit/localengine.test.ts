/**
 * Motor local del teléfono (LocalEngine): la misma API que el motor del PC, ejecutándose solo con piezas del dispositivo.
 * Visión y modelo de lenguaje son simulados; la descarga de modelos usa un Hugging Face simulado con archivos reales.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import type { EngineEvent } from '../../src/engine/core/events';
import { LocalEngine, type DeviceInfo, type DeviceInfoPort } from '../../src/engine/api/localEngine';
import { ImportProblem, type ImageCodec } from '../../src/engine/importers/ingest';
import { LlmLibrary } from '../../src/engine/models/library';
import { NativeLlmRuntime, type LlamaHost } from '../../src/engine/models/runtime';
import { VisionModelManager } from '../../src/engine/models/vision';
import { RunState } from '../../src/engine/pipeline/runstate';
import { MemoryStorage, type DocStorage } from '../../src/engine/store/docs';
import { FakeDevice, FakeLlm, FakeVision, sleep, type FakePage } from './helpers';
import { startFakeHf, type FakeHf } from './fakehf';
import { NodeFiles } from './nodefiles';

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BOOK: Record<string, FakePage> = {
  p1: { texts: ['おはよう', 'どこへ行くの？'] },
  p2: { texts: ['先輩！', '待って'] },
  p3: { texts: ['ありがとう'] },
  p4: { texts: [] },
};
const KEYS = Object.keys(BOOK);

/** «Imagen»: firma PNG + clave de la página. El códec la deja como la clave (la visión simulada la lee como texto). */
const fakePng = (key: string, salt = '') => new Uint8Array([...PNG_SIG, ...new TextEncoder().encode(key + salt)]);
const codec: ImageCodec = {
  async load(_name, data) {
    const key = new TextDecoder().decode(data.subarray(8));
    const n = Number(/^p(\d+)/.exec(key)?.[1]);
    if (!Number.isFinite(n)) throw new ImportProblem('la imagen está dañada o incompleta');
    return { data: data.subarray(8), ext: 'png', width: 200, height: 300, dhash: (n % 16).toString(16).repeat(16) };
  },
};
const upload = (key: string) => ({ name: key + '.png', blob: new Blob([fakePng(key)]) });

/** Almacenamiento que puede «congelarse»: lo que se escribe después no llega al disco (el proceso murió). */
class FreezableStorage implements DocStorage {
  frozen = false;
  constructor(readonly inner: DocStorage) {}
  getDoc<T>(k: string) { return this.inner.getDoc<T>(k); }
  async putDoc(k: string, v: unknown) { if (!this.frozen) await this.inner.putDoc(k, v); }
  async deleteDoc(k: string) { if (!this.frozen) await this.inner.deleteDoc(k); }
  listDocKeys(p: string) { return this.inner.listDocKeys(p); }
  getBlob(k: string) { return this.inner.getBlob(k); }
  async putBlob(k: string, b: Blob) { if (!this.frozen) await this.inner.putBlob(k, b); }
  async deleteBlob(k: string) { if (!this.frozen) await this.inner.deleteBlob(k); }
  async deleteByPrefix(p: string) { if (!this.frozen) await this.inner.deleteByPrefix(p); }
  blobBytes(p: string) { return this.inner.blobBytes(p); }
}

class PhoneDevice extends FakeDevice implements DeviceInfoPort {
  async info(): Promise<DeviceInfo> {
    return { os: 'Android 15', model: 'Pixel de pruebas', cpu: 'arm64-v8a', cores: 8, threads: 8, ram_mb: 8192, free_bytes: 20e9, total_bytes: 128e9 };
  }
}

class FakeHost implements LlamaHost {
  running = false;
  starts: string[][] = [];
  async available() { return true; }
  async start(o: { model: string; args: string[] }) { this.running = true; this.starts.push(o.args); return { baseUrl: 'http://127.0.0.1:9', pid: 7 }; }
  async stop() { this.running = false; }
  async isRunning() { return this.running; }
  async logTail() { return []; }
}

interface Rig {
  engine: LocalEngine; storage: DocStorage; vision: FakeVision; llm: FakeLlm; files: NodeFiles; host: FakeHost; events: EngineEvent[];
}

describe('motor local del teléfono', () => {
  let hf: FakeHf;
  const opened: { files: NodeFiles; engine: LocalEngine }[] = [];
  beforeEach(async () => { hf = await startFakeHf(); });
  afterEach(async () => {
    for (const o of opened.splice(0)) { await o.engine.dispose(); o.files.dispose(); }
    await hf.close();
  });

  async function rig(opts: { book?: Record<string, FakePage>; storage?: DocStorage; files?: NodeFiles; pdf?: boolean } = {}): Promise<Rig> {
    const storage = opts.storage ?? new MemoryStorage();
    const files = opts.files ?? new NodeFiles();
    const vision = new FakeVision(opts.book ?? BOOK);
    const llm = new FakeLlm();
    const host = new FakeHost();
    const device = new PhoneDevice();
    const library = new LlmLibrary(files, { endpoint: hf.url, mobile: true });
    const visionModels = new VisionModelManager(files);
    let engineRef: LocalEngine | undefined;
    const runtime = new NativeLlmRuntime({ host, library, settings: () => (engineRef as unknown as { settings: never }).settings, device, watchMs: 0 });
    const engine = await LocalEngine.create({
      storage, device, vision, visionModels, library, runtime, codec, thumbs: async (b) => b, clientFactory: () => llm,
    });
    engineRef = engine;
    opened.push({ files, engine });
    const events: EngineEvent[] = [];
    engine.listen((e) => events.push(e));
    return { engine, storage, vision, llm, files, host, events };
  }

  async function wait(e: LocalEngine, id: string, until: (s: string) => boolean = (s) => ['done', 'error', 'cancelled'].includes(s), ms = 20000) {
    const t0 = Date.now();
    for (;;) {
      const j = await e.job(id);
      if (until(j.status)) return j;
      if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado (${j.status}: ${j.message})`);
      await sleep(5);
    }
  }

  /** Descarga (del Hugging Face simulado) un modelo pequeño: sin modelo instalado no se puede traducir. */
  async function withModel(r: Rig) {
    const job = await wait(r.engine, (await r.engine.installLLM('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf')).id);
    expect(job.status).toBe('done');
  }

  /** Proyecto con las páginas importadas y un modelo de traducción instalado, listo para procesar. */
  async function seeded(r: Rig, keys = KEYS) {
    if (!(await r.engine.llm()).installed) await withModel(r);
    const project = await r.engine.createProject({ name: 'Obra de prueba', source_lang: 'ja' });
    const job = await wait(r.engine, (await r.engine.importFiles(project.id, keys.map(upload))).id);
    expect(job.status).toBe('done');
    return project.id;
  }

  // -- sistema --------------------------------------------------------------------------------
  it('informa del teléfono y de lo que funciona sin conexión, sin depender de ningún PC', async () => {
    const { engine } = await rig();
    expect(await engine.health()).toMatchObject({ ok: true });
    const s = await engine.system();
    expect(s.hardware).toMatchObject({ os: 'Android 15', cores: 8, ram_mb: 8192 });
    expect(s.accelerator.name).toContain('teléfono');
    expect(s.llm).toMatchObject({ provider: 'builtin', installed: 0, ready: false, runtime_available: true });
    const byName = Object.fromEntries(s.offline.map((o) => [o.component, o]));
    expect(byName['Importación y exportación'].offline).toBe(true);
    expect(byName['OCR multilingüe (PP-OCR)'].offline).toBe(true);
    expect(byName['Detección de texto'].offline).toBe(false);          // hasta descargar el detector
    expect(byName['Traducción contextual (modelo en el teléfono)'].offline).toBe(false);
    expect(byName['Descarga de modelos y actualizaciones'].requires).toMatch(/Internet/);
    const st = await engine.storageInfo();
    expect(st).toMatchObject({ projects_bytes: 0, llm_bytes: 0, free_bytes: 20e9 });
  });

  it('guarda los ajustes y los recupera al reabrir la app; la clave de Hugging Face no se devuelve', async () => {
    const storage = new MemoryStorage();
    const a = await rig({ storage });
    const out = await a.engine.updateSettings({ llm: { hf_token: 'hf_secreto', idle_unload_minutes: 3 }, translation: { target_variant: 'es-ES' } });
    expect(JSON.stringify(out)).not.toContain('hf_secreto');
    expect(out.llm.idle_unload_minutes).toBe(3);
    const b = await rig({ storage });
    const again = await b.engine.getSettings();
    expect(again.translation.target_variant).toBe('es-ES');
    expect(again.llm.idle_unload_minutes).toBe(3);
    expect((await b.engine.llm()).hf_token_set).toBe(true);
  });

  // -- proyectos --------------------------------------------------------------------------------
  it('crea, lista, edita y elimina proyectos validando los datos', async () => {
    const { engine } = await rig();
    await expect(engine.createProject({ name: '   ' })).rejects.toMatchObject({ code: expect.stringMatching(/invalid/) });
    await expect(engine.createProject({ name: 'X', source_lang: 'klingon' })).rejects.toMatchObject({ code: 'invalid_lang' });
    const p = await engine.createProject({ name: ' Mi manga ', source_lang: 'ja' });
    expect(p.name).toBe('Mi manga');
    expect(p.reading_direction).toBe('rtl');
    const auto = await engine.createProject({ name: 'Detectar', source_lang: 'auto' });
    expect(auto.direction_auto).toBe(true);
    expect((await engine.projects()).map((x) => x.name).sort()).toEqual(['Detectar', 'Mi manga']);

    const upd = await engine.updateProject(p.id, {
      name: 'Renombrado', target_variant: 'es-ES', synopsis: 'Resumen', characters: [{ source: '愛子', target: 'Aiko', gender: 'f', speech: 'educada', locked: true }],
    });
    expect(upd).toMatchObject({ name: 'Renombrado', target_variant: 'es-ES', synopsis: 'Resumen' });
    expect(upd.characters[0]).toMatchObject({ target: 'Aiko', locked: true });
    await expect(engine.updateProject(p.id, { target_variant: 'es-XX' as never })).rejects.toMatchObject({ code: 'invalid_variant' });
    await expect(engine.updateProject('no-existe', { name: 'x' })).rejects.toBeTruthy();

    const bundle = await engine.project(p.id);
    expect(bundle.project.name).toBe('Renombrado');
    expect(bundle.pages).toEqual([]);
    await engine.deleteProject(p.id);
    expect((await engine.projects()).map((x) => x.id)).not.toContain(p.id);
  });

  // -- importación ---------------------------------------------------------------------------------
  it('importa imágenes y ZIP, ordena de forma natural, descarta duplicados y avisa de lo dañado', async () => {
    const r = await rig();
    const project = await r.engine.createProject({ name: 'Import', source_lang: 'ja' });
    const zip = zipSync({ 'cap/p3.png': fakePng('p3'), 'cap/p1.png': fakePng('p1'), 'cap/p2.png': fakePng('p2'), 'cap/notas.txt': new TextEncoder().encode('hola') });
    const job = await wait(r.engine, (await r.engine.importFiles(project.id, [
      { name: 'obra.cbz', blob: new Blob([zip]) },
      { name: 'repetida.png', blob: new Blob([fakePng('p1', '')]) },        // mismo contenido que p1 → duplicado
      { name: 'rota.png', blob: new Blob([fakePng('zzz')]) },               // el códec la rechaza
    ])).id);
    expect(job.status).toBe('done');
    const bundle = await r.engine.project(project.id);
    expect(bundle.pages.map((p) => p.filename)).toEqual(['p1.png', 'p2.png', 'p3.png']);
    expect(bundle.project.cover_page_id).toBe(bundle.pages[0].id);
    const report = job.result as { added: unknown[]; duplicates: unknown[]; errors: { file: string }[]; limit: number };
    expect(report.added).toHaveLength(3);
    expect(report.duplicates).toHaveLength(1);
    expect(report.errors.map((e) => e.file)).toEqual(expect.arrayContaining(['rota.png']));
    expect(report.limit).toBeGreaterThan(0);
    await expect(r.engine.importFiles(project.id, [])).rejects.toMatchObject({ code: 'no_files' });
    await expect(r.engine.importFiles('no-existe', [upload('p1')])).rejects.toBeTruthy();
  });

  it('respeta el límite de páginas y conserva lo importado si se cancela a mitad', async () => {
    const r = await rig();
    await r.engine.updateSettings({ processing: { max_pages: 2 } });
    const project = await r.engine.createProject({ name: 'Limite', source_lang: 'ja' });
    const job = await wait(r.engine, (await r.engine.importFiles(project.id, ['p1', 'p2', 'p3'].map(upload))).id);
    expect(job.status).toBe('done');
    const bundle = await r.engine.project(project.id);
    expect(bundle.pages).toHaveLength(2);
    expect(bundle.project.cover_page_id).toBe(bundle.pages[0].id);
  });

  // -- procesado completo ----------------------------------------------------------------------------
  it('procesa la obra completa en una sola tarea y deja ver cada página al terminar', async () => {
    const r = await rig();
    const pid = await seeded(r);
    const done: string[] = [];
    r.engine.listen((e) => { if (e.type === 'page' && e.state === 'done') done.push(e.page_id); });

    const job = await wait(r.engine, (await r.engine.process(pid)).id);
    expect(job.status).toBe('done');
    expect(job.progress).toBe(1);
    const bundle = await r.engine.project(pid);
    expect(bundle.pages.map((p) => p.status)).toEqual(['cleaned', 'cleaned', 'cleaned', 'cleaned']);
    expect(bundle.pages[0].regions.map((x) => x.translation)).toEqual(['ES(おはよう)', 'ES(どこへ行くの？)']);
    expect(bundle.run).toMatchObject({ status: 'done', counts: { total: 4, done: 4, error: 0, pending: 0 } });
    expect(bundle.summary).toMatchObject({ page_count: 4, cleaned_pages: 4, regions: 5, translated: 5 });
    expect(done).toHaveLength(4);
    expect(r.llm.calls.some((c) => c.user.includes('Resumen de la página 1'))).toBe(true); // la memoria narrativa viaja entre páginas

    const [first] = bundle.pages;
    expect(await (await r.engine.image(pid, first.id, 'original'))!.text()).toBe('p1');
    expect(await (await r.engine.image(pid, first.id, 'clean'))!.text()).toBe('clean:p1');
    expect(await r.engine.image(pid, first.id, 'thumb')).toBeTruthy();
    await expect(r.engine.image(pid, first.id, 'otra' as never)).rejects.toMatchObject({ code: 'invalid_kind' });
    expect((await r.engine.storageInfo()).projects_bytes).toBeGreaterThan(0);
  });

  it('sin modelo de traducción instalado, explica qué falta en lugar de fallar sin más', async () => {
    const r = await rig();
    const project = await r.engine.createProject({ name: 'Sin modelo', source_lang: 'ja' });
    await wait(r.engine, (await r.engine.importFiles(project.id, [upload('p1')])).id);
    const job = await wait(r.engine, (await r.engine.process(project.id)).id);
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/modelo/i);
    expect(job.error).not.toMatch(/inesperado/i);
  });

  it('no permite procesar dos veces a la vez ni borrar el proyecto mientras se procesa', async () => {
    const r = await rig();
    const pid = await seeded(r);
    let release = () => undefined as void;
    const gate = new Promise<void>((res) => { release = res; });
    r.llm.hook = async (c) => { if (c.kind === 'translate') await gate; };
    const job = await r.engine.process(pid);
    await expect(r.engine.process(pid)).rejects.toMatchObject({ code: 'busy' });
    await expect(r.engine.deleteProject(pid)).rejects.toMatchObject({ code: 'busy' });
    release();
    expect((await wait(r.engine, job.id)).status).toBe('done');
    await expect(r.engine.process(pid, { stages: ['nada' as never] })).rejects.toMatchObject({ code: 'invalid_stages' });
  });

  it('pausa a mitad (lo terminado se puede ver), reanuda sin repetir trabajo y no deja nada sin hacer', async () => {
    const r = await rig();
    const pid = await seeded(r);
    let paused = false;
    let jobId = '';
    r.engine.listen((e) => { if (e.type === 'page' && e.state === 'done' && !paused) { paused = true; void r.engine.pauseJob(jobId); } });
    jobId = (await r.engine.process(pid)).id;
    await wait(r.engine, jobId, (s) => s === 'paused');
    const mid = await r.engine.project(pid);
    expect(mid.run?.status).toBe('paused');
    expect(mid.pages[0].status).toBe('cleaned');
    const before = [...r.vision.analyzed];
    await sleep(60);
    expect(r.vision.analyzed).toEqual(before);                         // en pausa no avanza nada

    await r.engine.resumeJob(jobId);
    expect((await wait(r.engine, jobId)).status).toBe('done');
    expect(r.vision.analyzed.sort()).toEqual([...KEYS].sort());        // cada página se analizó una sola vez
    expect((await r.engine.project(pid)).pages.every((p) => p.status === 'cleaned')).toBe(true);
  });

  it('si la app muere a mitad, al reabrir detecta la interrupción y «reanudar» solo hace lo que falta', async () => {
    const storage = new FreezableStorage(new MemoryStorage());
    const files = new NodeFiles();
    const a = await rig({ storage, files });
    const pid = await seeded(a);
    let calls = 0;
    a.llm.hook = (c) => {
      // Tras traducir la segunda página el proceso «muere»: ya no se guarda nada más.
      if (c.kind === 'translate' && ++calls === 2) { storage.frozen = true; void a.engine.dispose(); }
    };
    await a.engine.process(pid);
    await sleep(200);
    const analyzedBefore = a.vision.analyzed.length;
    expect(analyzedBefore).toBeGreaterThanOrEqual(2);

    // Segunda ejecución de la app, con el mismo almacenamiento y sin tarea en curso
    const b = await rig({ storage: storage.inner, files });
    const info = await b.engine.run(pid);
    expect(info).toMatchObject({ interrupted: true, resumable: true, status: 'interrupted' });
    expect(info!.counts.done).toBeLessThan(4);
    const doneBefore = info!.counts.done;

    const job = await wait(b.engine, (await b.engine.process(pid, { resume: true })).id);
    expect(job.status).toBe('done');
    const bundle = await b.engine.project(pid);
    expect(bundle.pages.every((p) => p.status === 'cleaned')).toBe(true);
    expect(bundle.run).toMatchObject({ status: 'done', interrupted: false });
    expect(b.vision.analyzed.length).toBeLessThanOrEqual(4 - doneBefore + 1); // no se rehizo lo que ya estaba terminado
    expect(bundle.pages[0].regions[0].translation).toBe('ES(おはよう)');
  });

  it('una página dañada no detiene la obra y se puede reintentar sola', async () => {
    const r = await rig({ book: { ...BOOK, p2: { texts: ['x'], fail: true } } });
    const pid = await seeded(r);
    const job = await wait(r.engine, (await r.engine.process(pid)).id);
    expect(job.status).toBe('done');
    const bundle = await r.engine.project(pid);
    expect(bundle.pages.map((p) => p.status)).toEqual(['cleaned', 'error', 'cleaned', 'cleaned']);
    expect(bundle.run).toMatchObject({ counts: { total: 4, done: 3, error: 1 } });
    r.vision.pages.p2 = { texts: ['先輩！'] };
    const retry = await wait(r.engine, (await r.engine.process(pid)).id);
    expect(retry.status).toBe('done');
    expect((await r.engine.project(pid)).pages.every((p) => p.status === 'cleaned')).toBe(true);
  });

  // -- edición ----------------------------------------------------------------------------------------
  it('edita, crea y borra textos, retraduce y reconstruye una página, validando las entradas', async () => {
    const r = await rig();
    const pid = await seeded(r);
    await wait(r.engine, (await r.engine.process(pid)).id);
    const [p1] = (await r.engine.project(pid)).pages;
    const [a, b] = p1.regions;

    const edited = await r.engine.updateRegion(pid, p1.id, a.id, { translation: 'Buenos días', status: 'edited' });
    expect(edited).toMatchObject({ translation: 'Buenos días', status: 'edited' });
    await expect(r.engine.updateRegion(pid, p1.id, a.id, { status: 'inventado' })).rejects.toMatchObject({ code: expect.stringMatching(/invalid/) });
    await expect(r.engine.updateRegion(pid, p1.id, '../x', { translation: 'x' })).rejects.toBeTruthy();
    await expect(r.engine.updateRegion(pid, p1.id, a.id, { bbox: [0, 0, -5, 3] })).rejects.toBeTruthy();

    const added = await r.engine.addRegion(pid, p1.id, [20, 200, 120, 280]);
    expect(added.source_text).toContain('leído');
    expect((await r.engine.page(pid, p1.id)).regions).toHaveLength(3);
    await expect(r.engine.addRegion(pid, p1.id, [1, 2, NaN, 4])).rejects.toMatchObject({ code: 'invalid_region' });
    const re = await r.engine.reocrRegion(pid, p1.id, b.id, [10, 110, 110, 190]);
    expect(re.id).toBe(b.id);

    const t = await wait(r.engine, (await r.engine.translateRegions(pid, p1.id, [b.id])).id);
    expect(t.status).toBe('done');
    const c = await wait(r.engine, (await r.engine.cleanPage(pid, p1.id)).id);
    expect(c.status).toBe('done');

    await r.engine.deleteRegion(pid, p1.id, added.id);
    expect((await r.engine.page(pid, p1.id)).regions.map((x) => x.id)).toEqual([a.id, b.id]);
    await expect(r.engine.deleteRegion(pid, p1.id, 'zzzz')).rejects.toMatchObject({ code: 'not_found' });

    const ok = await r.engine.approvePage(pid, p1.id, true);
    expect(ok.approved).toBe(true);
    expect(ok.regions.find((x) => x.id === a.id)!.status).toBe('approved');
  });

  it('reordena y borra páginas', async () => {
    const r = await rig();
    const pid = await seeded(r, ['p1', 'p2', 'p3']);
    const ids = (await r.engine.project(pid)).project.page_ids;
    expect((await r.engine.reorderPages(pid, [ids[2], ids[0], ids[1]])).page_ids).toEqual([ids[2], ids[0], ids[1]]);
    await expect(r.engine.reorderPages(pid, [ids[0]])).rejects.toBeTruthy();
    await r.engine.deletePage(pid, ids[0]);
    expect((await r.engine.project(pid)).project.page_ids).toEqual([ids[2], ids[1]]);
  });

  // -- modelos --------------------------------------------------------------------------------------------
  it('busca, ficha, descarga, activa, comprueba compatibilidad y elimina modelos de traducción (sin PC)', async () => {
    const r = await rig();
    const found = await r.engine.searchModels('tiny');
    expect(found.map((x) => x.repo)).toEqual(['fake-org/Tiny-Qwen-GGUF']);
    const info = await r.engine.inspectRepo('fake-org/Tiny-Qwen-GGUF');
    expect(info.files.some((f) => f.path === 'Tiny-Q4_K_M.gguf')).toBe(true);

    // Lo que no cabe en el teléfono se bloquea antes de descargar nada
    const huge = await r.engine.installLLM('fake-org/Huge-GGUF', 'Huge-Q4_K_M.gguf');
    const hugeDone = await wait(r.engine, huge.id);
    expect(hugeDone).toMatchObject({ status: 'error' });
    expect(hugeDone.error).toMatch(/compatible/);
    expect(hf.requests.filter((q) => q.kind === 'resolve')).toHaveLength(0);

    const job = await r.engine.installLLM('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf');
    await expect(r.engine.installLLM('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf')).rejects.toMatchObject({ code: 'busy' });
    expect((await wait(r.engine, job.id)).status).toBe('done');
    const overview = await r.engine.llm();
    expect(overview.installed_models).toHaveLength(1);
    const id = overview.installed_models[0].id;
    expect(overview.active).toBe(id);                                  // el primero que se instala pasa a ser el activo
    expect(overview).toMatchObject({ ready: true, installed: 1 });
    expect(overview.installed_models[0].fit.fits).not.toBe('gpu');
    expect((await r.engine.system()).llm.ready).toBe(true);
    expect((await r.engine.storageInfo()).llm_bytes).toBe(300_000);

    // Traducción de prueba con el modelo activo
    const probe = await r.engine.testLLM('おはよう', 'ja');
    expect(probe.translation).toBe('ES(おはよう)');
    await expect(r.engine.testLLM('hola', 'auto')).rejects.toMatchObject({ code: 'invalid_lang' });
    await expect(r.engine.testLLM('   ', 'ja')).rejects.toMatchObject({ code: 'invalid_text' });

    // Comparación de modelos (calidad / velocidad) sobre frases de JA y EN
    await wait(r.engine, (await r.engine.installLLM('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q8_0.gguf')).id);
    const ids = (await r.engine.llm()).installed_models.map((m) => m.id);
    expect(ids).toHaveLength(2);
    const cmp = await wait(r.engine, (await r.engine.compareLLMs(ids)).id);
    expect(cmp.status).toBe('done');
    expect((cmp.result as { models: unknown[] }).models).toHaveLength(2);
    await expect(r.engine.compareLLMs([])).rejects.toMatchObject({ code: 'invalid_models' });
    await expect(r.engine.compareLLMs(['no-existe'])).rejects.toMatchObject({ code: 'not_found' });

    // Cambiar el modelo activo y eliminar uno
    const other = ids.find((x) => x !== id)!;
    expect(await r.engine.activateLLM(other)).toMatchObject({ ok: true, active: other });
    expect((await r.engine.llm()).active).toBe(other);
    await r.engine.removeLLM(other);
    const after = await r.engine.llm();
    expect(after.installed_models.map((m) => m.id)).toEqual([id]);
    expect(after.active).toBe(id);                                     // vuelve a elegirse uno válido
    await expect(r.engine.activateLLM('no-existe')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('un modelo con acceso restringido pide la clave de Hugging Face y la usa solo en las peticiones a Hugging Face', async () => {
    const r = await rig();
    const noKey = await wait(r.engine, (await r.engine.installLLM('fake-org/Gated-GGUF', 'Gated-Q4_0.gguf', { force: true })).id);
    expect(noKey).toMatchObject({ status: 'error' });
    expect(noKey.error).toMatch(/clave|acceso|token/i);
    await r.engine.updateSettings({ llm: { hf_token: 'good' } });
    const ok = await wait(r.engine, (await r.engine.installLLM('fake-org/Gated-GGUF', 'Gated-Q4_0.gguf', { force: true })).id);
    expect(ok.status).toBe('done');
    expect(hf.requests.some((q) => q.auth === 'Bearer good')).toBe(true);
  });

  it('descargar un modelo de visión desconocido o repetido se rechaza con un mensaje claro', async () => {
    const r = await rig();
    await expect(r.engine.installModel('no-existe')).rejects.toMatchObject({ code: 'not_found' });
    const { vision } = await r.engine.models();
    expect(vision.map((m) => m.id)).toEqual(expect.arrayContaining(['text-detector', 'manga-ocr', 'lama']));
    expect(vision.every((m) => m.installed === false || m.id === 'ppocr-multi')).toBe(true);
  });

  it('el servidor de lenguaje se carga bajo demanda y se descarga para liberar memoria', async () => {
    const r = await rig();
    await wait(r.engine, (await r.engine.installLLM('fake-org/Tiny-Qwen-GGUF', 'Tiny-Q4_K_M.gguf')).id);
    expect((await r.engine.llmRuntime()).running).toBe(false);
    const rt = (r.engine as unknown as { d: { runtime: NativeLlmRuntime } }).d.runtime;
    const lease = await rt.acquire((await r.engine.llm()).active!);
    lease.release();
    expect(await r.engine.llmRuntime()).toMatchObject({ running: true, available: true });
    expect(r.host.starts[0]).toEqual(expect.arrayContaining(['-ngl', '0']));
    expect((await r.engine.unloadLLM()).running).toBe(false);
    expect(r.host.running).toBe(false);
  });
});
