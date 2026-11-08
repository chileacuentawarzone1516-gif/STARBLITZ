/**
 * Traducción en texto plano por lotes de página (modelos dedicados: PLaMo 3 Translate, Hy-MT2).
 * Con modelo SIMULADO: verifica el protocolo (qué se pide, qué se reutiliza, qué se reintenta, qué se conserva), no la calidad real.
 */
import { describe, expect, it } from 'vitest';
import type { Page, Project } from '@starblitz/shared';
import { PlainTranslator, buildPlainRequest, isCacheablePlain, isDedicatedMt, mtFamily, parsePlain } from '../../src/engine/translate/plain';
import { SPANISH, fakeModel, makeEnv, pagesOf, seedProject, startRun, waitJob, type Env, type FakePage } from './helpers';

const BOOK: Record<string, FakePage> = {
  p1: { texts: ['おはよう', 'どこへ行くの？', 'ありがとう'] },
  p2: { texts: ['先輩！', '待って'] },
};
const KEYS = Object.keys(BOOK);

/** Entorno con un modelo dedicado instalado (así `translatorFor` elige el traductor de texto plano). */
function plainEnv(modelId = 'plamo-3-translate-0.8b-q4km', pages: Record<string, FakePage> = BOOK): Env {
  const env = makeEnv(pages);
  env.library.models = [fakeModel(modelId)];
  return env;
}

async function analyzed(env: Env, keys = KEYS): Promise<{ project: Project; pages: Page[] }> {
  const project = await seedProject(env, keys);
  await waitJob(env, startRun(env, project.id, { stages: ['analyze'] }).id);
  return { project: await env.store.get(project.id), pages: await pagesOf(env, project) };
}

describe('familias de modelo', () => {
  it('reconoce los modelos dedicados por id, repositorio o archivo; el resto usa el traductor contextual', () => {
    expect(mtFamily('pfnet/plamo-3-translate-0.8b-GGUF')).toBe('plamo');
    expect(mtFamily('plamo-3-translate-2b-q4km')).toBe('plamo');
    expect(mtFamily('tencent/Hy-MT2-1.8B-GGUF Hy-MT2-1.8B-Q4_K_M.gguf')).toBe('hymt');
    expect(mtFamily('HY-MT1.5-1.8B')).toBe('hymt');
    expect(mtFamily('qwen3.5-4b-q4km')).toBe('generic');
    expect(mtFamily('plamo-2-translate')).toBe('generic'); // otra generación: otro formato, no se asume
    expect(isDedicatedMt('hy-mt2')).toBe(true);
    expect(isDedicatedMt('gemma4-e2b')).toBe(false);
  });
});

describe('construcción de la petición (formato nativo de cada familia)', () => {
  const base = { lang: 'ja', texts: ['おはよう', '待って'], glossary: [{ source: '先輩', target: 'senpai' }], history: [], batch: true };

  it('PLaMo: textos separados por línea, idioma y glosario en chat_template_kwargs, historial como mensajes usuario/asistente', () => {
    const r = buildPlainRequest('plamo', { ...base, history: [{ source: 'やあ', target: 'Hola' }] });
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.messages[2].content).toBe('おはよう\n待って');
    expect(r.extra.chat_template_kwargs).toEqual({ target_lang: 'es', source_lang: 'ja', glossary: [{ source: '先輩', target: 'senpai' }] });
    expect(r.extra.stop).toContain('<|plamo:tag|>');
  });

  it('PLaMo: un idioma de origen que no admite se deja sin indicar (lo detecta el modelo)', () => {
    const r = buildPlainRequest('plamo', { ...base, lang: 'es', glossary: [] });
    expect(r.extra.chat_template_kwargs).toEqual({ target_lang: 'es' });
  });

  it('Hy-MT2: instrucción nativa, terminología de referencia y líneas numeradas sin censura', () => {
    const r = buildPlainRequest('hymt', base);
    const u = r.messages[0].content;
    expect(r.messages).toHaveLength(1);
    expect(u).toContain('Reference the following translations:\n先輩 translates to senpai');
    expect(u).toContain('[1] おはよう\n[2] 待って');
    expect(u).toMatch(/Do not soften or censor/);
    expect(buildPlainRequest('hymt', { ...base, texts: ['おはよう'], batch: false }).messages[0].content).toMatch(/Translate the following text into Spanish[\s\S]*おはよう$/);
  });

  it('modelo genérico: instrucción de fidelidad total, glosario y variante de español', () => {
    const r = buildPlainRequest('generic', { ...base, variant: 'es-ES' });
    expect(r.messages[0].role).toBe('system');
    expect(r.messages[0].content).toMatch(/sin suavizar/);
    expect(r.messages[0].content).toContain('先輩 => senpai');
    expect(r.messages[0].content).toContain('España');
  });

  it('el límite de tokens de salida crece con el texto y está acotado', () => {
    expect(buildPlainRequest('plamo', { ...base, texts: ['a'] }).maxTokens).toBeLessThan(buildPlainRequest('plamo', { ...base, texts: Array(30).fill('あ'.repeat(40)) }).maxTokens);
    expect(buildPlainRequest('plamo', { ...base, texts: Array(200).fill('あ'.repeat(80)) }).maxTokens).toBe(2048);
  });
});

describe('lectura de la respuesta', () => {
  it('con líneas numeradas, lo que falta queda vacío y no se adivina', () => {
    expect(parsePlain('hymt', '[1] Hola\n[3] Adiós', 3, true)).toEqual(['Hola', '', 'Adiós']);
    expect(parsePlain('generic', '1. Hola\n2) Qué tal', 2, true)).toEqual(['Hola', 'Qué tal']);
  });
  it('PLaMo: si el número de líneas no coincide no se sabe cuál es cuál: todo queda por reintentar', () => {
    expect(parsePlain('plamo', 'Hola\nQué tal', 2, true)).toEqual(['Hola', 'Qué tal']);
    expect(parsePlain('plamo', 'Hola Qué tal', 2, true)).toEqual(['', '']);
    expect(parsePlain('plamo', 'Hola\n\nQué tal\nextra', 2, true)).toEqual(['', '']);
  });
  it('un solo texto: se devuelve entero y se ignora el razonamiento <think>', () => {
    expect(parsePlain('hymt', '<think>pienso</think>Hola', 1, false)).toEqual(['Hola']);
  });
  it('solo se guarda en caché lo completo y sano', () => {
    expect(isCacheablePlain(['Hola', 'Adiós'], ['やあ', 'さらば'])).toBe(true);
    expect(isCacheablePlain(['Hola', ''], ['やあ', 'さらば'])).toBe(false);
    expect(isCacheablePlain(['Lo siento, no puedo ayudar con eso.'], ['やあ'])).toBe(false);
    expect(isCacheablePlain(['Hola'], ['やあ', 'さらば'])).toBe(false);
  });
});

describe('traducción de una página', () => {
  it('traduce todos los globos de la página en UNA llamada de texto plano, sin metadatos inventados', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    expect(tr).toBeInstanceOf(PlainTranslator);
    const res = await tr.translatePage(project, pages[0], { prevPage: null, nextPage: pages[1], story: [], imageJpeg: null });
    expect(env.llm.plainCalls).toHaveLength(1);
    expect(env.llm.calls).toHaveLength(0);                                  // ninguna llamada con JSON/esquema
    expect(res.updated.map((r) => r.translation)).toEqual(['Buenos días', '¿Adónde vas?', 'Gracias']);
    expect(res.updated.every((r) => r.status === 'translated' && r.speaker === '' && r.flags.length === 0)).toBe(true);
    expect(res.newTerms).toEqual([]);
    expect(res.characters).toEqual([]);
    expect(tr.stats.llm_calls).toBe(1);
  });

  it('si falta una línea, solo esa se vuelve a pedir (una llamada extra), y nunca se omite en silencio', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    let first = true;
    env.llm.plainReply = (messages) => {
      if (!first) return null;
      first = false;
      const lines = messages[messages.length - 1].content.split('\n');
      return [lines[0], lines[2]].map((l) => `ES(${l})`).join('\n'); // el modelo «se come» una línea → 2 de 3 (no coincide)
    };
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    const res = await tr.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(res.updated.map((r) => r.translation)).toEqual(['Buenos días', '¿Adónde vas?', 'Gracias']);
    expect(env.llm.plainCalls.length).toBe(1 + 3);                          // el lote + los 3 textos (PLaMo no puede asignar líneas si el recuento no cuadra)
  });

  it('con Hy-MT2 (líneas numeradas), una línea ausente se reintenta ella sola', async () => {
    const env = plainEnv('hy-mt2-1.8b-q4km');
    const { project, pages } = await analyzed(env);
    let first = true;
    env.llm.plainReply = (messages) => {
      if (!first) return null;
      first = false;
      return messages[messages.length - 1].content.split('\n').filter((l) => /^\[(1|3)\] /.test(l))
        .map((l) => { const m = /^\[(\d)\] (.*)$/.exec(l)!; return `[${m[1]}] ${SPANISH[m[2]] ?? m[2]}`; }).join('\n');
    };
    const tr = await env.processor.translatorFor('hy-mt2-1.8b-q4km');
    const res = await tr.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(res.updated.map((r) => r.translation)).toEqual(['Buenos días', '¿Adónde vas?', 'Gracias']);
    expect(env.llm.plainCalls.length).toBe(2);                              // lote + solo la línea 2
    expect(res.updated[1].confidence).toBeLessThan(res.updated[0].confidence);
  });

  it('una negativa del modelo no se guarda como traducción: se reintenta y, si persiste, queda marcada para revisión', async () => {
    const env = plainEnv('hy-mt2-1.8b-q4km');
    env.llm.refusePlain = (t) => t === '待って';
    const { project, pages } = await analyzed(env);
    const tr = await env.processor.translatorFor('hy-mt2-1.8b-q4km');
    const res = await tr.translatePage(project, pages[1], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    const refused = res.updated.find((r) => r.source_text === '待って')!;
    expect(refused.translation).toBe('');
    expect(refused.flags).toContain('refused');
    expect(refused.status).toBe('review');
    expect(res.updated.find((r) => r.source_text === '先輩！')!.translation).toBe('¡Senpai!');
  });

  it('una respuesta vacía deja el texto «sin traducir» y en revisión (nunca una traducción vacía aceptada)', async () => {
    const env = plainEnv('hy-mt2-1.8b-q4km');
    env.llm.plainReply = () => '';
    const { project, pages } = await analyzed(env);
    const tr = await env.processor.translatorFor('hy-mt2-1.8b-q4km');
    const res = await tr.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(res.updated.every((r) => r.flags.includes('untranslated') && r.status === 'review' && r.translation === '')).toBe(true);
  });

  it('caracteres del idioma original en la traducción → a revisión; lo aprobado a mano no se vuelve a traducir', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    pages[0].regions[1].status = 'approved';
    pages[0].regions[1].translation = 'A mano';
    env.llm.plainReply = (messages) => messages[messages.length - 1].content.split('\n').map((l, i) => (i === 0 ? 'Hola 오' : `ES(${l})`)).join('\n');
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    const res = await tr.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(res.updated).toHaveLength(2);                                    // la región aprobada no entra
    expect(res.updated[0].status).toBe('review');
    expect(res.updated[0].flags).toContain('ambiguous');
    expect(res.updated[0].translation).toBe('Hola 오');                      // se conserva lo que dijo el modelo, solo se marca
  });
});

describe('contexto: glosario e historial', () => {
  it('envía solo los términos del glosario que aparecen en la página (y personajes con nombre fijado)', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    project.glossary = [{ source: '先輩', target: 'senpai', note: '', locked: true }, { source: '魔王', target: 'Rey Demonio', note: '', locked: true }];
    project.characters = [{ source: 'おはよう', target: 'Buenos días (apodo)', gender: '?', speech: '', locked: true }];
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    await tr.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    const kw = env.llm.plainCalls[0].extra.chat_template_kwargs as { glossary: { source: string }[] };
    expect(kw.glossary.map((g) => g.source)).toEqual(['おはよう']);        // 先輩 y 魔王 no están en esta página
    await tr.translatePage(project, pages[1], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    const kw2 = env.llm.plainCalls[1].extra.chat_template_kwargs as { glossary: { source: string }[] };
    expect(kw2.glossary.map((g) => g.source)).toEqual(['先輩']);
  });

  it('con PLaMo, los últimos diálogos ya traducidos de la página anterior van como historial (coherencia entre páginas)', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    pages[0].regions.forEach((r) => { r.translation = `T:${r.source_text}`; });
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    await tr.translatePage(project, pages[1], { prevPage: pages[0], nextPage: null, story: [], imageJpeg: null });
    const msgs = env.llm.plainCalls[0].messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[1].content).toBe('T:おはよう');
    expect(msgs[msgs.length - 1].content).toBe('先輩！\n待って');
  });

  it('el historial no incluye textos rechazados ni sin traducir', async () => {
    const env = plainEnv();
    const { project, pages } = await analyzed(env);
    pages[0].regions[0].translation = 'Bien';
    pages[0].regions[1].translation = '';
    pages[0].regions[2].translation = 'Roto';
    pages[0].regions[2].flags = ['refused'];
    const tr = await env.processor.translatorFor('plamo-3-translate-0.8b-q4km');
    await tr.translatePage(project, pages[1], { prevPage: pages[0], nextPage: null, story: [], imageJpeg: null });
    expect(env.llm.plainCalls[0].messages.map((m) => m.content)).toEqual(['おはよう', 'Bien', '先輩！\n待って']);
  });
});

describe('caché de traducciones de texto plano', () => {
  it('el mismo lote con el mismo contexto no se vuelve a pedir; una respuesta incompleta no se guarda', async () => {
    const env = plainEnv('hy-mt2-1.8b-q4km');
    const { project, pages } = await analyzed(env);
    const make = () => env.processor.translatorFor('hy-mt2-1.8b-q4km', undefined, { cache: true });
    const a = await make();
    await a.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(env.llm.plainCalls).toHaveLength(1);
    const b = await make();
    const res = await b.translatePage(project, pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(env.llm.plainCalls).toHaveLength(1);                             // cero llamadas nuevas
    expect(b.stats).toEqual({ llm_calls: 0, cache_hits: 1 });
    expect(res.updated.map((r) => r.translation)).toEqual(['Buenos días', '¿Adónde vas?', 'Gracias']);

    // Lote incompleto: el lote NO se guarda; las líneas pedidas de una en una (completas y sanas) sí.
    const env2 = plainEnv('hy-mt2-1.8b-q4km');
    const x = await analyzed(env2);
    let n = 0;
    env2.llm.plainReply = () => (++n === 1 ? '[1] Una sola' : null);
    const keys = async () => (await env2.storage.listDocKeys('cache/tr/')).filter((k) => !k.endsWith('_index')).length;
    const t1 = await env2.processor.translatorFor('hy-mt2-1.8b-q4km', undefined, { cache: true });
    await t1.translatePage(x.project, x.pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(await keys()).toBe(2);                                           // solo las 2 líneas reintentadas
    const t2 = await env2.processor.translatorFor('hy-mt2-1.8b-q4km', undefined, { cache: true });
    const r2 = await t2.translatePage(x.project, x.pages[0], { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    expect(t2.stats).toEqual({ llm_calls: 1, cache_hits: 0 });             // el lote incompleto NO estaba guardado: se vuelve a pedir (y ahora viene completo)
    expect(r2.updated.map((r) => r.translation)).toEqual(['Buenos días', '¿Adónde vas?', 'Gracias']);
    expect(await keys()).toBe(3);                                           // ahora sí se guarda el lote completo
  });
});

describe('capítulo completo con un modelo dedicado', () => {
  it('procesa, traduce y reconstruye todo sin llamadas con JSON, conserva el original donde no hay traducción válida', async () => {
    const env = plainEnv('hy-mt2-1.8b-q4km', { p1: { texts: ['おはよう', '待って'] }, p2: { texts: ['先輩！'] }, p3: { texts: ['ありがとう', 'さようなら'] } });
    env.llm.refusePlain = (t) => t === '待って';
    const p = await seedProject(env, ['p1', 'p2', 'p3']);
    const job = await waitJob(env, startRun(env, p.id).id);
    expect(job.status).toBe('done');
    expect(env.llm.calls).toHaveLength(0);                                  // 0 llamadas JSON
    const pages = await pagesOf(env, p);
    expect(pages.every((g) => g.status === 'cleaned')).toBe(true);
    const refused = pages[0].regions.find((r) => r.source_text === '待って')!;
    expect(refused.translation).toBe('');
    expect(refused.flags).toContain('original_kept');                       // no se borró del dibujo
    expect(env.vision.erased.flat()).not.toContain(refused.id);
    expect(pages[2].regions.map((r) => r.translation)).toEqual(['Gracias', 'Adiós']);
    const t = (await env.store.get(p.id)).last_job as { timings: { chapter: { llm_calls: number } } };
    expect(t.timings.chapter.llm_calls).toBeLessThanOrEqual(3 + 2);         // ≈ una por página (+ reintentos de lo rechazado)
  });

  it('un modelo que no es dedicado sigue usando el traductor contextual (no cambia el comportamiento por defecto)', async () => {
    const env = makeEnv(BOOK);
    const p = await seedProject(env, KEYS);
    await waitJob(env, startRun(env, p.id).id);
    expect(env.llm.plainCalls).toHaveLength(0);
    expect(env.llm.calls.length).toBeGreaterThan(0);
  });
});
