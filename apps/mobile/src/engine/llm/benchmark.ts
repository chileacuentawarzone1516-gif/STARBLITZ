/**
 * «Comparar modelos»: traduce las mismas frases con cada modelo instalado y mide la carga y la velocidad
 * (equivalente a `llm/benchmark.py`). La calidad de una traducción literaria no se puede puntuar automáticamente de
 * forma fiable; por eso se muestran las salidas una al lado de otra y la velocidad real en este teléfono.
 */
import type { CompareResult, Page, Project } from '@starblitz/shared';
import { AppError, CancelledError } from '../core/errors';
import { defaultStyle, newPage, newProject, newRegion } from '../core/schema';
import { BuiltinClient } from '../translate/llm';
import type { ContextualTranslator } from '../translate/contextual';
import { SAMPLES } from './samples';

/** Proyecto y página sintéticos con `lines` como textos, para probar un modelo sin tocar proyectos reales. */
export function makeProbe(lang: string, lines: string[]): { project: Project; page: Page } {
  const project = newProject({
    id: 'probe', name: 'Prueba de modelo', source_lang: lang, target_variant: 'es-419', reading_direction: 'rtl', direction_auto: false,
    honorifics: 'adapt', sfx: 'keep',
  });
  project.page_ids = ['probe-page'];
  const page = newPage({ id: 'probe-page', index: 0, filename: 'probe', ext: 'png', width: 100, height: 100, sha1: '', dhash: '0', duplicate_of: null });
  page.regions = lines.map((text, i) => newRegion({
    id: `r${i}`, order: i, kind: 'dialogue', bbox: [0, 0, 100, 100], lines: [], vertical: false, line_size: 16, bubble: null,
    layout_box: [0, 0, 100, 100], source_text: text, ocr_confidence: 1, ocr_engine: 'probe', max_chars: Math.max(40, text.length * 3),
    style: defaultStyle(), erase: true, render: true,
  }));
  return { project, page };
}

export async function compareModels(
  ids: string[], make: (id: string) => Promise<ContextualTranslator>, progress: (fraction: number, message: string) => void,
  signal: AbortSignal, langs: readonly string[] = ['ja', 'en'],
): Promise<CompareResult> {
  const models: CompareResult['models'] = [];
  const steps = Math.max(1, ids.length * langs.length);
  let step = 0;
  for (const id of ids) {
    const entry: CompareResult['models'][number] = { id, load_s: null, languages: {}, error: '' };
    try {
      const translator = await make(id);
      const t0 = performance.now();
      progress(step / steps, `Cargando ${id}`);
      await translator.client.warmUp(id, signal);
      entry.load_s = Math.round((performance.now() - t0) / 100) / 10;
      for (const lang of langs) {
        if (signal.aborted) throw new CancelledError();
        progress(step / steps, `${id}: traduciendo frases de prueba (${lang})`);
        const { project, page } = makeProbe(lang, SAMPLES[lang]);
        const t1 = performance.now();
        const result = await translator.translatePage(project, page, { prevPage: null, nextPage: null, story: [], imageJpeg: null, signal });
        const seconds = (performance.now() - t1) / 1000;
        const tps = translator.client instanceof BuiltinClient ? translator.client.lastStats.tps : 0;
        entry.languages[lang] = {
          seconds: Math.round(seconds * 10) / 10, tokens_per_s: tps,
          items: result.updated.map((r) => ({ source: r.source_text, translation: r.translation, flags: r.flags, confidence: r.confidence })),
        };
        step += 1;
      }
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (!(e instanceof AppError)) throw e;
      entry.error = e.message;
      step += langs.length - Object.keys(entry.languages).length;
    }
    models.push(entry);
  }
  progress(1, 'Comparación terminada');
  return { models, samples: Object.fromEntries(langs.map((l) => [l, SAMPLES[l]])) };
}
