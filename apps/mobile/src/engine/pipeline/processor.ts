/**
 * Orquestación del procesamiento: un proyecto completo como una sola tarea automática (equivalente a
 * `pipeline/processor.py`).
 *
 * Cada página recorre «analizar → traducir → reconstruir» y queda terminada antes de pasar a la siguiente (se puede
 * ver y revisar mientras el resto se procesa). Para que la traducción tenga contexto, la página siguiente se analiza
 * una vez por adelantado. Las etapas son idempotentes y el estado de cada página se guarda: una tarea cancelada,
 * pausada o interrumpida se reanuda sin repetir trabajo, y los textos aprobados o editados nunca se sobrescriben.
 */
import { currentProfile, resolveModel } from '@starblitz/shared';
import type { BBox, Page, PageState, PerformanceProfile, Project, Region, Settings } from '@starblitz/shared';
import {
  AppError, CancelledError, LLMUnavailableError, ModelMissingError, NotFoundError,
} from '../core/errors';
import type { EventBus } from '../core/events';
import type { JobContext } from '../core/jobs';
import { AUTO_LANG, effectiveLang, now } from '../core/schema';
import { directionFor } from '../vision/langid';
import type { ProjectStore } from '../store/projects';
import { ContextualTranslator, isRefusal, mergeMemory, type PageTranslator } from '../translate/contextual';
import { PlainTranslator, mtFamily } from '../translate/plain';
import { BLOCKED_MODEL_MESSAGE, isBlockedModel } from '@starblitz/shared';
import { createClient, type ClientConfig, type LLMClient } from '../translate/llm';
import type { LlmRuntime } from '../translate/runtime';
import type { AnalysisStats, DeviceGuard, DeviceProvider, DeviceSample, ModelLibrary, VisionPort } from './ports';
import { analysisKey, type CachedAnalysis, type PipelineCaches } from './cache';
import { planConcurrency, type ConcurrencyPlan, type ConcurrencyPolicy } from './governor';
import { ThermalPacer, type PacerStats } from '../device/pacer';
import { RunState, STAGE_WEIGHT } from './runstate';

export const STAGES = ['analyze', 'translate', 'clean'] as const;
export const LANG_SAMPLE_PAGES = 8;

export interface ProcessorDeps {
  store: ProjectStore;
  bus: EventBus;
  vision: VisionPort;
  settings: () => Settings;
  device: DeviceProvider;
  library: ModelLibrary;
  runtime: LlmRuntime;
  /** Batería, temperatura, memoria y espacio: pausa o frena el trabajo antes de que el teléfono sufra. */
  guard?: DeviceGuard;
  /** Para sustituir el cliente del modelo de lenguaje (pruebas). */
  clientFactory?: (cfg: ClientConfig, runtime: LlmRuntime) => LLMClient;
  /**
   * ¿Cabe la traducción en su globo con un tamaño legible? Lo aporta la interfaz (necesita lienzo y tipografías).
   * Si no se indica, no se valida el ajuste (pruebas, Node).
   */
  fits?: (region: Region, page: Page) => boolean;
  /** Cachés de OCR y de traducciones (si se omiten, no se usan). */
  caches?: PipelineCaches;
  /** Política de concurrencia (por defecto, según RAM y memoria libre). Para pruebas. */
  concurrency?: ConcurrencyPolicy;
  /** Control térmico (por defecto se crea uno si el dispositivo informa su estado térmico; `null` lo desactiva). */
  pacer?: ThermalPacer | null;
}

interface Stats {
  pages: number; pages_with_work: number; lines: number; review: number; refused: number; edited_by_reviewer: number;
  errors: number; model: string; seconds?: number; done_pages?: number; error_pages?: number;
  /** Textos cuyo original se CONSERVÓ (no se borró) porque no había una traducción válida o no cabía. */
  preserved: number;
  /** Respuestas del modelo sin JSON válido, textos rescatados de ellas, recuperados uno a uno y perdidos (conservan el original). */
  json_invalid: number; json_salvaged: number; json_recovered: number; json_lost: number;
  /** Traducciones reformuladas más cortas porque no cabían en su globo. */
  condensed: number;
  /** Textos que pasaron por la llamada de reparación. */
  repaired: number;
  /** Segundos por etapa y por página: base para localizar el cuello de botella con datos medidos. */
  timings?: TimingSummary;
}

export interface PageTiming {
  page: number; analyze_s: number; translate_s: number; clean_s: number; regions: number; preserved: number; llm_tps: number;
  /** El análisis salió de la caché de OCR. */
  ocr_cached: boolean;
  /** Llamadas reales al modelo de esta página y respuestas servidas desde la caché. */
  llm_calls: number; tr_cache_hits: number;
  /** Estado del dispositivo al terminar la página (batería, temperatura, memoria libre); `null` si no se informa. */
  device?: DeviceSample | null;
  /** Desglose del análisis (decodificar, detector, viñetas, OCR…); ausente si salió de la caché. */
  vision?: AnalysisStats | null;
}
/** Medidas del capítulo completo (todas en segundos salvo que se indique). */
export interface ChapterStats {
  total_s: number; model_load_s: number; queue_wait_s: number;
  llm_calls: number; translate_cache_hits: number; ocr_cache_hits: number; ocr_cache_misses: number;
  /** Veces que se ejecutó de verdad el OCR/detector (con o sin caché activa). */
  ocr_calls: number;
  /** Páginas cuyo análisis se solapó con la traducción de la anterior. */
  overlapped_pages: number;
  /** Veces que se soltaron los modelos opcionales por poca memoria. */
  trims: number;
  /** Mínimo de memoria libre observada (MB), si el dispositivo la informa. */
  min_free_mb: number | null;
  /** Última decisión del gobernador de concurrencia. */
  plan: string;
  /** Control térmico: presión observada, descansos y pausas (ausente si el dispositivo no informa su estado). */
  thermal: PacerStats | null;
  /** Estado del dispositivo al empezar y al terminar la tarea. */
  device_start: DeviceSample | null;
  device_end: DeviceSample | null;
}
export interface TimingSummary { analyze_s: number; translate_s: number; clean_s: number; pages: PageTiming[]; chapter: ChapterStats }

/** Acumula el tiempo de cada etapa por página durante una ejecución. */
export class RunTiming {
  readonly chapter: ChapterStats = {
    total_s: 0, model_load_s: 0, queue_wait_s: 0, llm_calls: 0, translate_cache_hits: 0, ocr_cache_hits: 0, ocr_cache_misses: 0, ocr_calls: 0,
    overlapped_pages: 0, trims: 0, min_free_mb: null, plan: '', thermal: null, device_start: null, device_end: null,
  };
  private pages = new Map<string, PageTiming>();
  private at(pid: string, index: number): PageTiming {
    let p = this.pages.get(pid);
    if (!p) { p = { page: index + 1, analyze_s: 0, translate_s: 0, clean_s: 0, regions: 0, preserved: 0, llm_tps: 0, ocr_cached: false, llm_calls: 0, tr_cache_hits: 0 }; this.pages.set(pid, p); }
    return p;
  }
  add(pid: string, index: number, stage: 'analyze' | 'translate' | 'clean', ms: number, extra: Partial<Pick<PageTiming, 'regions' | 'preserved' | 'llm_tps' | 'ocr_cached' | 'llm_calls' | 'tr_cache_hits' | 'vision'>> = {}): void {
    const p = this.at(pid, index);
    p[`${stage}_s` as 'analyze_s'] += ms / 1000;
    Object.assign(p, extra);
  }
  /** Guarda cómo estaba el dispositivo al terminar una página. */
  sample(pid: string, index: number, s: DeviceSample | null): void { this.at(pid, index).device = s; }
  summary(): TimingSummary {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const pages = [...this.pages.values()].sort((a, b) => a.page - b.page).map((p) => ({ ...p, analyze_s: r1(p.analyze_s), translate_s: r1(p.translate_s), clean_s: r1(p.clean_s) }));
    const sum = (k: 'analyze_s' | 'translate_s' | 'clean_s') => r1(pages.reduce((n, p) => n + p[k], 0));
    const c = this.chapter;
    return {
      analyze_s: sum('analyze_s'), translate_s: sum('translate_s'), clean_s: sum('clean_s'), pages,
      chapter: { ...c, total_s: r1(c.total_s), model_load_s: r1(c.model_load_s), queue_wait_s: r1(c.queue_wait_s) },
    };
  }
}

/** ¿La traducción puede sustituir al original? Vacía, negativa del modelo o «sin traducir» → no. */
export function hasValidTranslation(r: Pick<Region, 'translation' | 'source_text' | 'flags'>): boolean {
  const t = r.translation.trim();
  if (!t) return false;
  if (r.flags.includes('refused') || r.flags.includes('untranslated')) return false;
  return !(isRefusal(t) && !isRefusal(r.source_text));
}

export interface CleanPlan { erase: Region[]; kept: { region: Region; reason: 'untranslated' | 'no_fit' }[] }

/**
 * Decide qué textos se pueden borrar de verdad. REGLA DE INTEGRIDAD: el original solo se borra si hay una traducción
 * válida con la que sustituirlo (y, si se puede comprobar, cabe en el globo). Si no, se conserva y se marca para revisión.
 * Lo que la persona aprobó o editó a mano manda: es una decisión suya (también si borró el texto a propósito).
 */
export function planClean(page: Page, fits?: (r: Region, p: Page) => boolean): CleanPlan {
  const plan: CleanPlan = { erase: [], kept: [] };
  for (const r of page.regions) {
    if (!r.erase) continue;
    if (r.status === 'approved' || r.status === 'edited') { plan.erase.push(r); continue; }
    if (!hasValidTranslation(r)) { plan.kept.push({ region: r, reason: 'untranslated' }); continue; }
    if (r.render && fits && !fits(r, page)) { plan.kept.push({ region: r, reason: 'no_fit' }); continue; }
    plan.erase.push(r);
  }
  return plan;
}

export class Processor {
  private timing = new RunTiming();
  /** Estado de la ejecución en curso (las tareas de cómputo se ejecutan de una en una). */
  private runVision: boolean | null = null;
  private useOcrCache = false;
  private lastAnalysisCached = false;
  private lastAnalysisStats: AnalysisStats | null = null;
  constructor(private d: ProcessorDeps) {}

  // -- recursos -----------------------------------------------------------
  async profile(): Promise<PerformanceProfile> {
    return currentProfile(await this.d.device.caps(), this.d.settings().processing.profile, this.d.device.mobile);
  }

  /** Identificador del modelo de traducción que se usará (el elegido, o el que mejor encaja con el dispositivo). */
  async llmModel(): Promise<string> {
    const s = this.d.settings().llm;
    if (s.provider !== 'builtin') {
      if (!s.model) throw new LLMUnavailableError('Elige el modelo de tu servidor externo en Modelos.');
      return s.model;
    }
    const installed = await this.d.library.installed();
    const chosen = resolveModel(installed, s.model, await this.d.device.caps(), this.d.settings().processing.profile, this.d.device.mobile);
    if (!chosen) {
      throw new LLMUnavailableError('Todavía no hay ningún modelo de traducción instalado. Instala uno en la sección Modelos: hay una recomendación para tu teléfono.');
    }
    return chosen.id;
  }

  /** ¿Se envía la imagen de la página al modelo? Requiere permiso, dispositivo capaz y modelo con visión. */
  async useVision(): Promise<boolean> {
    const s = this.d.settings().llm;
    if (!s.use_vision || !(await this.profile()).vision_llm) return false;
    if (s.provider !== 'builtin') return true;
    try {
      const id = await this.llmModel();
      return !!(await this.d.library.installed()).find((m) => m.id === id)?.vision;
    } catch (e) {
      if (e instanceof AppError) return false;
      throw e;
    }
  }

  /** Traductor con el modelo elegido en los ajustes (o el que mejor encaja con el dispositivo). */
  async translator(): Promise<PageTranslator> {
    return this.translatorFor(await this.llmModel());
  }

  /** Traductor con un modelo concreto; `quality` fuerza la calidad (la comparación de modelos usa «balanced»). */
  async translatorFor(model: string, quality?: 'balanced' | 'max', opts: { cache?: boolean } = {}): Promise<PageTranslator> {
    const s = this.d.settings();
    const profile = await this.profile();
    const chosen = quality ?? (s.translation.quality === 'auto' ? profile.quality : s.translation.quality);
    const cfg: ClientConfig = { provider: s.llm.provider, base_url: s.llm.base_url, api_key: s.llm.api_key, temperature: s.llm.temperature, timeout_s: s.llm.timeout_s, use_vision: s.llm.use_vision };
    const client = (this.d.clientFactory ?? createClient)(cfg, this.d.runtime);
    const salt = JSON.stringify([s.llm.provider, s.llm.temperature, s.llm.use_vision, chosen]);
    // Los modelos de traducción dedicados (Hy-MT2) usan el formato en texto plano: no entienden el esquema JSON de metadatos y es
    // ~10× menos texto que generar (ver docs/ARQUITECTURA-TRADUCCION.md). El resto sigue con el traductor contextual.
    const info = (await this.d.library.installed()).find((m) => m.id === model);
    const identity = [model, info?.repo ?? '', ...(info?.files ?? [])].join(' ');
    if (isBlockedModel(identity)) throw new LLMUnavailableError(BLOCKED_MODEL_MESSAGE);
    const family = mtFamily(identity);
    if (family !== 'generic') {
      return new PlainTranslator(client, model, family, { review_threshold: s.translation.review_threshold, dictionary: s.translation.dictionary, target_variant: s.translation.target_variant },
        { cache: opts.cache ? this.d.caches?.translation : undefined, salt: JSON.stringify([salt, family]) });
    }
    return new ContextualTranslator(client, model, { ...s.translation, quality: chosen }, { cache: opts.cache ? this.d.caches?.translation : undefined, salt });
  }

  /** Decisión de concurrencia del momento (RAM del dispositivo y memoria libre); con poca memoria suelta los modelos opcionales. */
  private async plan(): Promise<ConcurrencyPlan> {
    const mem = await this.d.guard?.memory?.().catch(() => null) ?? null;
    if (mem) {
      const c = this.timing.chapter;
      c.min_free_mb = c.min_free_mb === null ? mem.free_mb : Math.min(c.min_free_mb, mem.free_mb);
      if (mem.low) await this.trim();
    }
    const plan = this.d.concurrency ? await this.d.concurrency()
      : planConcurrency({ mobile: this.d.device.mobile, ramGb: (await this.d.device.caps()).ram_gb, freeMb: mem?.free_mb ?? null, lowMemory: !!mem?.low });
    this.timing.chapter.plan = plan.reason;
    return plan;
  }

  /** Foto del estado del dispositivo para el informe (nunca falla: sin dato, `null`). */
  private async sampleDevice(): Promise<DeviceSample | null> {
    try { return (await this.d.guard?.sample?.()) ?? null; } catch { return null; }
  }

  /** Poca memoria: la visión suelta los modelos grandes opcionales (se recargan solos si hacen falta). */
  private async trim(): Promise<void> {
    if (!this.d.vision.trim) return;
    this.timing.chapter.trims += 1;
    await this.d.vision.trim().catch((e) => console.warn('No se pudo liberar memoria de la visión', e));
  }

  // -- ejecución completa -------------------------------------------------
  async run(ctx: JobContext, projectId: string, stages: readonly string[] = STAGES, pageIds?: string[], force = false): Promise<Stats> {
    const { store } = this.d;
    let project = await store.get(projectId);
    const allIds = [...project.page_ids];
    const ids = (pageIds ?? allIds).filter((p) => allIds.includes(p));
    if (!ids.length) throw new AppError('empty_project', 'El proyecto no tiene páginas.');
    const active = STAGES.filter((s) => stages.includes(s));
    const full = active.reduce((n, s) => n + STAGE_WEIGHT[s], 0);

    const pages = new Map<string, Page>();
    for (const pid of ids) pages.set(pid, await store.getPage(projectId, pid));
    const todo = new Map(ids.map((pid) => [pid, todoFor(pages.get(pid)!, active, force)]));
    const initial = Object.fromEntries(ids.map((pid) => [pid, initialState(pages.get(pid)!, todo.get(pid)!)])) as Record<string, PageState>;
    const run = new RunState(store, projectId, this.d.bus);
    await run.begin([...active], ids, initial, force, ctx.job.id);
    const totalUnits = ids.length * full;
    const preUnits = ids.reduce((n, pid) => n + full - sumWeights(todo.get(pid)!), 0);
    const progress = new Progress(ctx, run, totalUnits, preUnits, totalUnits - preUnits, this.d.guard, () => this.trim());
    const stats: Stats = { pages: ids.length, pages_with_work: [...todo.values()].filter((t) => t.length).length, lines: 0, review: 0, refused: 0, edited_by_reviewer: 0, errors: 0, model: '', preserved: 0,
      json_invalid: 0, json_salvaged: 0, json_recovered: 0, json_lost: 0, repaired: 0, condensed: 0 };
    this.timing = new RunTiming();
    this.timing.chapter.queue_wait_s = Math.max(0, Date.now() / 1000 - ctx.job.created);
    this.useOcrCache = !force && !!this.d.caches;
    this.runVision = null;
    this.timing.chapter.device_start = await this.sampleDevice();
    const pacer = this.d.pacer !== undefined ? this.d.pacer : (this.d.guard?.sample ? new ThermalPacer(() => this.sampleDevice(), (ms, sig) => sig ? sleepUnless(ms, sig) : new Promise<void>((r) => setTimeout(r, ms))) : null);
    const started = performance.now();
    let translator: PageTranslator | null = null;
    try {
      ctx.update({ stage: 'prepare', message: 'Preparando', force: true });
      const needsAnalysis = [...todo.values()].some((t) => t.includes('analyze'));
      if (project.source_lang === AUTO_LANG && !project.detected_lang && needsAnalysis) {
        const lang = await this.detectLanguage(ctx, project, ids);
        run.setLanguage(lang);
        project = await store.get(projectId);
      } else {
        run.setLanguage(effectiveLang(project));
      }
      let plan = await this.plan();
      let warm: Promise<void> | null = null;
      /** Carga el modelo (una sola vez). Solo se solapa con el OCR si el gobernador lo permite: en un teléfono con poca RAM la carga espera a que la visión esté libre. */
      const startWarm = (): Promise<void> => {
        warm ??= (async () => {
          const t0 = performance.now();
          try { await translator!.client.warmUp(translator!.model, ctx.signal); }
          catch (e) { console.info('Precarga del modelo no completada:', e instanceof Error ? e.message : e); }
          this.timing.chapter.model_load_s += (performance.now() - t0) / 1000;
        })();
        return warm;
      };
      if (active.includes('translate') && [...todo.values()].some((t) => t.includes('translate'))) {
        translator = await this.translatorFor(await this.llmModel(), undefined, { cache: !force });
        stats.model = translator.model;
        if (!(await translator.client.health()).ok) throw new LLMUnavailableError(unavailableMessage(this.d.settings().llm.provider));
        this.runVision = translator.usesImage === false ? false : await this.useVision(); // se decide una vez por tarea, no página a página
        if (plan.overlap) void startWarm();
      }
      const story = new Map<string, string>(); // memoria narrativa: resúmenes de lo ya traducido, también de páginas fuera de esta tarea
      for (const p of allIds) {
        const pg = pages.get(p) ?? await store.getPage(projectId, p);
        if (pg.summary) story.set(p, `p.${pg.index + 1}: ${pg.summary}`);
      }

      const analyzeAhead = async (pid: string): Promise<void> => {
        const nextIdx = allIds.indexOf(pid) + 1;
        if (nextIdx >= allIds.length) return;
        const nxt = allIds[nextIdx];
        if (todo.has(nxt) && todo.get(nxt)!.includes('analyze') && run.data.pages[nxt].state === 'pending') {
          await this.stepAnalyze(ctx, progress, run, projectId, nxt, stats, `Página ${nextIdx + 1}`);
        }
      };

      for (const pid of ids) {
        const need = todo.get(pid)!;
        if (!need.length) continue;
        await progress.checkpoint();
        plan = await this.plan(); // la memoria libre cambia mientras se trabaja
        const idx = allIds.indexOf(pid);
        const label = `Página ${idx + 1}`;
        const pageStart = performance.now();
        try {
          if (need.includes('analyze') && run.data.pages[pid].state === 'pending') {
            await this.stepAnalyze(ctx, progress, run, projectId, pid, stats, label);
          }
          if (run.data.pages[pid].state === 'error') { // falló aquí o al analizarla por adelantado
            progress.pageFinished(pid, need);
            continue;
          }
          if (need.includes('translate')) {
            if (translator) await startWarm(); // en serie, el modelo se carga con la visión parada (la página ya está analizada)
            let ahead: Promise<void> | null = null;
            if (active.includes('analyze')) {
              if (plan.overlap) {
                this.timing.chapter.overlapped_pages += 1;
                ahead = analyzeAhead(pid); // con RAM de sobra, la página siguiente se analiza mientras el modelo traduce esta
                ahead.catch(() => undefined);
              } else {
                await analyzeAhead(pid);
              }
            }
            let failure: unknown = null;
            try { await this.stepTranslate(ctx, progress, run, translator, projectId, pid, story, stats, label); } catch (e) { failure = e; }
            if (ahead) { try { await ahead; } catch (e) { failure ??= e; } } // nunca queda trabajo suelto antes de reconstruir
            if (failure) throw failure;
          }
          if (need.includes('clean')) stats.preserved += await this.stepClean(ctx, progress, run, projectId, pid, label);
          run.setPage(pid, 'done');
          this.timing.sample(pid, idx, await this.sampleDevice());
          pages.delete(pid);
          // Descanso térmico proporcional al trabajo de esta página (0 mientras el teléfono no muestre presión térmica).
          if (pacer) await pacer.afterWork(performance.now() - pageStart, ctx.signal, (message) => ctx.update({ message, force: true })); // la página terminada no se vuelve a necesitar en memoria
          progress.pageFinished(pid, need);
        } catch (e) {
          if (e instanceof CancelledError || e instanceof ModelMissingError || e instanceof LLMUnavailableError) throw e;
          console.error(`Error procesando ${label}`, e);
          const msg = e instanceof AppError ? e.message : 'No se pudo procesar la página.'; // una página dañada no detiene el resto de la obra
          await this.markPageError(projectId, pid, msg);
          run.setPage(pid, 'error', msg);
          stats.errors += 1;
          progress.pageFinished(pid, need);
        }
      }

      stats.seconds = Math.round((performance.now() - started) / 100) / 10;
      this.timing.chapter.total_s = (performance.now() - started) / 1000;
      this.timing.chapter.device_end = await this.sampleDevice();
      this.timing.chapter.thermal = pacer && pacer.stats.samples ? pacer.summary() : null;
      if (translator) {
        this.timing.chapter.llm_calls = translator.stats.llm_calls;
        this.timing.chapter.translate_cache_hits = translator.stats.cache_hits;
      }
      stats.timings = this.timing.summary();
      const counts = run.counts();
      stats.done_pages = counts.done;
      stats.error_pages = counts.error;
      await store.mutate(projectId, async () => {
        const fresh = await store.get(projectId);
        fresh.last_job = { finished: now(), stages: [...active], ...stats };
        await store.save(fresh);
      });
      await run.finish('done');
      ctx.update({ progress: 1, stage: 'done', message: 'Proceso completado', force: true, eta_s: 0, detail: progress.detail(null, 'done') });
      return stats;
    } catch (e) {
      if (e instanceof CancelledError) {
        await run.finish('cancelled');
        throw e;
      }
      await run.finish('error', e instanceof AppError ? e.message : 'Error interno inesperado.');
      throw e;
    } finally {
      this.runVision = null;
      this.useOcrCache = false;
    }
  }

  // -- pasos de la canalización -----------------------------------------------
  private async stepAnalyze(ctx: JobContext, progress: Progress, run: RunState, projectId: string, pid: string, stats: Stats, label: string): Promise<void> {
    await progress.checkpoint();
    run.setPage(pid, 'analyzing');
    progress.message(pid, 'analyze', `${label} · detectando diálogos`);
    const project = await this.d.store.get(projectId);
    const page = await this.d.store.getPage(projectId, pid);
    const t0 = performance.now();
    try {
      const analyzed = await this.analyzePage(project, page, ctx.signal, this.useOcrCache);
      this.timing.add(pid, page.index, 'analyze', performance.now() - t0, { regions: analyzed.regions.length, ocr_cached: this.lastAnalysisCached, vision: this.lastAnalysisStats });
    } catch (e) {
      if (e instanceof ModelMissingError || e instanceof CancelledError) throw e;
      console.error(`Error analizando ${label}`, e);
      await this.markPageError(projectId, pid, 'No se pudo analizar la página.');
      run.setPage(pid, 'error', 'No se pudo analizar la página.');
      stats.errors += 1;
      return;
    }
    run.setPage(pid, 'analyzed');
    progress.stepDone('analyze', pid);
  }

  private async stepTranslate(ctx: JobContext, progress: Progress, run: RunState, translator: PageTranslator | null, projectId: string,
                              pid: string, story: Map<string, string>, stats: Stats, label: string): Promise<void> {
    const { store } = this.d;
    await progress.checkpoint();
    if (!translator) throw new LLMUnavailableError(unavailableMessage(this.d.settings().llm.provider));
    run.setPage(pid, 'translating');
    progress.message(pid, 'translate', `${label} · traduciendo`);
    const tStart = performance.now();
    const before = { ...translator.stats };
    const project = await store.get(projectId);
    const allIds = project.page_ids;
    const idx = allIds.indexOf(pid);
    const page = await store.getPage(projectId, pid);
    const prevPage = idx > 0 ? await store.getPage(projectId, allIds[idx - 1]) : null;
    const nextPage = idx + 1 < allIds.length ? await store.getPage(projectId, allIds[idx + 1]) : null;
    if (page.regions.length) {
      let image: Uint8Array | null = null;
      if (this.runVision ?? await this.useVision()) {
        image = await this.d.vision.annotate((await store.image(projectId, pid, 'original'))!, page.regions.map((r) => r.bbox));
      }
      const earlier = allIds.slice(0, idx).filter((p) => story.has(p)).map((p) => story.get(p)!);
      const seen = snapshotRegions(page.regions);
      const result = await translator.translatePage(project, page, { prevPage, nextPage, story: earlier, imageJpeg: image, signal: ctx.signal });
      let summary = '';
      await store.mutate(projectId, async () => {
        const proj = await store.get(projectId);
        const fresh = await store.getPage(projectId, pid);
        fresh.regions = mergeUnchanged(fresh.regions, result.updated, seen);
        fresh.summary = result.summary || fresh.summary;
        if (fresh.status === 'imported' || fresh.status === 'analyzed') fresh.status = 'translated';
        await store.savePage(projectId, fresh);
        mergeMemory(proj, result);
        await store.save(proj);
        summary = fresh.summary;
      });
      if (summary) story.set(pid, `p.${page.index + 1}: ${summary}`);
      stats.lines += result.updated.length;
      stats.review += result.updated.filter((r) => r.status === 'review').length;
      stats.refused += result.updated.filter((r) => r.flags.includes('refused')).length;
      stats.edited_by_reviewer += result.reviewed;
      stats.repaired += result.repaired ?? 0;
      stats.json_invalid += result.jsonInvalid ?? 0;
      stats.json_salvaged += result.salvaged ?? 0;
      stats.json_recovered += result.recovered ?? 0;
      stats.json_lost += result.jsonLost ?? 0;
      stats.condensed += result.condensed ?? 0;
    } else {
      await store.mutate(projectId, async () => {
        const fresh = await store.getPage(projectId, pid);
        if (fresh.status === 'imported' || fresh.status === 'analyzed') fresh.status = 'translated';
        await store.savePage(projectId, fresh);
      });
    }
    const llmStats = (translator.client as { lastStats?: { tps?: number } }).lastStats;
    this.timing.add(pid, page.index, 'translate', performance.now() - tStart, {
      llm_tps: llmStats?.tps ?? 0, llm_calls: translator.stats.llm_calls - before.llm_calls, tr_cache_hits: translator.stats.cache_hits - before.cache_hits,
    });
    run.setPage(pid, 'translated');
    progress.stepDone('translate', pid);
  }

  /** Devuelve cuántos textos conservaron su original (no se borraron) en esta página. */
  private async stepClean(ctx: JobContext, progress: Progress, run: RunState, projectId: string, pid: string, label: string): Promise<number> {
    await progress.checkpoint();
    run.setPage(pid, 'cleaning');
    progress.message(pid, 'clean', `${label} · reconstruyendo globos`);
    const project = await this.d.store.get(projectId);
    const page = await this.d.store.getPage(projectId, pid);
    const t0 = performance.now();
    const cleaned = await this.cleanPage(project, page, ctx.signal); // sin textos que borrar, la página «limpia» es el original (igual que en el PC)
    const preserved = cleaned.regions.filter((r) => r.flags.includes('original_kept')).length;
    this.timing.add(pid, page.index, 'clean', performance.now() - t0, { preserved });
    progress.stepDone('clean', pid);
    return preserved;
  }

  private async markPageError(projectId: string, pid: string, message: string): Promise<void> {
    const { store } = this.d;
    await store.mutate(projectId, async () => {
      const page = await store.getPage(projectId, pid);
      page.status = 'error';
      page.error = message;
      await store.savePage(projectId, page);
    });
  }

  // -- idioma automático ----------------------------------------------------------
  private async detectLanguage(ctx: JobContext, project: Project, ids: string[]): Promise<string> {
    const { store } = this.d;
    ctx.update({ stage: 'prepare', message: 'Detectando el idioma del original', force: true });
    const sample = ids.slice(0, LANG_SAMPLE_PAGES).map((pid) => async () => {
      await ctx.check();
      return (await store.image(project.id, pid, 'original'))!;
    });
    const lang = (await this.d.vision.detectLanguage(sample, ctx.signal)) || 'ja';
    await store.mutate(project.id, async () => {
      const fresh = await store.get(project.id);
      fresh.detected_lang = lang;
      if (fresh.direction_auto) fresh.reading_direction = directionFor(lang);
      await store.save(fresh);
    });
    return lang;
  }

  // -- etapa 1: análisis ----------------------------------------------------
  async analyzePage(project: Project, page: Page, signal?: AbortSignal, useCache = false): Promise<Page> {
    const { store } = this.d;
    const lang = effectiveLang(project);
    const caches = this.d.caches;
    const key = caches && page.sha1 ? analysisKey({
      sha1: page.sha1, lang, direction: project.reading_direction, sfx: project.sfx, height: page.height,
      engine: (await this.d.vision.fingerprint?.(lang)) ?? 'default',
    }) : '';
    this.lastAnalysisCached = false;
    this.lastAnalysisStats = null;
    let res: { regions: Region[]; panels: BBox[]; ocrEngine: string; mask: Blob; stats?: AnalysisStats } | null = null;
    if (useCache && caches && key) {
      const hit = await caches.ocr.get<CachedAnalysis>(key);
      const mask = hit ? await caches.ocr.getBlob(key) : undefined;
      if (hit && mask && hit.regions.every((r) => typeof r.id === 'string')) {
        res = { regions: structuredClone(hit.regions), panels: hit.panels, ocrEngine: hit.ocrEngine, mask };
        this.lastAnalysisCached = true;
        this.timing.chapter.ocr_cache_hits += 1;
      }
    }
    if (!res) {
      const original = await mustImage(store, project.id, page.id, 'original');
      this.timing.chapter.ocr_calls += 1;
      res = await this.d.vision.analyze({
        original, lang, direction: project.reading_direction, sfx: project.sfx, pageHeight: page.height,
      }, signal);
      this.lastAnalysisStats = res.stats ?? null;
      if (caches && key) {
        this.timing.chapter.ocr_cache_misses += 1;
        await caches.ocr.putBlob(key, res.mask).catch(() => undefined);
        await caches.ocr.put(key, { regions: res.regions, panels: res.panels, ocrEngine: res.ocrEngine } satisfies CachedAnalysis);
      }
    }
    await store.putImage(project.id, page.id, 'mask', res.mask);
    return store.mutate(project.id, async () => {
      const fresh = await store.getPage(project.id, page.id);
      // Lo que la persona ya revisó se conserva (con la página recién leída: incluye lo editado durante el análisis).
      const keep = fresh.regions.filter((r) => r.status === 'approved' || r.status === 'edited');
      Object.assign(fresh, { regions: keepReviewed(res.regions, keep), panels: res.panels, status: 'analyzed', error: '', ocr_engine: res.ocrEngine, has_clean: false });
      await store.savePage(project.id, fresh);
      return fresh;
    });
  }

  /** Vuelve a reconocer un área (corrige o crea una región dibujada por la persona). */
  async reocrRegion(projectId: string, pageId: string, regionId: string | null, bbox: BBox): Promise<Region> {
    const { store } = this.d;
    const project = await store.get(projectId);
    return store.mutate(projectId, async () => {
      const page = await store.getPage(projectId, pageId);
      let [x1, y1, x2, y2] = bbox.map((v) => Math.trunc(v));
      x1 = Math.max(0, Math.min(x1, page.width - 2)); y1 = Math.max(0, Math.min(y1, page.height - 2));
      x2 = Math.max(x1 + 2, Math.min(x2, page.width)); y2 = Math.max(y1 + 2, Math.min(y2, page.height));
      const existing = regionId ? page.regions.find((r) => r.id === regionId) : undefined;
      const region = await this.d.vision.readRegion({
        original: await mustImage(store, projectId, pageId, 'original'), mask: (await store.image(projectId, pageId, 'mask')) ?? null,
        bbox: [x1, y1, x2, y2], lang: effectiveLang(project), sfx: project.sfx, pageHeight: page.height, regionId: existing?.id ?? null,
        order: existing ? existing.order : page.regions.length,
      });
      if (existing) {
        Object.assign(region, { style: existing.style, erase: existing.erase, render: existing.render });
        page.regions = page.regions.map((r) => (r.id === existing.id ? region : r));
      } else {
        page.regions.push(region);
      }
      page.regions.sort((a, b) => a.order - b.order);
      await store.savePage(projectId, page);
      return region;
    });
  }

  // -- etapa 2: traducción de textos concretos --------------------------------------
  /** Retraduce textos concretos con todo el contexto de su página. */
  async translateSingle(projectId: string, pageId: string, regionIds: string[], signal?: AbortSignal): Promise<Region[]> {
    const { store } = this.d;
    const project = await store.get(projectId);
    const page = await store.getPage(projectId, pageId);
    const idx = project.page_ids.indexOf(pageId);
    if (idx < 0) throw new NotFoundError('la página');
    const prevPage = idx > 0 ? await store.getPage(projectId, project.page_ids[idx - 1]) : null;
    const nextPage = idx + 1 < project.page_ids.length ? await store.getPage(projectId, project.page_ids[idx + 1]) : null;
    // Solo páginas ANTERIORES (antes se filtraba y luego se cortaba: con un resumen vacío entraban páginas posteriores).
    const story = (await store.pages(project)).slice(0, idx).map((p) => p.summary).filter(Boolean);
    const seen = snapshotRegions(page.regions);
    const subset = structuredClone(page);
    for (const r of subset.regions) if (regionIds.includes(r.id)) r.status = 'pending';
    let image: Uint8Array | null = null;
    if (await this.useVision()) image = await this.d.vision.annotate((await store.image(projectId, pageId, 'original'))!, page.regions.map((r) => r.bbox));
    const result = await (await this.translator()).translatePage(project, subset, { prevPage, nextPage, story, imageJpeg: image, signal });
    const wanted = new Map(result.updated.filter((r) => regionIds.includes(r.id)).map((r) => [r.id, r]));
    let applied = new Set<string>();
    await store.mutate(projectId, async () => {
      const fresh = await store.getPage(projectId, pageId);
      fresh.regions = mergeUnchanged(fresh.regions, [...wanted.values()], seen);
      applied = new Set(fresh.regions.filter((r) => wanted.get(r.id) === r).map((r) => r.id));
      await store.savePage(projectId, fresh);
    });
    return [...wanted.values()].filter((r) => applied.has(r.id));
  }

  // -- etapa 3: limpieza ----------------------------------------------------
  async cleanPage(project: Project, page: Page, signal?: AbortSignal): Promise<Page> {
    const { store } = this.d;
    const original = await mustImage(store, project.id, page.id, 'original');
    const mask = (await store.image(project.id, page.id, 'mask')) ?? null;
    // El original SOLO se borra donde hay una traducción válida que lo sustituya; el resto se conserva y se marca.
    const plan = planClean(page, this.d.fits);
    const cleaned = plan.erase.length ? await this.d.vision.clean(original, mask, plan.erase, signal) : original;
    await store.putClean(project.id, page.id, cleaned);
    const keptWhy = new Map(plan.kept.map((k) => [k.region.id, k.reason]));
    return store.mutate(project.id, async () => {
      const fresh = await store.getPage(project.id, page.id);
      for (const r of fresh.regions) {
        r.flags = r.flags.filter((f) => f !== 'original_kept' && f !== 'no_fit'); // se recalcula en cada reconstrucción
        const why = keptWhy.get(r.id);
        if (!why) continue;
        r.flags = [...new Set([...r.flags, 'original_kept', ...(why === 'no_fit' ? ['no_fit'] : [])])].sort();
        if (why === 'no_fit') {
          r.status = 'review';
          r.note = r.note || 'La traducción no cabe en el globo con un tamaño legible: se conservó el texto original. Acórtala o amplía el área y vuelve a reconstruir.';
        } else if (!r.note) {
          r.note = 'No hay una traducción válida para este texto: se conservó el original sin borrarlo.';
        }
      }
      fresh.has_clean = true;
      if (fresh.status !== 'error') fresh.status = 'cleaned';
      await store.savePage(project.id, fresh);
      return fresh;
    });
  }
}

async function mustImage(store: ProjectStore, pid: string, gid: string, kind: 'original' | 'mask'): Promise<Blob> {
  const blob = await store.image(pid, gid, kind);
  if (!blob) throw new NotFoundError('la imagen');
  return blob;
}

/**
 * Conserva al volver a analizar los textos ya revisados (`edited`/`approved`). Paridad con `_keep_reviewed` (Python):
 * si siguen en el mismo sitio, sobre la región nueva (texto original, caja y opciones de borrado/rotulado); si el detector
 * ya no los encuentra (un globo marcado a mano donde el detector falló), tal cual. Antes se perdían sin aviso.
 */
export function keepReviewed(regions: Region[], keep: Region[]): Region[] {
  const matched = new Set<string>();
  for (const r of regions) {
    for (const old of keep) {
      if (!matched.has(old.id) && iou(r.bbox, old.bbox) > 0.6) {
        matched.add(old.id);
        r.translation = old.translation; r.status = old.status; r.style = old.style; r.speaker = old.speaker;
        r.source_text = old.source_text; r.erase = old.erase; r.render = old.render; r.layout_box = old.layout_box;
        break;
      }
    }
  }
  const out = [...regions, ...keep.filter((old) => !matched.has(old.id))];
  out.forEach((r, i) => { r.order = i; });
  return out;
}

/** Estado de cada región al empezar una traducción (paridad con `_snapshot`). */
export function snapshotRegions(regions: Region[]): Map<string, string> {
  return new Map(regions.map((r) => [r.id, JSON.stringify(r)]));
}

/**
 * Aplica las regiones traducidas solo donde la guardada sigue igual que al empezar (paridad con `_merge_unchanged`):
 * una edición hecha durante la traducción gana a la del modelo en vez de perderse.
 */
export function mergeUnchanged(current: Region[], updated: Region[], seen: Map<string, string>): Region[] {
  const byId = new Map(updated.map((r) => [r.id, r]));
  return current.map((r) => (byId.has(r.id) && seen.get(r.id) === JSON.stringify(r) ? byId.get(r.id)! : r));
}

export function iou(a: readonly number[], b: readonly number[]): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union ? inter / union : 0;
}

/** Etapas que aún faltan en la página (las hechas no se repiten salvo con `force`). */
export function todoFor(page: Page, active: readonly string[], force: boolean): string[] {
  if (force) return [...active];
  const todo: string[] = [];
  if (active.includes('analyze') && (page.status === 'imported' || page.status === 'error')) todo.push('analyze');
  const analyzed = ['analyzed', 'translated', 'cleaned'].includes(page.status) || todo.includes('analyze');
  if (active.includes('translate') && analyzed && page.status !== 'translated' && page.status !== 'cleaned') todo.push('translate');
  if (active.includes('clean') && (analyzed || page.status === 'cleaned') && page.status !== 'cleaned') todo.push('clean');
  return todo;
}

export function initialState(page: Page, todo: string[]): PageState {
  if (todo.length) return 'pending';
  if (page.status === 'error') return 'error';
  return page.status === 'imported' ? 'pending' : 'done';
}

const sumWeights = (stages: string[]) => stages.reduce((n, s) => n + STAGE_WEIGHT[s], 0);

function unavailableMessage(provider: string): string {
  return provider === 'builtin'
    ? 'El motor de lenguaje integrado no está listo: falta el servidor de modelos o no hay ningún modelo instalado. Revisa la sección Modelos.'
    : 'No se pudo conectar con el servidor de modelos configurado. Comprueba que está abierto e inténtalo de nuevo.';
}

/** Progreso global, tiempo restante y estado visible de la tarea. */
const GATE_MAX_WAITS = 40;

function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class Progress {
  private doneUnits = 0;      // trabajo realmente hecho en esta ejecución (base del ritmo)
  private skippedUnits = 0;   // trabajo que ya no se hará (páginas con error): cuenta para el % pero no para el ritmo
  private perPage = new Map<string, number>();
  private finishedPages = 0;
  private started = performance.now();
  private idle = 0;           // tiempo en pausa: no cuenta para el ETA
  private total: number;
  private work: number;

  constructor(private ctx: JobContext, private run: RunState, total: number, private pre: number, work: number, private guard?: DeviceGuard,
              private onPressure?: () => Promise<void>) {
    this.total = total || 1;
    this.work = Math.max(work, 1e-9);
  }

  /** Consulta la guarda del dispositivo: espera si hace falta (calor, memoria) o pausa la tarea (batería, espacio). */
  private async gate(): Promise<void> {
    if (!this.guard) return;
    for (let i = 0; i < GATE_MAX_WAITS; i++) {
      const v = await this.guard.check().catch(() => ({ action: 'ok' as const }));
      if (v.action === 'ok') return;
      if (v.action === 'pause') { this.ctx.pauseSelf(v.message ?? 'Pausado para proteger el teléfono.'); return; }
      this.ctx.update({ message: v.message ?? 'Esperando a que el teléfono se recupere…', force: true });
      if (v.code === 'low_memory') await this.onPressure?.();
      const t0 = performance.now();
      await sleepUnless(v.waitMs ?? 15_000, this.ctx.signal);
      this.idle += (performance.now() - t0) / 1000; // la espera no cuenta para el ritmo del ETA
      await this.ctx.check(); // atiende pausas y cancelaciones durante la espera
    }
  }

  async checkpoint(): Promise<void> {
    await this.gate();
    const paused = this.ctx.pauseRequested;
    if (paused) this.run.setStatus('paused'); // queda guardado: si la app se cierra en pausa, al volver se ofrece reanudar
    const t0 = performance.now();
    await this.ctx.check();
    if (paused) {
      this.run.setStatus('running');
      this.idle += (performance.now() - t0) / 1000; // el tiempo en pausa no cuenta para el ritmo
    }
  }

  stepDone(stage: string, pid: string): void {
    this.doneUnits += STAGE_WEIGHT[stage];
    this.perPage.set(pid, (this.perPage.get(pid) ?? 0) + STAGE_WEIGHT[stage]);
    this.push(pid, stage);
  }

  pageFinished(pid: string, stages: string[]): void {
    const missing = sumWeights(stages) - (this.perPage.get(pid) ?? 0);
    this.perPage.delete(pid);
    if (missing > 1e-9) this.skippedUnits += missing;
    else this.finishedPages += 1;
    this.push(pid, '');
  }

  message(pid: string, stage: string, text: string): void {
    this.ctx.update({ stage, message: text, force: true });
    this.push(pid, stage);
  }

  eta(): number | null {
    const elapsed = (performance.now() - this.started) / 1000 - this.idle;
    if (this.finishedPages < 1 || this.doneUnits <= 0 || elapsed < 4) return null; // con una página completa ya hay un ritmo fiable
    return Math.max(0, ((this.work - this.skippedUnits - this.doneUnits) * elapsed) / this.doneUnits);
  }

  detail(current: string | null, stage: string) {
    const c = this.run.counts();
    return { pages_total: c.total, pages_done: c.done, pages_error: c.error, pages_pending: c.pending, current_page: current, stage };
  }

  private push(current: string | null, stage: string): void {
    const frac = (this.pre + this.skippedUnits + this.doneUnits) / this.total;
    this.ctx.update({ progress: Math.min(frac, 0.999), eta_s: this.eta() ?? undefined, detail: this.detail(current, stage) });
  }
}
