/**
 * Fase 4 — rendimiento y procesamiento por lotes: cola persistente, cachés (OCR y traducciones), gobernador de concurrencia,
 * orden de la precarga del modelo, liberación de memoria, medición por etapa/capítulo y capítulos largos con interrupciones.
 *
 * Qué demuestran (y qué NO): estas pruebas verifican el COMPORTAMIENTO (qué se reutiliza, qué no, qué se serializa, que nada se pierde
 * ni se estropea). Con visión y modelo simulados NO miden velocidad real: los tiempos reales hay que medirlos en el teléfono.
 */
import { describe, expect, it } from 'vitest';
import type { Page, Project, QueueEntry } from '@starblitz/shared';
import { DocCache, analysisKey, createCaches, hashText } from '../../src/engine/pipeline/cache';
import {
  OVERLAP_MIN_FREE_MB, OVERLAP_MIN_RAM_DESKTOP_GB, OVERLAP_MIN_RAM_MOBILE_GB, planConcurrency,
} from '../../src/engine/pipeline/governor';
import { MAX_FINISHED_KEPT, ProcessQueue } from '../../src/engine/pipeline/queue';
import { isCacheableResult } from '../../src/engine/translate/contextual';
import { MemoryStorage } from '../../src/engine/store/docs';
import { makeEnv, pagesOf, seedProject, sleep, startRun, text, waitJob, type Env, type FakePage } from './helpers';

const BOOK: Record<string, FakePage> = {
  p1: { texts: ['おはよう', 'どこへ行くの？'] },
  p2: { texts: ['先輩！', '待って'] },
  p3: { texts: ['ありがとう'] },
  p4: { texts: [] },
};
const KEYS = Object.keys(BOOK);

interface ChapterLike { llm_calls: number; translate_cache_hits: number; ocr_cache_hits: number; ocr_cache_misses: number; overlapped_pages: number; trims: number; min_free_mb: number | null; plan: string; total_s: number }
interface PageLike { page: number; ocr_cached: boolean; llm_calls: number; tr_cache_hits: number }
const lastJob = async (env: Env, p: Project) =>
  (await env.store.get(p.id)).last_job as unknown as { timings: { chapter: ChapterLike; pages: PageLike[] }; lines: number; errors: number };

async function process_(env: Env, p: Project, opts: Parameters<typeof startRun>[2] = {}) {
  const job = await waitJob(env, startRun(env, p.id, opts).id);
  expect(job.status).toBe('done');
  return lastJob(env, p);
}
const translations = async (env: Env, p: Project) => (await pagesOf(env, p)).map((g) => g.regions.map((r) => r.translation));

/** Un libro largo: `n` páginas con 1–3 textos cada una. */
function longBook(n: number): Record<string, FakePage> {
  const out: Record<string, FakePage> = {};
  for (let i = 1; i <= n; i += 1) out['p' + i] = { texts: Array.from({ length: 1 + (i % 3) }, (_, k) => `texto ${i}-${k}`) };
  return out;
}

describe('gobernador de concurrencia', () => {
  it('por defecto todo va en serie: solo se solapa con RAM de sobra y memoria libre', () => {
    expect(planConcurrency({ mobile: true, ramGb: 8, freeMb: 3000, lowMemory: false }).overlap).toBe(false);   // Redmi Note 8 Pro y similares
    expect(planConcurrency({ mobile: true, ramGb: 6, freeMb: null, lowMemory: false }).overlap).toBe(false);
    expect(planConcurrency({ mobile: true, ramGb: OVERLAP_MIN_RAM_MOBILE_GB, freeMb: 4000, lowMemory: false }).overlap).toBe(true);
    expect(planConcurrency({ mobile: false, ramGb: 12, freeMb: 9000, lowMemory: false }).overlap).toBe(false); // PC: el umbral es mayor
    expect(planConcurrency({ mobile: false, ramGb: OVERLAP_MIN_RAM_DESKTOP_GB, freeMb: null, lowMemory: false }).overlap).toBe(true);
  });

  it('con poca memoria libre o aviso del sistema vuelve a serie aunque haya RAM', () => {
    expect(planConcurrency({ mobile: true, ramGb: 12, freeMb: OVERLAP_MIN_FREE_MB - 1, lowMemory: false }).overlap).toBe(false);
    expect(planConcurrency({ mobile: true, ramGb: 12, freeMb: 9000, lowMemory: true }).overlap).toBe(false);
    expect(planConcurrency({ mobile: true, ramGb: 12, freeMb: 9000, lowMemory: true }).reason).toMatch(/memoria/);
  });

  it('con la política por defecto y un teléfono de 8 GB, la visión y el modelo NUNCA trabajan a la vez', async () => {
    const env = makeEnv(BOOK);
    const p = await seedProject(env, KEYS);
    const t = await process_(env, p);
    expect(env.probe.both).toBe(false);
    expect(env.probe.maxVision).toBe(1);
    expect(env.probe.maxLlm).toBe(1);
    expect(t.timings.chapter.overlapped_pages).toBe(0);
    expect(t.timings.chapter.plan).toMatch(/serie/);
  });

  it('con RAM de sobra analiza la página siguiente mientras se traduce la actual, con el MISMO resultado que en serie', async () => {
    const serial = makeEnv(BOOK, {}, undefined, undefined, { concurrency: async () => ({ overlap: false, reason: 'serie' }) });
    const ps = await seedProject(serial, KEYS);
    await process_(serial, ps);

    const over = makeEnv(BOOK, {}, undefined, undefined, { concurrency: async () => ({ overlap: true, reason: 'solapado' }) });
    const po = await seedProject(over, KEYS);
    const t = await process_(over, po);

    expect(over.probe.both).toBe(true);                       // hubo solapamiento real
    expect(over.probe.maxLlm).toBe(1);                        // pero nunca dos peticiones al modelo a la vez
    expect(over.probe.maxVision).toBe(1);                     // ni dos análisis a la vez
    expect(t.timings.chapter.overlapped_pages).toBeGreaterThan(0);
    expect(await translations(over, po)).toEqual(await translations(serial, ps));
    expect((await pagesOf(over, po)).every((g) => g.status === 'cleaned')).toBe(true);
    expect(over.vision.analyzed.sort()).toEqual([...KEYS].sort()); // cada página se analizó una sola vez
  });

  it('si el solapado falla en la página siguiente, la actual se completa y el error se atribuye a la correcta', async () => {
    const book = { ...BOOK, p3: { texts: ['x'], fail: true } };
    const env = makeEnv(book, {}, undefined, undefined, { concurrency: async () => ({ overlap: true, reason: 'solapado' }) });
    const p = await seedProject(env, KEYS);
    const job = await waitJob(env, startRun(env, p.id).id);
    expect(job.status).toBe('done');
    expect((await pagesOf(env, p)).map((g) => g.status)).toEqual(['cleaned', 'cleaned', 'error', 'cleaned']);
  });
});

describe('precarga del modelo: no compite con el OCR', () => {
  it('en serie, el modelo se carga DESPUÉS de analizar la primera página (con la visión libre)', async () => {
    const env = makeEnv(BOOK);
    const p = await seedProject(env, KEYS);
    await process_(env, p);
    const log = env.vision.log;
    expect(log.filter((x) => x === 'warm')).toHaveLength(1);
    expect(log.indexOf('warm')).toBeGreaterThan(log.indexOf('analyze:p1'));
    expect(log.indexOf('warm')).toBeLessThan(log.indexOf('analyze:p2')); // y antes de empezar a traducir
  });

  it('con solapado permitido, el modelo se carga ya al principio, mientras la visión analiza', async () => {
    const env = makeEnv(BOOK, {}, undefined, undefined, { concurrency: async () => ({ overlap: true, reason: 'solapado' }) });
    const p = await seedProject(env, KEYS);
    await process_(env, p);
    expect(env.vision.log.indexOf('warm')).toBeLessThan(env.vision.log.indexOf('analyze:p1'));
    expect(env.vision.log.filter((x) => x === 'warm')).toHaveLength(1);
  });

  it('sin etapa de traducción no se carga el modelo', async () => {
    const env = makeEnv(BOOK);
    const p = await seedProject(env, KEYS);
    await process_(env, p, { stages: ['analyze'] });
    expect(env.llm.warmed).toBe(0);
    expect(env.llm.calls).toHaveLength(0);
  });
});

describe('caché de OCR', () => {
  it('una página con la misma imagen e idioma no se vuelve a leer (otro proyecto, reproceso)', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    const first = await process_(env, a);
    expect(first.timings.chapter.ocr_cache_misses).toBe(4);
    expect(first.timings.chapter.ocr_cache_hits).toBe(0);
    const analyzedAfterFirst = env.vision.analyzed.length;

    const b = await seedProject(env, KEYS);                  // mismas imágenes (mismo sha1), proyecto nuevo
    const second = await process_(env, b);
    expect(env.vision.analyzed).toHaveLength(analyzedAfterFirst); // el OCR NO volvió a ejecutarse
    expect(second.timings.chapter.ocr_cache_hits).toBe(4);
    expect(second.timings.pages.every((g) => g.ocr_cached)).toBe(true);
    // El resultado reutilizado es idéntico: mismos textos leídos, y las páginas se reconstruyen con la máscara guardada
    expect((await pagesOf(env, b)).map((g) => g.regions.map((r) => r.source_text)))
      .toEqual((await pagesOf(env, a)).map((g) => g.regions.map((r) => r.source_text)));
    expect((await pagesOf(env, b)).every((g) => g.status === 'cleaned')).toBe(true);
    expect(await text(await env.store.image(b.id, (await pagesOf(env, b))[0].id, 'mask'))).toBe('mask:p1');
  });

  it('«forzar» se salta la caché: la persona pide una lectura nueva', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    await process_(env, a);
    const n = env.vision.analyzed.length;
    await process_(env, a, { force: true });
    expect(env.vision.analyzed.length).toBe(n + 4);
  });

  it('otro idioma, otro motor de lectura u otra imagen son fallos de caché, nunca resultados «parecidos»', async () => {
    const env = makeEnv(BOOK);
    await process_(env, await seedProject(env, KEYS));
    const n = env.vision.analyzed.length;

    await process_(env, await seedProject(env, KEYS, { source_lang: 'ko' }));       // otro idioma
    expect(env.vision.analyzed.length).toBe(n + 4);

    env.vision.fingerprint = async () => 'otro-motor';                              // otro motor de OCR
    await process_(env, await seedProject(env, KEYS));
    expect(env.vision.analyzed.length).toBe(n + 8);

    const k = (o: Partial<Parameters<typeof analysisKey>[0]>) => analysisKey({ sha1: 'a', lang: 'ja', direction: 'rtl', sfx: 'keep', height: 300, engine: 'e', ...o });
    expect(new Set([k({}), k({ sha1: 'b' }), k({ lang: 'ko' }), k({ direction: 'ltr' }), k({ sfx: 'note' }), k({ height: 301 }), k({ engine: 'f' })]).size).toBe(7);
  });

  it('un fallo de lectura NO se guarda: al reintentar se vuelve a leer y se recupera', async () => {
    const book = { ...BOOK, p2: { texts: ['先輩！'], fail: true } };
    const env = makeEnv(book);
    const p = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, p.id).id);
    expect((await pagesOf(env, p)).map((g) => g.status)).toEqual(['cleaned', 'error', 'cleaned', 'cleaned']);
    env.vision.pages.p2 = { texts: ['先輩！'] };
    await process_(env, p);
    expect((await pagesOf(env, p)).map((g) => g.status)).toEqual(['cleaned', 'cleaned', 'cleaned', 'cleaned']);
    expect((await pagesOf(env, p))[1].regions[0].source_text).toBe('先輩！');
  });

  it('una entrada dañada o sin máscara se ignora y se vuelve a leer (no rompe la tarea)', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    await process_(env, a);
    await env.storage.deleteByPrefix('cache/ocr/'.replace(/\/$/, '') + '/'); // se pierde la caché entera
    const n = env.vision.analyzed.length;
    const t = await process_(env, await seedProject(env, KEYS));
    expect(env.vision.analyzed.length).toBe(n + 4);
    expect(t.timings.chapter.ocr_cache_hits).toBe(0);
  });

  it('el tamaño está acotado: se descartan las entradas más antiguas', async () => {
    const storage = new MemoryStorage();
    const cache = new DocCache(storage, 'cache/x', 3);
    for (let i = 0; i < 6; i += 1) await cache.put('k' + i, { i });
    expect(await cache.get('k0')).toBeUndefined();
    expect(await cache.get('k2')).toBeUndefined();
    expect(await cache.get<{ i: number }>('k5')).toEqual({ i: 5 });
    expect((await storage.listDocKeys('cache/x/')).filter((k) => !k.endsWith('_index'))).toHaveLength(3);
  });
});

describe('caché de traducciones', () => {
  it('el mismo texto con el mismo contexto no se vuelve a pedir al modelo, y el resultado es idéntico', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    const first = await process_(env, a);
    expect(first.timings.chapter.llm_calls).toBeGreaterThan(0);
    expect(first.timings.chapter.translate_cache_hits).toBe(0);
    const callsAfterFirst = env.llm.calls.length;

    const b = await seedProject(env, KEYS);
    const second = await process_(env, b);
    expect(env.llm.calls).toHaveLength(callsAfterFirst);        // CERO llamadas nuevas al modelo
    expect(second.timings.chapter.llm_calls).toBe(0);
    expect(second.timings.chapter.translate_cache_hits).toBeGreaterThan(0);
    expect(await translations(env, b)).toEqual(await translations(env, a));
    expect((await pagesOf(env, b))[0].regions[0].translation).toBe('ES(おはよう)');
    // y lo reutilizado cumple las mismas reglas de integridad que lo nuevo
    expect((await pagesOf(env, b)).every((g) => g.status === 'cleaned')).toBe(true);
  });

  it('un cambio de contexto (sinopsis) o de calidad es un fallo de caché: se pregunta al modelo otra vez', async () => {
    const env = makeEnv(BOOK);
    await process_(env, await seedProject(env, KEYS));
    const n = env.llm.calls.length;
    await process_(env, await seedProject(env, KEYS, { synopsis: 'Dos amigas viajan al mar.' }));
    expect(env.llm.calls.length).toBeGreaterThan(n);
  });

  it('un rechazo del modelo o una respuesta vacía NO se guardan: la siguiente vez se vuelve a intentar y puede acertar', async () => {
    const env = makeEnv(BOOK);
    env.llm.refuse = (t) => t === 'おはよう';
    const a = await seedProject(env, KEYS);
    await process_(env, a);
    expect((await pagesOf(env, a))[0].regions[0].flags).toContain('refused');
    const n = env.llm.calls.length;

    env.llm.refuse = () => false;                                // el modelo ya no rechaza
    const b = await seedProject(env, KEYS);
    await process_(env, b);
    expect(env.llm.calls.length).toBeGreaterThan(n);             // la página del rechazo se volvió a pedir
    expect((await pagesOf(env, b))[0].regions[0].translation).toBe('ES(おはよう)');
  });

  it('«forzar» no reutiliza traducciones: pide un resultado nuevo', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    await process_(env, a);
    const n = env.llm.calls.length;
    const t = await process_(env, a, { force: true });
    expect(env.llm.calls.length).toBeGreaterThan(n);
    expect(t.timings.chapter.translate_cache_hits).toBe(0);
  });

  it('isCacheableResult: solo respuestas completas y sanas', () => {
    const ok = { items: [{ n: 1, translation: 'Hola' }] };
    expect(isCacheableResult('translate', ok, ['やあ'])).toBe(true);
    expect(isCacheableResult('translate', { items: [] }, ['やあ'])).toBe(false);
    expect(isCacheableResult('translate', { items: [{ n: 1, translation: '   ' }] }, ['やあ'])).toBe(false);
    expect(isCacheableResult('translate', { items: [{ n: 1, translation: 'Lo siento, no puedo ayudar con eso.' }] }, ['やあ'])).toBe(false);
    expect(isCacheableResult('translate', { items: [ok.items[0], { n: 2, translation: '' }] }, ['a', 'b'])).toBe(false);
    expect(isCacheableResult('review', { items: [{ n: 1, final: 'Hola' }] }, ['a'])).toBe(true);
    expect(isCacheableResult('review', { items: [{ n: 1, final: '' }] }, ['a'])).toBe(false);
    expect(isCacheableResult('translate', {}, ['a'])).toBe(false);
  });
});

describe('cola persistente', () => {
  const req = (id: string) => ({ project_id: id, stages: ['analyze', 'translate', 'clean'] as never });

  it('guarda las peticiones en disco: tras un cierre, lo que estaba en cola o en ejecución queda «interrumpido», en orden', async () => {
    const storage = new MemoryStorage();
    const q1 = new ProcessQueue(storage);
    await q1.load();
    const a = await q1.enqueue(req('proyA'));
    const b = await q1.enqueue(req('proyB'));
    await q1.mark(a.id, { state: 'running', job_id: 'j1', started: 1 });

    const q2 = new ProcessQueue(storage);                      // «la app se reinicia»
    const loaded = await q2.load();
    expect(loaded.map((e) => [e.project_id, e.state, e.job_id])).toEqual([['proyA', 'interrupted', null], ['proyB', 'interrupted', null]]);
    expect(q2.pending().map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('no duplica el trabajo: un proyecto con una petición activa devuelve la misma', async () => {
    const q = new ProcessQueue(new MemoryStorage());
    const a = await q.enqueue(req('proyA'));
    const again = await q.enqueue(req('proyA'));
    expect(again.id).toBe(a.id);
    expect(q.list()).toHaveLength(1);
  });

  it('lo terminado no se retoma y el historial está acotado', async () => {
    const storage = new MemoryStorage();
    const q = new ProcessQueue(storage);
    for (let i = 0; i < MAX_FINISHED_KEPT + 10; i += 1) {
      const e = await q.enqueue(req('p' + i));
      await q.mark(e.id, { state: 'done', finished: 1000 + i });
    }
    expect(q.list()).toHaveLength(MAX_FINISHED_KEPT);
    expect(q.pending()).toHaveLength(0);
    const q2 = new ProcessQueue(storage);
    expect((await q2.load()).every((e) => e.state === 'done')).toBe(true);
  });

  it('descarta las peticiones de proyectos que ya no existen y los datos dañados', async () => {
    const storage = new MemoryStorage();
    await storage.putDoc('queue/main', { entries: [{ id: 'q1', project_id: 'ok', stages: ['analyze'], state: 'queued' }, { id: 'q2', project_id: 'borrado', stages: ['analyze'], state: 'queued' }, { basura: true }, null] });
    const q = new ProcessQueue(storage);
    expect((await q.load()).map((e) => e.id)).toEqual(['q1', 'q2']);
    await q.dropProjects(async (id) => id === 'ok');
    expect(q.list().map((e) => e.id)).toEqual(['q1']);
  });

  it('escrituras seguidas no se pisan', async () => {
    const storage = new MemoryStorage();
    const q = new ProcessQueue(storage);
    const es = await Promise.all(Array.from({ length: 8 }, (_, i) => q.enqueue(req('p' + i))));
    await Promise.all(es.map((e) => q.mark(e.id, { state: 'running' })));
    const q2 = new ProcessQueue(storage);
    expect(await q2.load()).toHaveLength(8);
  });
});

describe('memoria', () => {
  const lowMemoryGuard = (lowFor: number) => {
    let n = 0;
    return {
      async check() { return n++ < lowFor ? { action: 'wait' as const, code: 'low_memory' as const, waitMs: 1, message: 'Poca memoria' } : { action: 'ok' as const }; },
      async memory() { return { free_mb: 180, low: true }; },
    };
  };

  it('con poca memoria se sueltan los modelos opcionales de la visión y la tarea TERMINA sin perder páginas', async () => {
    const env = makeEnv(BOOK, {}, lowMemoryGuard(3));
    const p = await seedProject(env, KEYS);
    const t = await process_(env, p);
    expect(env.vision.trims).toBeGreaterThan(0);
    expect(t.timings.chapter.trims).toBeGreaterThan(0);
    expect(t.timings.chapter.min_free_mb).toBe(180);
    expect(t.timings.chapter.plan).toMatch(/memoria/);
    expect((await pagesOf(env, p)).every((g) => g.status === 'cleaned')).toBe(true);
    expect(await translations(env, p)).toEqual([['ES(おはよう)', 'ES(どこへ行くの？)'], ['ES(先輩！)', 'ES(待って)'], ['ES(ありがとう)'], []]);
  });

  it('con memoria baja nunca se solapa, aunque la política lo permita por RAM', async () => {
    const env = makeEnv(BOOK, {}, { async check() { return { action: 'ok' as const }; }, async memory() { return { free_mb: 300, low: true }; } });
    const p = await seedProject(env, KEYS);
    await process_(env, p);
    expect(env.probe.both).toBe(false);
  });

  it('un dispositivo que no informa de la memoria no estropea nada', async () => {
    const env = makeEnv(BOOK, {}, { async check() { return { action: 'ok' as const }; }, async memory() { return null; } });
    const p = await seedProject(env, KEYS);
    const t = await process_(env, p);
    expect(t.timings.chapter.min_free_mb).toBeNull();
    expect(env.vision.trims).toBe(0);
  });

  it('el original nunca se modifica: tras procesar, cada imagen original sigue siendo exactamente la subida', async () => {
    const env = makeEnv(BOOK, {}, lowMemoryGuard(2));
    const p = await seedProject(env, KEYS);
    await process_(env, p);
    for (const g of await pagesOf(env, p)) {
      const key = KEYS[g.index];
      expect(await text(await env.store.image(p.id, g.id, 'original'))).toBe(key);
      // la reconstruida es otra imagen aparte; sin nada que borrar (página sin textos) es una copia del original
      expect(await text(await env.store.image(p.id, g.id, 'clean'))).toBe(g.regions.length ? 'clean:' + key : key);
    }
  });
});

describe('capítulo largo, interrupciones y reanudación', () => {
  const N = 40;

  it(`procesa ${N} páginas sin perder ninguna, con medidas de capítulo coherentes`, async () => {
    const book = longBook(N);
    const env = makeEnv(book);
    const p = await seedProject(env, Object.keys(book));
    const t = await process_(env, p);
    const pages = await pagesOf(env, p);
    expect(pages).toHaveLength(N);
    expect(pages.every((g) => g.status === 'cleaned')).toBe(true);
    // Todos los textos traducidos y ninguno vacío
    expect(pages.every((g) => g.regions.every((r) => r.translation.startsWith('ES(')))).toBe(true);
    expect(t.timings.pages).toHaveLength(N);
    expect(t.timings.chapter.ocr_cache_misses).toBe(N);
    expect(t.timings.chapter.llm_calls).toBeGreaterThanOrEqual(N);   // al menos una llamada por página (sin cachés en la primera pasada)
    expect(t.timings.chapter.total_s).toBeGreaterThan(0);
    // Los originales intactos
    expect(await text(await env.store.image(p.id, pages[17].id, 'original'))).toBe('p18');
  });

  it('cancelar a mitad y reanudar solo hace lo que falta: ni páginas rehechas ni llamadas repetidas', async () => {
    const book = longBook(12);
    const keys = Object.keys(book);
    const env = makeEnv(book);
    const p = await seedProject(env, keys);
    let seen = 0;
    env.llm.hook = () => { if (++seen === 5) env.jobs.cancel(job.id); };
    const job = startRun(env, p.id);
    expect((await waitJob(env, job.id)).status).toBe('cancelled');
    const doneBefore = (await pagesOf(env, p)).filter((g) => g.status === 'cleaned').length;
    expect(doneBefore).toBeGreaterThan(0);
    expect(doneBefore).toBeLessThan(12);
    const callsBefore = env.llm.calls.length;
    const analyzedBefore = env.vision.analyzed.length;

    env.llm.hook = null;
    const t = await process_(env, p);
    expect((await pagesOf(env, p)).every((g) => g.status === 'cleaned')).toBe(true);
    // Lo ya terminado no se rehizo: las llamadas nuevas solo cubren las páginas que faltaban
    expect(env.llm.calls.length - callsBefore).toBeLessThanOrEqual(12 - doneBefore + 1);
    expect(env.vision.analyzed.length - analyzedBefore).toBeLessThanOrEqual(12 - doneBefore + 1);
    expect(t.errors).toBe(0);
  });

  it('con una página dañada, otra rechazada y una vacía, el capítulo acaba entero y el estado es honesto', async () => {
    const book = longBook(8);
    book.p3 = { texts: ['x'], fail: true };
    book.p5 = { texts: [] };
    const env = makeEnv(book);
    env.llm.refuse = (t) => t === 'texto 6-0';
    const keys = Object.keys(book);
    const p = await seedProject(env, keys);
    const job = await waitJob(env, startRun(env, p.id).id);
    expect(job.status).toBe('done');
    const pages = await pagesOf(env, p);
    expect(pages.map((g) => g.status).filter((s) => s === 'error')).toHaveLength(1);
    expect(pages[2].status).toBe('error');
    expect(pages[4].regions).toHaveLength(0);
    // El texto rechazado conserva el original: no se borró del dibujo (no estaba en la lista de borrado)
    const refused = pages[5].regions.find((r) => r.source_text === 'texto 6-0')!;
    expect(refused.flags).toContain('refused');
    expect(refused.flags).toContain('original_kept');
    const erasedHere = env.vision.erased.flat();
    expect(erasedHere).not.toContain(refused.id);
  });

  it('el reproceso del mismo capítulo (otra copia) sale de las cachés: sin OCR ni modelo', async () => {
    const book = longBook(10);
    const keys = Object.keys(book);
    const env = makeEnv(book);
    await process_(env, await seedProject(env, keys));
    const a = env.vision.analyzed.length;
    const c = env.llm.calls.length;
    const copy = await seedProject(env, keys);
    const t = await process_(env, copy);
    expect(env.vision.analyzed.length).toBe(a);
    expect(env.llm.calls.length).toBe(c);
    expect(t.timings.chapter.ocr_cache_hits).toBe(10);
    expect(t.timings.chapter.llm_calls).toBe(0);
    expect((await pagesOf(env, copy)).every((g) => g.status === 'cleaned')).toBe(true);
  });
});

describe('proyectos simultáneos', () => {
  it('dos proyectos pedidos a la vez se procesan uno tras otro en el carril de cálculo, sin mezclar resultados', async () => {
    const env = makeEnv(BOOK);
    const a = await seedProject(env, KEYS);
    const b = await seedProject(env, KEYS);
    const ja = startRun(env, a.id);
    const jb = startRun(env, b.id);
    expect(['queued', 'running']).toContain(env.jobs.get(jb.id)!.status);
    await Promise.all([waitJob(env, ja.id), waitJob(env, jb.id)]);
    expect(env.jobs.get(ja.id)!.status).toBe('done');
    expect(env.jobs.get(jb.id)!.status).toBe('done');
    expect(env.probe.maxVision).toBe(1);
    expect(env.probe.maxLlm).toBe(1);
    expect(await translations(env, a)).toEqual(await translations(env, b));
    for (const proj of [a, b]) expect((await pagesOf(env, proj)).every((g: Page) => g.status === 'cleaned')).toBe(true);
  });
});

describe('hash de caché', () => {
  it('es estable y distingue textos', () => {
    expect(hashText('a')).toBe(hashText('a'));
    expect(hashText('a')).not.toBe(hashText('b'));
    expect(createCaches(new MemoryStorage())).toHaveProperty('translation');
  });
});

// Evita avisos de importaciones solo-tipo no usadas en algunos entornos
void sleep;
export type _Unused = QueueEntry;
