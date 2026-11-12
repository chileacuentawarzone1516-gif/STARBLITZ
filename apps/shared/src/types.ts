/**
 * Formato de proyecto STARBLITZ v1 — espejo de `engine/starblitz_engine/projects/schema.py`.
 * Lo comparten el motor del PC, la app de escritorio y la app Android (que lleva su propio motor).
 */

export type BBox = [number, number, number, number];
export type RegionKind = 'dialogue' | 'thought' | 'narration' | 'sfx' | 'other';
export type RegionStatus = 'pending' | 'translated' | 'review' | 'approved' | 'edited';
export type PageStatus = 'imported' | 'analyzed' | 'translated' | 'cleaned' | 'error';
export type Direction = 'rtl' | 'ltr';
export type TargetVariant = 'es-419' | 'es-ES';
export type TranslationProfile = 'natural' | 'fiel' | 'coloquial' | 'formal' | 'adaptacion';
export type FontRole = 'dialogue' | 'narration' | 'shout' | 'whisper' | 'handwritten' | 'sfx';
export type Align = 'center' | 'left' | 'right';

export interface Bubble {
  polygon: [number, number][];
  bbox: BBox;
  fill: [number, number, number];
  uniform: boolean;
}

export interface TextStyle {
  font: FontRole;
  size: number | null;
  align: Align;
  color: string;
  stroke_color: string;
  stroke_width: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  line_height: number;
  letter_spacing: number;
  rotation: number;
}

export interface Region {
  id: string;
  order: number;
  kind: RegionKind;
  bbox: BBox;
  lines: [number, number][][];
  vertical: boolean;
  line_size: number;
  bubble: Bubble | null;
  layout_box: BBox;
  source_text: string;
  ocr_confidence: number;
  ocr_engine: string;
  ocr_fix: string;
  translation: string;
  speaker: string;
  emotion: string;
  confidence: number | null;
  flags: string[];
  note: string;
  review_note: string;
  status: RegionStatus;
  erase: boolean;
  render: boolean;
  max_chars: number;
  style: TextStyle;
  updated: number;
}

export interface Page {
  id: string;
  index: number;
  filename: string;
  ext: string;
  width: number;
  height: number;
  sha1: string;
  dhash: string;
  duplicate_of: string | null;
  status: PageStatus;
  approved: boolean;
  regions: Region[];
  panels: BBox[];
  ocr_engine: string;
  summary: string;
  error: string;
  has_clean: boolean;
  updated: number;
}

export interface Character {
  source: string;
  target: string;
  gender: 'm' | 'f' | 'n' | '?';
  speech: string;
  locked: boolean;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  note: string;
  locked: boolean;
}

export interface Project {
  format: number;
  id: string;
  name: string;
  created: number;
  updated: number;
  source_lang: string; // código de idioma o «auto»
  detected_lang: string; // idioma detectado cuando source_lang es «auto»
  target_variant: TargetVariant;
  reading_direction: Direction;
  direction_auto: boolean;
  honorifics: 'adapt' | 'keep';
  sfx: 'keep' | 'note';
  translation_profile: TranslationProfile; // criterio de traducción (los proyectos antiguos no lo tienen: se trata como «natural»)
  synopsis: string;
  style_notes: string;
  page_ids: string[];
  characters: Character[];
  glossary: GlossaryEntry[];
  cover_page_id: string | null;
  last_job: Record<string, unknown> | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created: number;
  updated: number;
  source_lang: string;
  detected_lang: string;
  target_variant: TargetVariant;
  page_count: number;
  cover_page_id: string | null;
  regions: number;
  translated: number;
  review: number;
  approved_pages: number;
  cleaned_pages: number;
  last_job: Record<string, unknown> | null;
}

export interface ProjectBundle {
  project: Project;
  pages: Page[];
  summary: ProjectSummary;
  run: RunInfo | null;
}

/** Estado de una página mientras el proyecto se procesa de forma automática. */
export type PageState =
  'pending' | 'analyzing' | 'analyzed' | 'translating' | 'translated' | 'cleaning' | 'done' | 'error';
export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'cancelled' | 'interrupted';

/** Una petición de procesamiento guardada en la cola persistente (sobrevive a cierres de la app). */
export type QueueState = 'queued' | 'running' | 'interrupted' | 'done' | 'error' | 'cancelled';
export interface QueueEntry {
  id: string;
  project_id: string;
  stages: ProcessStage[];
  page_ids: string[] | null;
  force: boolean;
  state: QueueState;
  enqueued: number;
  started: number | null;
  finished: number | null;
  job_id: string | null;
  error: string;
  attempts: number;
}

export interface RunInfo {
  status: RunStatus;
  interrupted: boolean;
  resumable: boolean;
  job_id: string | null;
  stages: ProcessStage[];
  started: number | null;
  updated: number | null;
  finished: number | null;
  error: string;
  language: string;
  pages: Record<string, { state: PageState; error: string; t: number }>;
  counts: { total: number; done: number; error: number; pending: number; active: number };
}

export type ProcessStage = 'analyze' | 'translate' | 'clean';

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';

export interface Job {
  id: string;
  kind: string;
  title: string;
  project_id: string | null;
  status: JobStatus;
  progress: number;
  stage: string;
  message: string;
  result: unknown;
  error: string;
  created: number;
  started: number | null;
  finished: number | null;
  eta_s: number | null;
  pausable: boolean;
  detail: { pages_total?: number; pages_done?: number; pages_error?: number; pages_pending?: number;
    current_page?: string | null; stage?: string };
}

export interface ImportReport {
  added: string[];
  duplicates: { file: string; of: string; exact: boolean; page_id?: string }[];
  errors: { file: string; reason: string }[];
  skipped_limit: number;
  limit: number;
}

export interface GPUInfo {
  name: string;
  vram_mb: number;
  vendor: string;
  driver: string;
}

export interface VisionModel {
  id: string;
  label: string;
  purpose: string;
  description: string;
  license: string;
  homepage: string;
  required: boolean;
  languages: string[];
  approx_mb: number;
  installed: boolean;
  downloading: boolean;
  offline: boolean;
}

export type Tier = 'low' | 'mid' | 'high' | 'pc-gpu';
export type FitVerdict = 'gpu' | 'hybrid' | 'cpu' | 'no';

export interface Fit {
  fits: FitVerdict;
  speed: 'fast' | 'medium' | 'slow' | 'none';
  need_gb: number;
  tight: boolean;
  note: string;
}

export interface LicenseInfo {
  id: string;
  class: 'permissive' | 'terms' | 'restricted' | 'unknown';
  note: string;
}

export interface DeviceCaps { ram_gb: number; vram_gb: number; gpu: string; cpu: string; threads: number }

export interface PerformanceProfile {
  id: Tier;
  label: string;
  description: string;
  context: number;
  vision_llm: boolean;
  quality: 'max' | 'balanced';
  ocr_japanese: 'manga-ocr' | 'ppocr';
  inpaint: 'lama' | 'fast';
  default_model: string;
}

/** Modelo del catálogo curado (recomendaciones) con su compatibilidad en este dispositivo. */
export interface CatalogModel {
  id: string;
  label: string;
  family: string;
  params_b: number;
  active_b: number;
  repo: string;
  file: string;
  size: number;
  mmproj: string | null;
  mmproj_size: number;
  quant: string;
  license: string;
  context_native: number;
  tiers: Tier[];
  summary: string;
  languages: string;
  tags: string[];
  fit: Fit;
  installed: boolean;
  recommended: boolean;
  active: boolean;
}

export interface InstalledModel {
  id: string;
  label: string;
  repo: string;
  revision: string;
  files: string[];
  mmproj: string | null;
  size: number;
  quant: string;
  license: string;
  license_info: LicenseInfo;
  arch: string;
  params_b: number;
  context_native: number;
  source: 'curated' | 'custom';
  installed_at: number;
  vision: boolean;
  fit: Fit;
  active: boolean;
}

export interface RuntimeStatus {
  available: boolean;
  running: boolean;
  model: string | null;
  pid: number | null;
  uptime_s: number;
  idle_s: number;
  flags: string[];
  error: string;
  log_tail: string[];
}

export interface ModelAdvice {
  device: DeviceCaps;
  profile: PerformanceProfile;
  profiles: PerformanceProfile[];
  recommended: string;
  reason: string;
  supported: boolean;
  options: CatalogModel[];
}

export interface LLMSummary {
  provider: 'builtin' | 'ollama' | 'openai';
  active: string | null;
  installed: number;
  ready: boolean;
  runtime_available: boolean;
  running: boolean;
  running_model: string | null;
  disk_bytes: number;
}

export interface LLMOverview extends LLMSummary {
  runtime: RuntimeStatus;
  installed_models: InstalledModel[];
  advice: ModelAdvice;
  installing: string[];
  /** Descargas sin terminar que ocupan disco: se reanudan instalando el mismo archivo o se borran como un modelo. */
  incomplete?: { id: string; bytes: number }[];
  hf_token_set: boolean;
  external: { base_url: string; ok: boolean; models: string[] } | null;
}

export interface HFSearchResult {
  repo: string;
  downloads: number;
  likes: number;
  license: string;
  license_info: LicenseInfo;
  gated: boolean;
  updated: string;
  languages: string[];
  task: string;
  installed: boolean;
}

export interface HFFile { path: string; size: number; quant: string; shards: number; fit: Fit; installed?: boolean }
export interface HFRepoInfo {
  repo: string;
  revision: string;
  license: LicenseInfo;
  gated: boolean;
  arch: string;
  params_b: number;
  context_native: number;
  files: HFFile[];
  mmproj: { path: string; size: number; quant: string }[];
  mmproj_suggested: { path: string; size: number; quant: string } | null;
}

export interface CompareLanguage {
  seconds: number;
  tokens_per_s: number;
  items: { source: string; translation: string; flags: string[]; confidence: number | null }[];
}
export interface CompareResult {
  models: { id: string; load_s: number | null; error: string; languages: Record<string, CompareLanguage> }[];
  samples: Record<string, string[]>;
}

export interface SystemInfo {
  version: string;
  hardware: {
    os: string;
    cpu: string;
    cores: number;
    threads: number;
    ram_mb: number;
    gpus: GPUInfo[];
    onnx_providers: string[];
    best_gpu: GPUInfo | null;
  };
  device: DeviceCaps;
  profile: { id: Tier; label: string; auto: boolean };
  llm: LLMSummary;
  accelerator: { name: string; gpu: boolean };
  models: VisionModel[];
  languages: Record<string, string>;
  data_dir: string;
  offline: { component: string; offline: boolean; requires: string }[];
}

export interface ModelsInfo {
  vision: VisionModel[];
}

export interface Settings {
  llm: {
    provider: 'builtin' | 'ollama' | 'openai';
    base_url: string;
    model: string;
    temperature: number;
    context_window: number;
    use_vision: boolean;
    timeout_s: number;
    idle_unload_minutes: number;
    api_key: string;
    hf_token: string;
  };
  translation: {
    target_variant: TargetVariant;
    quality: 'auto' | 'balanced' | 'max';
    honorifics: 'adapt' | 'keep';
    sfx: 'keep' | 'note';
    review_threshold: number;
    profile: TranslationProfile; // perfil de los proyectos nuevos
    dictionary: GlossaryEntry[]; // diccionario personal: se aplica en todos los proyectos
  };
  processing: {
    device: 'auto' | 'gpu' | 'cpu';
    max_pages: number;
    inpaint: 'auto' | 'lama' | 'fast';
    profile: 'auto' | Tier;
    /** EXPERIMENTAL: «manga-det» = detector ligero PP-OCRv6 Manga (si está instalado). Por defecto, el de siempre. */
    detector?: DetectorKind;
  };
}

export type DetectorKind = 'default' | 'manga-det';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
