/**
 * Procesamiento completo de un proyecto en el dispositivo: una sola tarea automática, con vista previa por página,
 * pausa/reanudación, recuperación tras interrupciones y coherencia entre páginas.
 */
import { describe, expect, it } from 'vitest';
import type { PageState } from '@starblitz/shared';
import { describeRun } from '../../src/engine/pipeline/runstate';
import { RunState } from '../../src/engine/pipeline/runstate';
import { hasValidTranslation, initialState, iou, planClean, todoFor } from '../../src/engine/pipeline/processor';
import { LANG_NAMES } from '../../src/engine/translate/prompts';
import { makeEnv, pagesOf, seedProject, sleep, startRun, text, waitJob, type FakePage } from './helpers';

const BOOK: Record<string, FakePage> = {
  p1: { texts: ['おはよう', 'どこへ行くの？'] },
  p2: { texts: ['先輩！', '待って'] },
  p3: { texts: ['ありがとう'] },
  p4: { texts: [] }, // página sin texto (ilustración)
};
const KEYS = Object.keys(BOOK);

describe('proyecto completo como una sola tarea', () => {
  it('importa → analiza → traduce → reconstruye todas las páginas sin intervención', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    const progress: number[] = [];
    env.bus.subscribe((e) => { if (e.type === 'job') progress.push(e.job.progress); });

    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('done');
    expect(job.progress).toBe(1);

    const pages = await pagesOf(env, project);
    expect(pages.map((p) => p.status)).toEqual(['cleaned', 'cleaned', 'cleaned', 'cleaned']);
    expect(pages.every((p) => p.has_clean)).toBe(true);
    // Cada texto quedó traducido por el modelo, con la memoria de la obra aplicada
    expect(pages[0].regions.map((r) => r.translation)).toEqual(['ES(おはよう)', 'ES(どこへ行くの？)']);
    expect(pages[0].regions.every((r) => r.status === 'translated' && r.speaker === 'Aiko')).toBe(true);
    expect(pages[3].regions).toEqual([]);
    expect(pages[1].summary).toBe('Resumen de la página 2');
    // La página reconstruida se guardó y el original no se tocó
    expect(await text(await env.store.image(project.id, pages[0].id, 'clean'))).toBe('clean:p1');
    expect(await text(await env.store.image(project.id, pages[0].id, 'original'))).toBe('p1');
    // Memoria de personajes y glosario incorporada una sola vez, sin duplicados
    const fresh = await env.store.get(project.id);
    expect(fresh.glossary.map((g) => g.source)).toEqual(['先輩']);
    expect(fresh.characters.map((c) => c.source)).toEqual(['愛子']);
    // Resumen guardado en el proyecto
    expect(fresh.last_job).toMatchObject({ pages: 4, lines: 5, errors: 0, refused: 0 });
    // El progreso nunca retrocede
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
  });

  it('termina cada página antes de empezar a traducir la siguiente (se puede ver mientras se procesa)', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    const ids = (await env.store.get(project.id)).page_ids;
    const seq = env.events.filter((e): e is Extract<typeof e, { type: 'page' }> => e.type === 'page').map((e) => `${ids.indexOf(e.page_id)}:${e.state}`);
    // La página 0 está «lista» antes de que la 1 empiece a traducirse; la 1 se analizó por adelantado
    expect(seq.indexOf('0:done')).toBeLessThan(seq.indexOf('1:translating'));
    expect(seq.indexOf('1:analyzed')).toBeLessThan(seq.indexOf('0:translating')); // la siguiente se analiza por adelantado
    expect(seq.filter((s) => s.endsWith(':done')).length).toBe(4);
  });

  it('da contexto entre páginas: resumen de lo ocurrido, página anterior ya traducida y siguiente como contexto', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    const translate = env.llm.calls.filter((c) => c.kind === 'translate');
    expect(translate).toHaveLength(3); // la página sin texto no consulta al modelo
    expect(translate[0].user).not.toContain('LO OCURRIDO HASTA AHORA');
    expect(translate[0].user).toContain('PÁGINA SIGUIENTE (2)'); // analizada por adelantado
    expect(translate[0].user).toContain('先輩！');
    expect(translate[1].user).toContain('LO OCURRIDO HASTA AHORA');
    expect(translate[1].user).toContain('p.1: Resumen de la página 1');
    expect(translate[1].user).toContain('おはよう → ES(おはよう)'); // la página anterior, con su traducción
    expect(translate[2].user).toContain('p.2: Resumen de la página 2');
    expect(translate[2].user).toContain('GLOSARIO (obligatorio)'); // lo aprendido en las primeras páginas
    expect(translate[2].user).toContain('先輩 → sempai');
    expect(translate[2].user).toContain('愛子 → Aiko');
  });

  it('el progreso informa de páginas hechas, pendientes y errores, y calcula el tiempo restante', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    let last: Record<string, unknown> = {};
    let eta: number | null = null;
    env.bus.subscribe((e) => { if (e.type === 'job') { last = e.job.detail; if (e.job.eta_s != null) eta = e.job.eta_s; } });
    await waitJob(env, startRun(env, project.id).id);
    expect(last).toMatchObject({ pages_total: 4, pages_done: 4, pages_error: 0, pages_pending: 0 });
    expect(eta === null || eta === 0).toBe(true); // tarea tan corta que no llega a estimar; al terminar es 0
  });
});

describe('pausa, cancelación y recuperación', () => {
  it('pausa al terminar el paso en curso, deja ver lo ya terminado y reanuda sin repetir trabajo', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    const job = startRun(env, project.id);
    let paused = false;
    env.bus.subscribe((e) => {
      if (e.type === 'page' && e.state === 'done' && !paused) { paused = true; env.jobs.pause(job.id); }
    });
    await waitJob(env, job.id, (s) => s === 'paused');
    const mid = await pagesOf(env, project);
    expect(mid[0].status).toBe('cleaned');                       // la primera ya se puede ver y revisar
    expect(mid.filter((p) => p.status === 'cleaned').length).toBeLessThan(4);
    const info = await describeRun(env.store, project.id, true);
    expect(info?.status).toBe('paused');                         // estado guardado: si la app se cierra aquí, se ofrece reanudar
    const analyzedBefore = [...env.vision.analyzed];
    await sleep(60);                                             // en pausa no avanza nada
    expect(env.vision.analyzed).toEqual(analyzedBefore);

    env.jobs.resume(job.id);
    const done = await waitJob(env, job.id);
    expect(done.status).toBe('done');
    expect((await pagesOf(env, project)).map((p) => p.status)).toEqual(['cleaned', 'cleaned', 'cleaned', 'cleaned']);
    expect(env.vision.analyzed.sort()).toEqual([...KEYS].sort()); // cada página se analizó una sola vez
    expect(env.llm.calls.filter((c) => c.kind === 'translate')).toHaveLength(3);
    expect((await describeRun(env.store, project.id, false))?.status).toBe('done');
  });

  it('al cancelar queda guardado dónde iba y «reanudar» solo hace lo que falta', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    const job = startRun(env, project.id);
    let n = 0;
    env.llm.hook = (c) => { if (c.kind === 'translate' && ++n === 2) env.jobs.cancel(job.id); };
    const cancelled = await waitJob(env, job.id);
    expect(cancelled.status).toBe('cancelled');
    const info = await describeRun(env.store, project.id, false);
    expect(info).toMatchObject({ status: 'cancelled', resumable: true, interrupted: false });
    expect(info!.counts.done).toBeGreaterThanOrEqual(1);
    expect(info!.counts.done).toBeLessThan(4);

    env.llm.hook = null;
    const calls = env.llm.calls.length;
    const analyzed = env.vision.analyzed.length;
    const second = await waitJob(env, startRun(env, project.id).id);
    expect(second.status).toBe('done');
    expect((await pagesOf(env, project)).every((p) => p.status === 'cleaned')).toBe(true);
    // Solo se tradujeron las páginas que faltaban (la primera ya estaba hecha)
    expect(env.llm.calls.length - calls).toBeLessThan(3);
    expect(env.vision.analyzed.length - analyzed).toBeLessThanOrEqual(2);
    const first = (await pagesOf(env, project))[0];
    expect(first.regions.map((r) => r.translation)).toEqual(['ES(おはよう)', 'ES(どこへ行くの？)']);
  });

  it('detecta una ejecución interrumpida (app cerrada o batería agotada) y permite retomarla', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    // Se simula lo que queda en disco si el proceso muere a mitad: ejecución «en curso» con dos páginas hechas
    const run = new RunState(env.store, project.id);
    const pages = (await env.store.get(project.id)).page_ids;
    const initial = Object.fromEntries(pages.map((p, i) => [p, (i < 2 ? 'done' : 'pending') as PageState]));
    await run.begin(['analyze', 'translate', 'clean'], pages, initial, false, 'j-muerta');
    await run.flush();
    expect(await describeRun(env.store, project.id, true)).toMatchObject({ status: 'running', interrupted: false });
    const info = await describeRun(env.store, project.id, false);
    expect(info).toMatchObject({ status: 'interrupted', interrupted: true, resumable: true });
    expect(info!.counts).toMatchObject({ total: 4, done: 2, pending: 2 });
  });

  it('una página dañada no detiene la obra: se marca con error y se reintenta después', async () => {
    const book = { ...BOOK, p2: { texts: ['x'], fail: true } };
    const env = makeEnv(book);
    const project = await seedProject(env, KEYS);
    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('done');
    const pages = await pagesOf(env, project);
    expect(pages.map((p) => p.status)).toEqual(['cleaned', 'error', 'cleaned', 'cleaned']);
    expect(pages[1].error).toBe('No se pudo analizar la página.');
    expect(job.detail).toMatchObject({ pages_done: 3, pages_error: 1 });
    expect((await env.store.get(project.id)).last_job).toMatchObject({ errors: 1, error_pages: 1, done_pages: 3 });
    expect(job.progress).toBe(1);

    book.p2.fail = false; // se arregla (p. ej. se reimporta la imagen) y se reanuda: solo se rehace esa página
    const before = env.vision.analyzed.length;
    await waitJob(env, startRun(env, project.id).id);
    expect((await pagesOf(env, project)).map((p) => p.status)).toEqual(['cleaned', 'cleaned', 'cleaned', 'cleaned']);
    expect(env.vision.analyzed.length - before).toBe(1);
  });

  it('con «forzar» repite todo, pero conserva lo aprobado o editado a mano', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    const pg = (await pagesOf(env, project))[0];
    await env.store.updateRegion(project.id, pg.id, pg.regions[0].id, { translation: 'Buenos días a todos' });
    expect((await env.store.getPage(project.id, pg.id)).regions[0].status).toBe('edited');

    env.llm.calls.length = 0;
    await waitJob(env, startRun(env, project.id, { force: true }).id);
    const again = (await pagesOf(env, project))[0];
    expect(again.regions[0].translation).toBe('Buenos días a todos'); // lo editado sobrevive a la nueva pasada
    expect(again.regions[0].status).toBe('edited');
    expect(again.regions[1].translation).toBe('ES(どこへ行くの？)');
    const first = env.llm.calls.find((c) => c.kind === 'translate')!;
    expect(first.user).toContain('Ya traducidos y aprobados por el usuario');
    expect(first.user).toContain('おはよう → Buenos días a todos'); // se usa como contexto, no se retraduce
    expect(first.user).not.toMatch(/^\[1\] \(.*\) おはよう$/m);
  });
});

describe('idioma, modelo y rechazos', () => {
  it('detecta solo el idioma del original, ajusta el sentido de lectura y lo usa al traducir', async () => {
    const env = makeEnv(BOOK);
    env.vision.lang = 'en';
    const project = await seedProject(env, KEYS, { source_lang: 'auto' });
    expect(project.reading_direction).toBe('rtl');
    await waitJob(env, startRun(env, project.id).id);
    expect(env.vision.detectCalls).toBe(1);
    expect(env.vision.detectSample).toBe(4);
    const fresh = await env.store.get(project.id);
    expect(fresh.detected_lang).toBe('en');
    expect(fresh.reading_direction).toBe('ltr');
    expect(env.llm.calls[0].user).toContain(`Idioma original: ${LANG_NAMES.en}`);
    expect((await describeRun(env.store, project.id, false))?.language).toBe('en');
  });

  it('no vuelve a detectar el idioma al reanudar ni cuando la persona lo eligió', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS); // idioma elegido: japonés
    await waitJob(env, startRun(env, project.id).id);
    expect(env.vision.detectCalls).toBe(0);
    expect(env.llm.calls[0].user).toContain(`Idioma original: ${LANG_NAMES.ja}`);
  });

  it('un rechazo del modelo no se guarda como traducción: queda marcado para revisión', async () => {
    const env = makeEnv(BOOK);
    env.llm.refuse = (t) => t === '待って';
    const project = await seedProject(env, KEYS);
    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('done');
    const r = (await pagesOf(env, project))[1].regions[1];
    expect(r.translation).toBe('');
    expect(r.flags).toContain('refused');
    expect(r.status).toBe('review');
    expect((await env.store.get(project.id)).last_job).toMatchObject({ refused: 1 });
  });

  it('sin modelo instalado la tarea falla con una indicación clara y no estropea las páginas', async () => {
    const env = makeEnv(BOOK);
    env.library.models = [];
    const project = await seedProject(env, KEYS);
    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('Todavía no hay ningún modelo de traducción instalado');
    expect((await pagesOf(env, project)).every((p) => p.status === 'imported')).toBe(true);
    expect(await describeRun(env.store, project.id, false)).toMatchObject({ status: 'error', resumable: true });
  });

  it('si el motor de lenguaje no responde, explica qué pasa y conserva el análisis ya hecho', async () => {
    const env = makeEnv(BOOK);
    env.llm.healthy = false;
    const project = await seedProject(env, KEYS);
    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('error');
    expect(job.error).toContain('motor de lenguaje integrado no está listo');
    // Instalado/arreglado el modelo, se reanuda
    env.llm.healthy = true;
    const ok = await waitJob(env, startRun(env, project.id).id);
    expect(ok.status).toBe('done');
  });

  it('usa el modelo elegido y envía la imagen solo si el dispositivo, los ajustes y el modelo lo permiten', async () => {
    const env = makeEnv(BOOK);
    env.library.models = [{ ...env.library.models[0], vision: true }];
    // Móvil con 8 GB: el perfil de gama media no usa visión en el modelo de lenguaje por defecto
    expect(await env.processor.useVision()).toBe(await env.processor.profile().then((p) => p.vision_llm));
    const withVision = (await env.processor.profile()).vision_llm;
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    expect(env.llm.calls.some((c) => c.images > 0)).toBe(withVision);
  });
});

describe('edición manual', () => {
  it('relee un área y crea un texto nuevo respetando el orden de lectura', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    const pg = (await pagesOf(env, project))[0];
    const added = await env.processor.reocrRegion(project.id, pg.id, null, [5, 5, 300, 400]);
    expect(added.bbox).toEqual([5, 5, 200, 300]); // se ajusta a la página
    expect(added.order).toBe(2);
    const fixed = await env.processor.reocrRegion(project.id, pg.id, pg.regions[0].id, [20, 20, 120, 100]);
    const after = await env.store.getPage(project.id, pg.id);
    expect(after.regions).toHaveLength(3);
    expect(fixed.id).toBe(pg.regions[0].id);
    expect(after.regions[0].source_text).toBe('leído:20,20,120,100');
  });

  it('retraduce solo los textos pedidos con el contexto de su página', async () => {
    const env = makeEnv(BOOK);
    const project = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, project.id).id);
    const pg = (await pagesOf(env, project))[1];
    await env.store.updateRegion(project.id, pg.id, pg.regions[0].id, { translation: 'A mano' });
    env.llm.calls.length = 0;
    const out = await env.processor.translateSingle(project.id, pg.id, [pg.regions[1].id]);
    expect(out.map((r) => r.id)).toEqual([pg.regions[1].id]);
    const after = await env.store.getPage(project.id, pg.id);
    expect(after.regions[0].translation).toBe('A mano');
    expect(after.regions[1].translation).toBe('ES(待って)');
    expect(env.llm.calls[0].user).toContain('PÁGINA ANTERIOR (1)');
  });
});

describe('utilidades de planificación', () => {
  it('calcula qué etapas faltan en cada página', () => {
    const page = (status: string) => ({ status }) as never;
    const all = ['analyze', 'translate', 'clean'];
    expect(todoFor(page('imported'), all, false)).toEqual(all);
    expect(todoFor(page('error'), all, false)).toEqual(all);
    expect(todoFor(page('analyzed'), all, false)).toEqual(['translate', 'clean']);
    expect(todoFor(page('translated'), all, false)).toEqual(['clean']);
    expect(todoFor(page('cleaned'), all, false)).toEqual([]);
    expect(todoFor(page('cleaned'), all, true)).toEqual(all);
    expect(todoFor(page('imported'), ['analyze'], false)).toEqual(['analyze']);
    expect(initialState(page('cleaned'), [])).toBe('done');
    expect(initialState(page('error'), [])).toBe('error');
    expect(initialState(page('imported'), [])).toBe('pending');
  });

  it('IoU de cajas', () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3, 5);
  });
});


describe('integridad de los diálogos: nunca se borra el original sin una traducción válida', () => {
  const PAGE: Record<string, FakePage> = { p1: { texts: ['おはよう', '待って', 'ありがとう'] } };

  it('si el modelo rechaza un texto, ese globo conserva el original y queda marcado; los demás se reconstruyen', async () => {
    const env = makeEnv(PAGE);
    env.llm.refuse = (t) => t === '待って';
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id).id);
    const [page] = await pagesOf(env, project);
    const refused = page.regions.find((r) => r.source_text === '待って')!;
    expect(refused.translation).toBe('');
    expect(refused.flags).toEqual(expect.arrayContaining(['refused', 'original_kept']));
    expect(refused.status).toBe('review');
    // El borrado solo se pidió para los textos con traducción válida
    expect(env.vision.erased.at(-1)).toEqual(page.regions.filter((r) => r.source_text !== '待って').map((r) => r.id));
    expect(env.vision.erased.at(-1)).not.toContain(refused.id);
    expect((await env.store.get(project.id)).last_job).toMatchObject({ preserved: 1, refused: 1 });
  });

  it('si el modelo no devuelve traducción para un texto, tampoco se borra', async () => {
    const env = makeEnv(PAGE);
    const llm = env.llm as unknown as { chat: (m: unknown, s: unknown) => Promise<string> };
    const original = llm.chat.bind(env.llm);
    // Quita del resultado el elemento n.º 2: el modelo «olvida» ese texto
    llm.chat = async (m: unknown, s: unknown) => {
      const raw = JSON.parse(await original(m, s)) as { items: { n: number }[] };
      raw.items = raw.items.filter((i) => i.n !== 2);
      return JSON.stringify(raw);
    };
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id).id);
    const [page] = await pagesOf(env, project);
    const lost = page.regions[1];
    expect(lost.translation).toBe('');
    expect(lost.flags).toEqual(expect.arrayContaining(['untranslated', 'original_kept']));
    expect(env.vision.erased.at(-1)).not.toContain(lost.id);
    expect(env.vision.erased.at(-1)).toHaveLength(2);
  });

  it('sin traducir nada (solo analizar y reconstruir) no se borra ningún texto', async () => {
    const env = makeEnv(PAGE);
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id, { stages: ['analyze', 'clean'] }).id);
    expect(env.vision.erased.flat()).toEqual([]); // ni siquiera se invoca el borrado
    const [page] = await pagesOf(env, project);
    expect(page.regions.every((r) => r.flags.includes('original_kept'))).toBe(true);
    expect(page.has_clean).toBe(true); // la página limpia es una copia íntegra del original
  });

  it('si la traducción no cabe en el globo se conserva el original (y se marca «no cabe»)', async () => {
    const env = makeEnv(PAGE, {}, undefined, (r) => r.source_text !== 'ありがとう');
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id).id);
    const [page] = await pagesOf(env, project);
    const long = page.regions.find((r) => r.source_text === 'ありがとう')!;
    expect(long.translation).toBe('ES(ありがとう)'); // la traducción se conserva para que la persona la acorte
    expect(long.flags).toEqual(expect.arrayContaining(['no_fit', 'original_kept']));
    expect(long.status).toBe('review');
    expect(env.vision.erased.at(-1)).not.toContain(long.id);
  });

  it('lo aprobado o editado a mano manda: se borra aunque no pase la validación automática', async () => {
    const env = makeEnv(PAGE);
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id).id);
    const [page] = await pagesOf(env, project);
    await env.store.mutate(project.id, async () => {
      const fresh = await env.store.getPage(project.id, page.id);
      fresh.regions[0].status = 'approved';
      await env.store.savePage(project.id, fresh);
    });
    const cur = await env.store.getPage(project.id, page.id);
    // con una validación de ajuste que lo rechaza todo, solo el aprobado se borra
    expect(planClean(cur, () => false).erase.map((r) => r.id)).toEqual([cur.regions[0].id]);
  });

  it('al reconstruir de nuevo se recalcula: una vez corregida la traducción, el texto vuelve a borrarse', async () => {
    const env = makeEnv(PAGE);
    env.llm.refuse = (t) => t === '待って';
    const project = await seedProject(env, ['p1']);
    await waitJob(env, startRun(env, project.id).id);
    let [page] = await pagesOf(env, project);
    const target = page.regions.find((r) => r.source_text === '待って')!;
    await env.store.mutate(project.id, async () => {
      const fresh = await env.store.getPage(project.id, page.id);
      const r = fresh.regions.find((x) => x.id === target.id)!;
      r.translation = '¡Espera!'; r.status = 'edited';
      await env.store.savePage(project.id, fresh);
    });
    const cur = await env.store.getPage(project.id, page.id);
    await env.processor.cleanPage(await env.store.get(project.id), cur);
    [page] = await pagesOf(env, project);
    const fixed = page.regions.find((r) => r.id === target.id)!;
    expect(fixed.flags).not.toContain('original_kept');
    expect(env.vision.erased.at(-1)).toContain(target.id);
  });

  it('hasValidTranslation: vacía, negativa del modelo o «sin traducir» no valen; una traducción normal sí', () => {
    const base = { source_text: '待って', flags: [] as string[] };
    expect(hasValidTranslation({ ...base, translation: '' })).toBe(false);
    expect(hasValidTranslation({ ...base, translation: '   ' })).toBe(false);
    expect(hasValidTranslation({ ...base, translation: 'Lo siento, no puedo ayudar con eso.' })).toBe(false);
    expect(hasValidTranslation({ ...base, translation: '¡Espera!', flags: ['refused'] })).toBe(false);
    expect(hasValidTranslation({ ...base, translation: '¡Espera!', flags: ['untranslated'] })).toBe(false);
    expect(hasValidTranslation({ ...base, translation: '¡Espera!' })).toBe(true);
  });
});

describe('medición por etapa', () => {
  it('guarda los segundos de análisis, traducción y reconstrucción de cada página', async () => {
    const env = makeEnv({ p1: { texts: ['おはよう'] }, p2: { texts: ['先輩！'] } });
    const project = await seedProject(env, ['p1', 'p2']);
    await waitJob(env, startRun(env, project.id).id);
    const t = (await env.store.get(project.id)).last_job as { timings: { analyze_s: number; translate_s: number; clean_s: number; pages: { page: number; regions: number }[] } };
    expect(t.timings.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(t.timings.pages.every((p) => p.regions === 1)).toBe(true);
    for (const k of ['analyze_s', 'translate_s', 'clean_s'] as const) expect(t.timings[k]).toBeGreaterThanOrEqual(0);
  });
});
