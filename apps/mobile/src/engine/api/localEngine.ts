/**
 * Motor de STARBLITZ para Android: la misma API que el motor del PC (`EngineClient`), pero ejecutándose DENTRO del
 * teléfono. Proyectos, importación, visión, traducción, reconstrucción y modelos funcionan con los recursos del
 * dispositivo; no hay servidor, ni PC, ni Wi-Fi propio. Internet solo se usa para descargar modelos.
 *
 * Esta clase no sabe nada de WebAssembly, de Capacitor ni del sistema de archivos: recibe esas piezas por
 * `LocalEngineDeps`, de modo que todo el comportamiento se prueba en Node con piezas simuladas.
 */
import {
  LANGUAGES, TRANSLATION_PROFILES, advise, currentProfile, fitFor, resolveModel,
} from '@starblitz/shared';
import type {
  BBox, DeepPartial, DeviceCaps, HFRepoInfo, HFSearchResult, InstalledModel, Job, LLMOverview, LLMSummary, ModelsInfo, Page, ProcessStage, Project,
  ProjectBundle, ProjectSummary, QueueEntry, Region, RunInfo, RuntimeStatus, Settings, SystemInfo,
} from '@starblitz/shared';
import { AppError, NotFoundError, ValidationError } from '../core/errors';
import { EventBus, type EngineEvent } from '../core/events';
import { newId, validateId } from '../core/ids';
import { JobManager } from '../core/jobs';
import { defaultSettings, loadSettings, mergeSettings, publicSettings } from '../core/settings';
import {
  AUTO_LANG, defaultStyle, limitText, mergeStyle, newProject, now, sanitizeRegion, toBox, validateName, validateRegionPatch,
} from '../core/schema';
import { ingest, type ImageCodec, type PdfOpener } from '../importers/ingest';
import { blobSource } from '../importers/zip';
import { compareModels, makeProbe } from '../llm/benchmark';
import { LlmLibrary, toInstalled } from '../models/library';
import type { VisionModelManager } from '../models/vision';
import type { PipelineCaches } from '../pipeline/cache';
import { Processor, STAGES, type ProcessorDeps } from '../pipeline/processor';
import { ProcessQueue } from '../pipeline/queue';
import { buildReport, type PerformanceReport } from '../pipeline/report';
import type { DeviceProvider, VisionPort } from '../pipeline/ports';
import { describeRun, type RunData } from '../pipeline/runstate';
import type { DocStorage } from '../store/docs';
import { ProjectStore, type ImageKind, type ThumbMaker } from '../store/projects';
import type { LlmRuntime } from '../translate/runtime';
import { directionFor } from '../vision/langid';

export const ENGINE_VERSION = '2.0.0';

export interface DeviceInfo {
  os: string; model: string; cpu: string; cores: number; threads: number; ram_mb: number; free_bytes: number; total_bytes: number;
}

export interface DeviceInfoPort extends DeviceProvider {
  info(): Promise<DeviceInfo>;
}

export interface LocalEngineDeps {
  storage: DocStorage;
  device: DeviceInfoPort;
  vision: VisionPort;
  visionModels: VisionModelManager;
  library: LlmLibrary;
  runtime: LlmRuntime;
  codec: ImageCodec;
  pdf?: PdfOpener;
  thumbs: ThumbMaker;
  version?: string;
  /** Para sustituir el cliente del modelo de lenguaje (pruebas). */
  clientFactory?: ProcessorDeps['clientFactory'];
  /** Batería, temperatura, memoria y espacio: frena o pausa el procesamiento antes de que el teléfono sufra. */
  guard?: ProcessorDeps['guard'];
  /** Validación de que la traducción cabe en su globo (necesita lienzo y tipografías: la aporta la interfaz). */
  fits?: ProcessorDeps['fits'];
  /** Cachés de OCR y traducciones (si se omiten, el motor no reutiliza resultados). */
  caches?: PipelineCaches;
  /** Política de concurrencia (pruebas). */
  concurrency?: ProcessorDeps['concurrency'];
}

export interface StorageInfo {
  projects_bytes: number; vision_models_bytes: number; llm_bytes: number; free_bytes: number; total_bytes: number;
}

const IMAGE_KINDS: ImageKind[] = ['original', 'clean', 'thumb', 'cthumb', 'mask'];
const STAGE_SET = new Set<string>(STAGES);

export interface ProjectCreateInput { name: string; source_lang?: string; target_variant?: string; reading_direction?: string; synopsis?: string; honorifics?: string; translation_profile?: string }

/** Perfil de traducción conocido; si no, error claro (nunca se guarda un valor desconocido). */
function validProfile(value: unknown): Project['translation_profile'] {
  if (!TRANSLATION_PROFILES.some((p) => p.id === value)) throw new ValidationError('invalid_profile', 'Perfil de traducción no admitido.');
  return value as Project['translation_profile'];
}

export class LocalEngine {
  readonly bus = new EventBus();
  readonly jobs = new JobManager(this.bus);
  readonly store: ProjectStore;
  readonly processor: Processor;
  private readonly processQueue: ProcessQueue;
  private closing = false;
  private settings: Settings = defaultSettings();
  private listeners = new Map<number, () => void>();
  private nextListener = 1;

  constructor(private d: LocalEngineDeps) {
    this.store = new ProjectStore(d.storage, d.thumbs);
    this.processor = new Processor({
      store: this.store, bus: this.bus, vision: d.vision, settings: () => this.settings, device: d.device, library: d.library, runtime: d.runtime,
      clientFactory: d.clientFactory, guard: d.guard, fits: d.fits, caches: d.caches, concurrency: d.concurrency,
    });
    this.processQueue = new ProcessQueue(d.storage);
    // La cola persistente sigue el estado real de cada tarea de procesamiento (incluida la cancelada antes de empezar).
    this.bus.subscribe((e) => { if (e.type === 'job') void this.syncQueue(e.job).catch((err) => console.warn('No se pudo actualizar la cola', err)); });
  }

  static async create(deps: LocalEngineDeps): Promise<LocalEngine> {
    const engine = new LocalEngine(deps);
    await engine.init();
    return engine;
  }

  async init(): Promise<void> {
    this.settings = loadSettings(await this.d.storage.getDoc('settings/main'));
    // Lo que quedó en cola o en ejecución cuando la app se cerró pasa a «interrumpido»; los proyectos borrados se descartan.
    await this.processQueue.load();
    await this.processQueue.dropProjects(async (id) => this.store.get(id).then(() => true, () => false));
  }

  // -- sistema -------------------------------------------------------------------------------------
  async health() { return { ok: true, version: this.d.version ?? ENGINE_VERSION }; }

  async system(): Promise<SystemInfo> {
    const [info, caps, models, llm] = await Promise.all([this.d.device.info(), this.d.device.caps(), this.d.visionModels.status(), this.llmSummary()]);
    const profile = currentProfile(caps, this.settings.processing.profile, true);
    const has = (id: string) => models.find((m) => m.id === id)?.installed ?? false;
    const ready = llm.ready;
    return {
      version: this.d.version ?? ENGINE_VERSION,
      hardware: { os: info.os, cpu: info.cpu, cores: info.cores, threads: info.threads, ram_mb: info.ram_mb, gpus: [], onnx_providers: ['wasm'], best_gpu: null },
      device: caps, profile: { id: profile.id, label: profile.label, auto: this.settings.processing.profile === 'auto' }, llm,
      accelerator: { name: 'CPU del teléfono', gpu: false }, models, languages: LANGUAGES, data_dir: 'Almacenamiento privado de STARBLITZ en este teléfono',
      offline: [
        { component: 'Importación y exportación', offline: true, requires: '' },
        { component: 'Detección de texto', offline: has('text-detector'), requires: has('text-detector') ? '' : 'Descargar el detector (95 MB) una vez' },
        { component: 'OCR multilingüe (PP-OCR)', offline: true, requires: '' },
        { component: 'OCR japonés especializado (Manga OCR)', offline: has('manga-ocr'), requires: has('manga-ocr') ? '' : 'Descargar Manga OCR (460 MB) una vez' },
        { component: 'Reconstrucción avanzada (LaMa)', offline: has('lama'), requires: has('lama') ? '' : 'Descargar LaMa (208 MB) una vez' },
        { component: 'Traducción contextual (modelo en el teléfono)', offline: ready, requires: ready ? '' : 'Instalar un modelo de traducción una vez (sección Modelos)' },
        { component: 'Descarga de modelos y actualizaciones', offline: false, requires: 'Internet (solo para descargar)' },
      ],
    };
  }

  async storageInfo(): Promise<StorageInfo> {
    const info = await this.d.device.info();
    return {
      projects_bytes: await this.store.imageBytes(), vision_models_bytes: await this.d.visionModels.diskBytes(), llm_bytes: await this.d.library.diskUsage(),
      free_bytes: info.free_bytes, total_bytes: info.total_bytes,
    };
  }

  async getSettings(): Promise<Settings> { return publicSettings(this.settings); }

  /** Ajustes completos (con el token) para los componentes internos que se crean antes que el motor: el servidor de modelos y los indicadores de visión. */
  settingsSnapshot(): Settings { return this.settings; }

  async updateSettings(patch: DeepPartial<Settings>): Promise<Settings> {
    this.settings = mergeSettings(this.settings, patch);
    await this.d.storage.putDoc('settings/main', this.settings);
    this.d.vision.refresh?.();
    return publicSettings(this.settings);
  }

  // -- eventos y tareas ---------------------------------------------------------------------------
  /** Suscripción a los eventos del motor; devuelve el número con el que cancelarla. */
  listen(cb: (e: EngineEvent) => void): number {
    const id = this.nextListener++;
    this.listeners.set(id, this.bus.subscribe(cb));
    return id;
  }
  unlisten(id: number): void { this.listeners.get(id)?.(); this.listeners.delete(id); }

  async listJobs(projectId?: string): Promise<Job[]> { return this.jobs.list(projectId); }
  async job(id: string): Promise<Job> {
    const j = this.jobs.get(id);
    if (!j) throw new NotFoundError('la tarea');
    return j;
  }
  async cancelJob(id: string) { return { cancelled: this.jobs.cancel(id) }; }
  async pauseJob(id: string) { return { paused: this.jobs.pause(id) }; }
  async resumeJob(id: string) { return { resumed: this.jobs.resume(id) }; }

  // -- modelos de visión ------------------------------------------------------------------------------
  async models(): Promise<ModelsInfo> { return { vision: await this.d.visionModels.status() }; }

  async installModel(id: string): Promise<Job> {
    if (!(await this.d.visionModels.status()).some((m) => m.id === id)) throw new NotFoundError('el modelo');
    if (this.jobs.list().some((j) => j.kind === 'model_install' && j.title.endsWith(id) && ['queued', 'running', 'paused'].includes(j.status))) {
      throw new AppError('busy', 'Este modelo ya se está descargando.', 409);
    }
    return this.jobs.submit('model_install', `Descargando modelo ${id}`, async (ctx) => {
      await this.d.visionModels.install(id, { signal: ctx.signal, progress: (p, message) => ctx.update({ progress: p, message }) });
      this.d.vision.refresh?.();
    }, { lane: 'io' });
  }

  async removeModel(id: string) {
    await this.d.visionModels.remove(id);
    this.d.vision.refresh?.();
    return { ok: true };
  }

  // -- modelos de traducción -------------------------------------------------------------------------------
  private async llmSummary(): Promise<LLMSummary> {
    const cfg = this.settings;
    const caps = await this.d.device.caps();
    const installed = await this.d.library.installed();
    const runtime = await this.d.runtime.status();
    let active: string | null;
    if (cfg.llm.provider === 'builtin') active = resolveModel(installed, cfg.llm.model, caps, cfg.processing.profile, true)?.id ?? null;
    else active = cfg.llm.model || null;
    return {
      provider: cfg.llm.provider, active, installed: installed.length,
      ready: cfg.llm.provider === 'builtin' ? runtime.available && installed.length > 0 : !!active,
      runtime_available: runtime.available, running: runtime.running, running_model: runtime.model, disk_bytes: await this.d.library.diskUsage(),
    };
  }

  async llm(): Promise<LLMOverview> {
    const cfg = this.settings;
    const caps = await this.d.device.caps();
    const profile = currentProfile(caps, cfg.processing.profile, true);
    const summary = await this.llmSummary();
    const installed: InstalledModel[] = (await this.d.library.stored()).map((m) => toInstalled(m, fitFor(m, caps, profile.context, true), m.id === summary.active));
    return {
      ...summary, runtime: await this.d.runtime.status(), installed_models: installed,
      advice: advise(caps, installed.map((m) => m.id), summary.active ?? '', cfg.processing.profile, true),
      installing: this.d.library.installing(), incomplete: await this.d.library.incomplete(), hf_token_set: !!cfg.llm.hf_token, external: null,
    };
  }

  searchModels(query: string, limit = 20): Promise<HFSearchResult[]> {
    return this.d.library.search(query, this.settings.llm.hf_token, limit);
  }

  async inspectRepo(repo: string): Promise<HFRepoInfo> {
    const caps = await this.d.device.caps();
    return this.d.library.inspect(repo, this.settings.llm.hf_token, caps, (await this.processor.profile()).context);
  }

  async installLLM(repo: string, file: string, opts: { mmproj?: string | null; force?: boolean } = {}): Promise<Job> {
    if (this.jobs.activeOfKind('llm_install')) throw new AppError('busy', 'Ya hay un modelo descargándose. Espera a que termine o cancélalo.', 409);
    const caps = await this.d.device.caps();
    const context = (await this.processor.profile()).context;
    const token = this.settings.llm.hf_token;
    return this.jobs.submit('llm_install', `Descargando ${file.split('/').pop()}`, async (ctx) => {
      const model = await this.d.library.install(repo, file, {
        mmproj: opts.mmproj ?? null, force: !!opts.force, token, caps, context, signal: ctx.signal,
        progress: (p, message) => ctx.update({ progress: p, message }),
        isPaused: () => ctx.pauseRequested, waitIfPaused: () => ctx.check(),
      });
      if (!this.settings.llm.model && this.settings.llm.provider === 'builtin') await this.updateSettings({ llm: { model: model.id } }); // el primero que se instala pasa a ser el activo
      return toInstalled(model);
    }, { lane: 'io', pausable: true });
  }

  async removeLLM(id: string) {
    if ((await this.d.runtime.status()).model === id) {
      // Antes se detenía el servidor aunque estuviera traduciendo: la petición fallaba y el procesado abortaba el capítulo.
      if (this.d.runtime.inUse?.()) {
        throw new AppError('busy', 'Ese modelo está traduciendo ahora mismo: espera a que termine o cancela el proceso antes de borrarlo.', 409);
      }
      await this.d.runtime.unload();
    }
    await this.d.library.remove(id);
    if (this.settings.llm.model === id) await this.updateSettings({ llm: { model: '' } });
    return { ok: true };
  }

  async activateLLM(id: string) {
    await this.d.library.get(id); // NotFoundError si no está instalado
    await this.updateSettings({ llm: { provider: 'builtin', model: id } });
    const running = (await this.d.runtime.status()).model;
    // Libera la memoria del anterior; el nuevo se carga al traducir. Si hay una traducción en curso NO se corta (antes
    // fallaba la petición y se abortaba el capítulo): el cambio se aplica en la siguiente petición.
    if (running && running !== id && !this.d.runtime.inUse?.()) await this.d.runtime.unload();
    return { ok: true, active: id };
  }

  llmRuntime(): Promise<RuntimeStatus> { return this.d.runtime.status(); }
  unloadLLM(): Promise<RuntimeStatus> { return this.d.runtime.unload(); }

  async compareLLMs(ids: string[]): Promise<Job> {
    if (!ids.length || ids.length > 4) throw new ValidationError('invalid_models', 'Elige entre 1 y 4 modelos para comparar.');
    for (const id of ids) await this.d.library.get(id);
    return this.jobs.submit('llm_compare', 'Comparando modelos', (ctx) => compareModels(
      ids, (id) => this.processor.translatorFor(id, 'balanced'), (p, message) => ctx.update({ progress: p, message }), ctx.signal,
    ));
  }

  /** Traducción de prueba de una frase con el modelo activo. */
  async testLLM(text: string, sourceLang: string) {
    if (!(sourceLang in LANGUAGES) || sourceLang === AUTO_LANG) throw new ValidationError('invalid_lang', 'Idioma de origen no admitido.');
    const clean = limitText(text, 500).trim();
    if (!clean) throw new ValidationError('invalid_text', 'Escribe una frase para probar el modelo.');
    const { project, page } = makeProbe(sourceLang, [clean]);
    const translator = await this.processor.translator();
    const result = await translator.translatePage(project, page, { prevPage: null, nextPage: null, story: [], imageJpeg: null });
    const r = result.updated[0] ?? page.regions[0];
    return { model: translator.model, translation: r.translation, confidence: r.confidence, flags: r.flags, note: r.note };
  }

  // -- proyectos --------------------------------------------------------------------------------------------
  projects(): Promise<ProjectSummary[]> { return this.store.list(); }

  async createProject(data: ProjectCreateInput): Promise<Project> {
    const lang = data.source_lang ?? AUTO_LANG;
    if (!(lang in LANGUAGES)) throw new ValidationError('invalid_lang', 'Idioma de origen no admitido.');
    const s = this.settings;
    const variant = (data.target_variant ?? s.translation.target_variant) as Project['target_variant'];
    if (!['es-419', 'es-ES'].includes(variant)) throw new ValidationError('invalid_variant', 'Variante de español no admitida.');
    const direction = data.reading_direction as Project['reading_direction'] | undefined;
    if (direction && !['rtl', 'ltr'].includes(direction)) throw new ValidationError('invalid_direction', 'Dirección de lectura no válida.');
    const honorifics = (data.honorifics ?? s.translation.honorifics) as Project['honorifics'];
    const project = newProject({
      id: await this.store.newProjectId(), name: data.name, source_lang: lang, target_variant: variant,
      reading_direction: direction ?? directionFor(lang === AUTO_LANG ? 'ja' : lang), direction_auto: !direction && lang === AUTO_LANG,
      honorifics: honorifics === 'keep' ? 'keep' : 'adapt', sfx: s.translation.sfx, synopsis: data.synopsis ?? '',
      translation_profile: validProfile(data.translation_profile ?? s.translation.profile),
    });
    return this.store.create(project);
  }

  async project(id: string): Promise<ProjectBundle> {
    const project = await this.store.get(id);
    return { project, pages: await this.store.pages(project), summary: await this.store.summary(project), run: await this.run(id) };
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    return this.store.mutate(id, async () => {
      const project = await this.store.get(id);
      const data: Project = { ...project };
      if (patch.name !== undefined) data.name = validateName(patch.name);
      if (patch.target_variant !== undefined) {
        if (!['es-419', 'es-ES'].includes(patch.target_variant)) throw new ValidationError('invalid_variant', 'Variante de español no admitida.');
        data.target_variant = patch.target_variant;
      }
      if (patch.honorifics !== undefined) data.honorifics = patch.honorifics === 'keep' ? 'keep' : 'adapt';
      if (patch.sfx !== undefined) data.sfx = patch.sfx === 'note' ? 'note' : 'keep';
      if (patch.translation_profile !== undefined) data.translation_profile = validProfile(patch.translation_profile);
      if (patch.synopsis !== undefined) data.synopsis = limitText(patch.synopsis, 4000);
      if (patch.style_notes !== undefined) data.style_notes = limitText(patch.style_notes, 2000);
      if (patch.characters !== undefined) {
        data.characters = patch.characters.slice(0, 200).map((c) => ({
          source: limitText(c.source, 120), target: limitText(c.target, 120), gender: (['m', 'f', 'n', '?'].includes(c.gender) ? c.gender : '?'), speech: limitText(c.speech, 200), locked: !!c.locked,
        }));
      }
      if (patch.glossary !== undefined) {
        data.glossary = patch.glossary.slice(0, 1000).map((g) => ({ source: limitText(g.source, 200), target: limitText(g.target, 200), note: limitText(g.note, 300), locked: !!g.locked }));
      }
      if (patch.source_lang !== undefined) {
        if (!(patch.source_lang in LANGUAGES)) throw new ValidationError('invalid_lang', 'Idioma de origen no admitido.');
        data.source_lang = patch.source_lang;
      }
      if (patch.reading_direction !== undefined) {
        if (!['rtl', 'ltr'].includes(patch.reading_direction)) throw new ValidationError('invalid_direction', 'Dirección de lectura no válida.');
        data.reading_direction = patch.reading_direction;
        data.direction_auto = false; // la elección manual manda sobre la deducida
      } else if (patch.source_lang !== undefined && data.source_lang !== AUTO_LANG) {
        data.reading_direction = directionFor(data.source_lang);
        data.direction_auto = false;
      } else if (data.source_lang === AUTO_LANG && project.source_lang !== AUTO_LANG) {
        data.detected_lang = '';
        data.direction_auto = true; // vuelve a detectarse en el próximo proceso
      }
      await this.store.save(data);
      return data;
    });
  }

  async deleteProject(id: string) {
    if (this.jobs.activeFor(id)) throw new AppError('busy', 'Espera a que termine el procesamiento o cancélalo antes de eliminar el proyecto.', 409);
    await this.store.delete(id);
    return { ok: true };
  }

  // -- importación ---------------------------------------------------------------------------------------------
  async importFiles(projectId: string, files: { name: string; blob: Blob }[]): Promise<Job> {
    validateId(projectId, 'proyecto');
    await this.store.get(projectId);
    if (!files.length) throw new ValidationError('no_files', 'No se eligió ningún archivo.');
    return this.jobs.submit('import', 'Importando archivos', async (ctx) => {
      const limit = this.settings.processing.max_pages;
      const report = await this.store.mutate(projectId, async () => {
        const project = await this.store.get(projectId);
        try {
          const existing = (await this.store.pages(project)).map((p) => ({ id: p.id, sha1: p.sha1, dhash: p.dhash }));
          return await ingest(
            files.map((f) => ({ name: f.name.split(/[\\/]/).pop() || 'archivo', source: blobSource(f.blob) })), existing, limit - project.page_ids.length,
            {
              codec: this.d.codec, pdf: this.d.pdf, check: () => ctx.check(),
              progress: (p, message) => ctx.update({ progress: p, message }),
              add: async (img, near) => (await this.store.addPage(project, new Blob([img.data.slice()], { type: mime(img.ext) }), {
                ext: img.ext, filename: img.name, width: img.width, height: img.height, sha1: img.sha1, dhash: img.dhash, duplicate_of: near,
              })).id,
            },
          );
        } finally {
          // También si la importación se cancela a medias: las páginas ya guardadas no deben quedar huérfanas.
          if (project.cover_page_id === null && project.page_ids.length) project.cover_page_id = project.page_ids[0];
          await this.store.save(project);
        }
      });
      return { ...report, limit };
    }, { projectId, lane: 'io' });
  }

  async reorderPages(projectId: string, pageIds: string[]) {
    return this.store.mutate(projectId, async () => {
      const project = await this.store.get(projectId);
      await this.store.reorder(project, pageIds);
      await this.store.save(project);
      return { page_ids: project.page_ids };
    });
  }

  // -- páginas y textos -------------------------------------------------------------------------------------------
  page(pid: string, gid: string): Promise<Page> { return this.store.getPage(pid, gid); }

  async approvePage(pid: string, gid: string, approved: boolean): Promise<Page> {
    return this.store.mutate(pid, async () => {
      const page = await this.store.getPage(pid, gid);
      page.approved = !!approved;
      if (approved) {
        for (const r of page.regions) if (r.translation.trim() && ['translated', 'review', 'edited'].includes(r.status)) r.status = 'approved';
      }
      await this.store.savePage(pid, page);
      return page;
    });
  }

  async deletePage(pid: string, gid: string) {
    if (this.jobs.activeFor(pid)) throw new AppError('busy', 'Espera a que termine el procesamiento antes de borrar páginas.', 409);
    await this.store.mutate(pid, async () => {
      const project = await this.store.get(pid);
      await this.store.deletePage(project, gid);
      await this.store.save(project);
    });
    return { ok: true };
  }

  /** Imagen de una página: original, reconstruida, miniaturas o máscara. */
  async image(pid: string, gid: string, kind: ImageKind): Promise<Blob | null> {
    if (!IMAGE_KINDS.includes(kind)) throw new ValidationError('invalid_kind', 'Tipo de imagen no válido.');
    await this.store.getPage(pid, gid);
    return (await this.store.image(pid, gid, kind)) ?? null;
  }

  async updateRegion(pid: string, gid: string, rid: string, patch: Record<string, unknown>): Promise<Region> {
    return this.store.updateRegion(pid, gid, validateId(rid, 'texto'), validateRegionPatch(patch) as never);
  }

  async putRegion(pid: string, gid: string, region: Region): Promise<Region> {
    const clean = sanitizeRegion(region);
    return this.store.mutate(pid, async () => {
      const page = await this.store.getPage(pid, gid);
      page.regions = [...page.regions.filter((r) => r.id !== clean.id), clean].sort((a, b) => a.order - b.order);
      page.regions.forEach((r, i) => { r.order = i; });
      await this.store.savePage(pid, page);
      return page.regions.find((r) => r.id === clean.id)!;
    });
  }

  async addRegion(pid: string, gid: string, bbox: BBox): Promise<Region> { return this.processor.reocrRegion(pid, gid, null, checkBox(bbox)); }
  async reocrRegion(pid: string, gid: string, rid: string, bbox: BBox): Promise<Region> { return this.processor.reocrRegion(pid, gid, validateId(rid, 'texto'), checkBox(bbox)); }

  async deleteRegion(pid: string, gid: string, rid: string) {
    await this.store.mutate(pid, async () => {
      const page = await this.store.getPage(pid, gid);
      const before = page.regions.length;
      page.regions = page.regions.filter((r) => r.id !== rid);
      if (page.regions.length === before) throw new NotFoundError('el texto');
      page.regions.forEach((r, i) => { r.order = i; });
      await this.store.savePage(pid, page);
    });
    return { ok: true };
  }

  async translateRegions(pid: string, gid: string, regionIds: string[]): Promise<Job> {
    await this.store.getPage(pid, gid);
    return this.jobs.submit('translate_regions', 'Retraduciendo textos', (ctx) => this.processor.translateSingle(pid, gid, regionIds, ctx.signal), { projectId: pid });
  }

  async cleanPage(pid: string, gid: string): Promise<Job> {
    await this.store.getPage(pid, gid);
    return this.jobs.submit('clean', 'Reconstruyendo página', async (ctx) => {
      const project = await this.store.get(pid);
      return this.processor.cleanPage(project, await this.store.getPage(pid, gid), ctx.signal);
    }, { projectId: pid });
  }

  // -- proyecto completo ------------------------------------------------------------------------------------------------
  /** Procesa el proyecto completo (o las etapas/páginas indicadas). `resume` continúa la última ejecución. */
  async process(pid: string, opts: { stages?: ProcessStage[]; page_ids?: string[]; force?: boolean; resume?: boolean } = {}): Promise<Job> {
    let stages: string[] = (opts.stages ?? [...STAGES]).filter((s) => STAGE_SET.has(s));
    if (opts.resume) {
      const previous = await this.store.loadRun<RunData>(pid);
      if (previous?.stages?.length) stages = previous.stages;
    }
    if (!stages.length) throw new ValidationError('invalid_stages', 'Indica al menos una etapa válida.');
    if (this.jobs.activeFor(pid)) throw new AppError('busy', 'Este proyecto ya se está procesando.', 409);
    await this.store.get(pid);
    // Una petición nueva sustituye a la interrumpida del mismo proyecto (el progreso por página lo conserva RunState).
    const old = this.processQueue.activeFor(pid);
    const attempts = old?.attempts ?? 0;
    if (old?.state === 'interrupted') await this.processQueue.remove(old.id);
    const entry = await this.processQueue.enqueue({ project_id: pid, stages: stages as ProcessStage[], page_ids: opts.page_ids ?? null, force: opts.force });
    return this.launch(entry, !!opts.resume, attempts);
  }

  private async launch(entry: QueueEntry, resume: boolean, attempts: number): Promise<Job> {
    const title = resume ? 'Reanudando proyecto' : 'Procesando proyecto';
    try {
      const job = this.jobs.submit('process', title,
        (ctx) => this.processor.run(ctx, entry.project_id, entry.stages, entry.page_ids ?? undefined, entry.force),
        { projectId: entry.project_id, pausable: true });
      await this.processQueue.mark(entry.id, { job_id: job.id, attempts: attempts + 1 });
      return job;
    } catch (e) {
      await this.processQueue.remove(entry.id);
      throw e;
    }
  }

  private async syncQueue(job: Job): Promise<void> {
    if (job.kind !== 'process' || this.closing) return; // al cerrar la app, lo pendiente debe quedar «en ejecución» para pasar a «interrumpido»
    const entry = this.processQueue.list().find((e) => e.job_id === job.id);
    if (!entry) return;
    const state = job.status === 'queued' ? 'queued' : job.status === 'running' || job.status === 'paused' ? 'running' : job.status === 'done' ? 'done' : job.status === 'cancelled' ? 'cancelled' : 'error';
    if (entry.state === state) return;
    const finished = state === 'done' || state === 'cancelled' || state === 'error';
    await this.processQueue.mark(entry.id, {
      state, started: entry.started ?? (state === 'running' ? now() : null), finished: finished ? now() : null, error: state === 'error' ? job.error : '',
    });
  }

  /** Peticiones guardadas: pendientes (interrumpidas o en cola), en ejecución y las últimas terminadas. */
  queue(): Promise<QueueEntry[]> { return Promise.resolve(this.processQueue.list()); }

  /** Retoma las peticiones interrumpidas por un cierre de la app, en el orden en que se pidieron. El progreso por página se conserva. */
  async resumeQueue(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const e of this.processQueue.pending()) {
      try {
        jobs.push(await this.process(e.project_id, { stages: e.stages, page_ids: e.page_ids ?? undefined, force: e.force, resume: true }));
      } catch (err) {
        console.warn(`No se pudo retomar el proyecto ${e.project_id}`, err);
        await this.processQueue.mark(e.id, { state: 'error', error: err instanceof Error ? err.message : 'No se pudo retomar.', finished: now() });
      }
    }
    return jobs;
  }

  /** Descarta una petición interrumpida (no se retomará). */
  async dismissQueue(id: string): Promise<{ ok: true }> {
    const e = this.processQueue.list().find((x) => x.id === id);
    if (!e) throw new NotFoundError('la petición');
    if (e.state === 'running' || e.state === 'queued') throw new AppError('busy', 'Esa petición sigue en curso: cancélala desde la tarea.', 409);
    await this.processQueue.remove(id);
    return { ok: true };
  }

  async run(pid: string): Promise<RunInfo | null> {
    return describeRun(this.store, pid, !!this.jobs.activeFor(pid));
  }

  /**
   * Informe de rendimiento del proyecto (para exportar como JSON): lo que midió la última tarea terminada
   * (`project.last_job.timings`), el estado del proyecto y del dispositivo y un resumen calculado. Solo LEE: no cambia nada.
   * Nunca incluye tokens, claves, imágenes ni textos del manga.
   */
  async report(pid: string): Promise<PerformanceReport> {
    const project = await this.store.get(pid);
    const s = this.settings;
    const [info, caps, now, llm, run] = await Promise.all([
      this.d.device.info().catch(() => null), this.d.device.caps(), this.d.guard?.sample?.().catch(() => null) ?? null, this.llmSummary().catch(() => null), this.run(pid),
    ]);
    const g = globalThis as { crossOriginIsolated?: boolean; navigator?: { userAgent?: string } };
    return buildReport({
      generated: Date.now() / 1000,
      appVersion: this.d.version ?? ENGINE_VERSION,
      device: { info, caps, now },
      runtime: { cross_origin_isolated: typeof g.crossOriginIsolated === 'boolean' ? g.crossOriginIsolated : null, user_agent: g.navigator?.userAgent ?? '' },
      settings: {
        processing: s.processing,
        translation: { quality: s.translation.quality, profile: s.translation.profile, target_variant: s.translation.target_variant, sfx: s.translation.sfx },
        llm: { provider: s.llm.provider, model: s.llm.model, temperature: s.llm.temperature, context_window: s.llm.context_window, use_vision: s.llm.use_vision },
      },
      llm: llm ? { active: llm.active, ready: llm.ready, running: llm.running, running_model: llm.running_model } : {},
      project: {
        id: project.id, name: project.name, pages: project.page_ids.length, source_lang: project.source_lang, detected_lang: project.detected_lang,
        translation_profile: project.translation_profile,
      },
      run,
      lastJob: (project.last_job as Record<string, unknown> | null) ?? null,
      queue: this.processQueue.list(),
    });
  }

  async dispose(): Promise<void> {
    this.closing = true; // el cierre no es una cancelación de la persona: la cola conserva lo pendiente
    for (const j of this.jobs.list()) if (['queued', 'running', 'paused'].includes(j.status)) this.jobs.cancel(j.id);
    await this.d.vision.dispose?.();
  }
}

const MIMES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mime = (ext: string) => MIMES[ext] ?? 'application/octet-stream';

const checkBox = (b: BBox): BBox => toBox(b, 'texto');

export { defaultStyle, mergeStyle, newId, now };
export type { DeviceCaps };
