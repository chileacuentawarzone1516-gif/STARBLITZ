/**
 * Piezas simuladas para probar el flujo completo en Node: visión, modelo de lenguaje y dispositivo.
 * La visión real (OpenCV + ONNX) se prueba aparte, en Chromium, contra la referencia de Python.
 */
import type { BBox, DeviceCaps, InstalledModel, Page, Project, Region, Settings } from '@starblitz/shared';
import { EventBus, type EngineEvent } from '../../src/engine/core/events';
import { JobManager } from '../../src/engine/core/jobs';
import { defaultSettings, mergeSettings } from '../../src/engine/core/settings';
import { defaultStyle, newProject, newRegion } from '../../src/engine/core/schema';
import { Processor } from '../../src/engine/pipeline/processor';
import type {
  AnalysisResult, AnalyzeInput, DeviceGuard, DeviceProvider, ModelLibrary, ReadRegionInput, VisionPort,
} from '../../src/engine/pipeline/ports';
import { MemoryStorage } from '../../src/engine/store/docs';
import { ProjectStore } from '../../src/engine/store/projects';
import { LLMClient, type ChatMessage } from '../../src/engine/translate/llm';
import type { LlmRuntime } from '../../src/engine/translate/runtime';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = (s: string) => new Blob([s], { type: 'image/png' });

export function fakeModel(id = 'qwen3.5-4b', vision = false): InstalledModel {
  return {
    id, label: id, repo: 'org/' + id, revision: 'main', files: [id + '.gguf'], mmproj: vision ? 'mmproj.gguf' : null, size: 2.5e9, quant: 'Q4_K_M',
    license: 'apache-2.0', license_info: { id: 'apache-2.0', class: 'permissive', note: '' }, arch: 'qwen3', params_b: 4, context_native: 32768,
    source: 'curated', installed_at: 1, vision, fit: { fits: 'yes', speed: 'medium', need_gb: 3, tight: false, note: '' }, active: true,
  };
}

export class FakeDevice implements DeviceProvider {
  mobile = true;
  constructor(private c: DeviceCaps = { ram_gb: 8, vram_gb: 0, gpu: '', cpu: 'arm64', threads: 8 }) {}
  async caps() { return this.c; }
}

export class FakeLibrary implements ModelLibrary {
  constructor(public models: InstalledModel[] = [fakeModel()]) {}
  async installed() { return this.models; }
}

export const fakeRuntime: LlmRuntime = {
  async ready() { return true; },
  async acquire() { return { baseUrl: 'http://127.0.0.1:0', apiKey: '', release() { /* nada */ } }; },
  async status() { return { available: true, running: false, model: null, pid: null } as never; },
  async unload() { /* nada */ },
};

export interface FakePage { texts: string[]; fail?: boolean }

/** Visión simulada: el contenido de la imagen es la clave de la página ("p1"…) y define sus textos. */
export class FakeVision implements VisionPort {
  analyzed: string[] = [];
  cleaned: string[] = [];
  detectCalls = 0;
  detectSample = 0;
  lang = 'ja';
  constructor(public pages: Record<string, FakePage>) {}

  private region(key: string, i: number, text: string, order = i): Region {
    return newRegion({
      id: `r${key}${i}`, order, kind: 'dialogue', bbox: [10, 10 + i * 100, 110, 90 + i * 100] as BBox, lines: [], vertical: true, line_size: 20,
      bubble: null, layout_box: [10, 10 + i * 100, 110, 90 + i * 100] as BBox, source_text: text, ocr_confidence: 0.95, ocr_engine: 'fake',
      erase: true, render: true, max_chars: 40, style: defaultStyle(),
    });
  }

  async analyze(input: AnalyzeInput): Promise<AnalysisResult> {
    const key = await input.original.text();
    this.analyzed.push(key);
    await sleep(2);
    const page = this.pages[key];
    if (!page || page.fail) throw new Error('imagen dañada');
    return { regions: page.texts.map((t, i) => this.region(key, i, t)), panels: [[0, 0, 200, 300]], ocrEngine: 'fake', mask: enc('mask:' + key) };
  }

  async detectLanguage(pages: (() => Promise<Blob>)[]): Promise<string> {
    this.detectCalls += 1;
    this.detectSample = pages.length;
    for (const p of pages) await p(); // las páginas de muestra deben poder leerse
    return this.lang;
  }

  /** Ids de los textos que se pidió borrar en cada reconstrucción (permite comprobar que no se borra sin traducción). */
  erased: string[][] = [];

  async clean(original: Blob, _mask?: Blob | null, regions: Region[] = []): Promise<Blob> {
    const key = await original.text();
    this.cleaned.push(key);
    this.erased.push(regions.map((r) => r.id));
    return enc('clean:' + key);
  }

  async annotate(): Promise<Uint8Array> { return new Uint8Array([0xff, 0xd8]); }

  async readRegion(input: ReadRegionInput): Promise<Region> {
    const key = await input.original.text();
    const r = this.region(key, input.order, `leído:${input.bbox.join(',')}`, input.order);
    r.bbox = input.bbox; r.layout_box = input.bbox;
    if (input.regionId) r.id = input.regionId;
    return r;
  }
}

export interface LlmCall { system: string; user: string; images: number; kind: 'translate' | 'review' }

/**
 * Modelo simulado: traduce cada línea numerada («[n] (…) texto») como «ES(texto)».
 * `refuse` hace que conteste con una negativa; `hook` permite intervenir (pausar, cancelar…) a mitad de la tarea.
 */
export class FakeLlm extends LLMClient {
  calls: LlmCall[] = [];
  healthy = true;
  refuse: (text: string) => boolean = () => false;
  hook: ((call: LlmCall) => Promise<void> | void) | null = null;
  constructor() { super({ temperature: 0.3, timeout_s: 60, use_vision: true }); }
  async health() { return { ok: this.healthy }; }
  protected async chat(messages: ChatMessage[], schema: object): Promise<string> {
    const user = messages.find((m) => m.role === 'user')!;
    const kind = 'new_terms' in (schema as { properties: object }).properties ? 'translate' : 'review';
    const call: LlmCall = { system: messages[0].content, user: user.content, images: user.images?.length ?? 0, kind };
    this.calls.push(call);
    await sleep(2);
    await this.hook?.(call);
    if (kind === 'review') return JSON.stringify({ items: [] });
    const items: object[] = [];
    for (const line of user.content.split('\n')) {
      const m = /^\[(\d+)\] \([^)]*\) (.*)$/.exec(line);
      if (!m || line.includes('→')) continue;
      const text = m[2];
      items.push({
        n: Number(m[1]), translation: this.refuse(text) ? 'Lo siento, no puedo ayudar con eso.' : `ES(${text})`, speaker: 'Aiko', emotion: 'calma',
        confidence: 0.9, flags: [], note: '', issue: '', source_fix: '',
      });
    }
    const first = /PÁGINA ACTUAL \((\d+)\//.exec(user.content)?.[1] ?? '?';
    return JSON.stringify({ items, page_summary: `Resumen de la página ${first}`, new_terms: [{ source: '先輩', target: 'sempai', note: '' }], characters: [{ source: '愛子', target: 'Aiko', gender: 'f', speech: 'educada' }] });
  }
}

export interface Env {
  storage: MemoryStorage;
  store: ProjectStore;
  bus: EventBus;
  jobs: JobManager;
  vision: FakeVision;
  llm: FakeLlm;
  library: FakeLibrary;
  settings: Settings;
  processor: Processor;
  events: EngineEvent[];
}

export function makeEnv(pages: Record<string, FakePage>, patch: Parameters<typeof mergeSettings>[1] = {}, guard?: DeviceGuard,
                        fits?: (r: Region, p: Page) => boolean): Env {
  const storage = new MemoryStorage();
  const store = new ProjectStore(storage, async (b) => b);
  const bus = new EventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const vision = new FakeVision(pages);
  const llm = new FakeLlm();
  const library = new FakeLibrary();
  const env = { settings: mergeSettings(defaultSettings(), patch) } as Env;
  const processor = new Processor({
    store, bus, vision, settings: () => env.settings, device: new FakeDevice(), library, runtime: fakeRuntime, clientFactory: () => llm, guard, fits,
  });
  return Object.assign(env, { storage, store, bus, jobs: new JobManager(bus), vision, llm, library, processor, events });
}

/** Crea un proyecto con una página por cada clave (el contenido de la imagen es la clave). */
export async function seedProject(env: Env, keys: string[], opts: Partial<Parameters<typeof newProject>[0]> = {}): Promise<Project> {
  const id = await env.store.newProjectId();
  const project = await env.store.create(newProject({
    id, name: 'Obra de prueba', source_lang: 'ja', target_variant: 'es-419', reading_direction: 'rtl', direction_auto: true, honorifics: 'adapt', sfx: 'keep', ...opts,
  }));
  for (const key of keys) {
    await env.store.addPage(project, enc(key), { ext: 'png', filename: key + '.png', width: 200, height: 300, sha1: 'sha' + key, dhash: '0', duplicate_of: null });
  }
  await env.store.save(project);
  return env.store.get(id);
}

export function startRun(env: Env, projectId: string, opts: { stages?: readonly string[]; pageIds?: string[]; force?: boolean } = {}) {
  return env.jobs.submit('process', 'Procesar', (ctx) => env.processor.run(ctx, projectId, opts.stages, opts.pageIds, opts.force), { projectId, pausable: true });
}

export async function waitJob(env: Env, id: string, until: (s: string) => boolean = (s) => ['done', 'error', 'cancelled'].includes(s), timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const j = env.jobs.get(id)!;
    if (until(j.status)) return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Tiempo agotado esperando la tarea (estado ${j.status}, ${j.message})`);
    await sleep(5);
  }
}

export async function pagesOf(env: Env, project: Project): Promise<Page[]> {
  return env.store.pages(await env.store.get(project.id));
}

export const text = (b: Blob | undefined) => b?.text();
