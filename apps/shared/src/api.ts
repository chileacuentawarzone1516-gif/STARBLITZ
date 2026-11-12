/**
 * Cliente tipado del motor local de STARBLITZ.
 * Cada app habla con SU PROPIO motor en 127.0.0.1 (el de Windows en el PC, el de Android en el teléfono):
 * ninguna depende de la otra ni de un servidor propio.
 */
import type {
  BBox, DeepPartial, HFRepoInfo, HFSearchResult, Job, LLMOverview, ModelsInfo, Page, PageState,
  ProcessStage, Project, ProjectBundle, ProjectSummary, Region, RunInfo, RunStatus, RuntimeStatus, Settings,
  SystemInfo, TextStyle,
} from './types';

export interface EngineConnection {
  baseUrl: string; // p. ej. http://127.0.0.1:47811 (sin barra final)
  token: string;
}

export class EngineError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
    super(message);
  }
}

export type RegionPatch = Partial<Pick<Region,
  'kind' | 'source_text' | 'translation' | 'speaker' | 'status' | 'erase' | 'render' | 'layout_box' | 'bbox' | 'order' |
  'flags'>> & { style?: TextStyle };

export type { ProcessStage };

/** Eventos en tiempo real del motor (SSE). */
export interface EngineEvents {
  job?: (job: Job) => void;
  /** Una página cambió de estado durante el procesado automático del proyecto. */
  page?: (e: { project_id: string; page_id: string; state: PageState; error: string }) => void;
  /** Cambió el estado global de una ejecución (en curso, pausada, completada…). */
  run?: (e: { project_id: string; status: RunStatus; counts: RunInfo['counts'] }) => void;
  /** Cambió el estado de la conexión con el motor. */
  connection?: (connected: boolean) => void;
}

/**
 * Tiempos límite de las peticiones que hacen trabajo pesado DENTRO de la propia petición (el resto usa 30 s). Antes todas
 * usaban 30 s: «Probar la traducción» carga el modelo (el motor admite hasta 20 min) y fallaba en CPU o discos lentos
 * mientras el motor seguía trabajando; subir un capítulo grande o la primera relectura (carga del OCR) también.
 */
export const SLOW_MS = { llmTest: 25 * 60_000, upload: 10 * 60_000, ocr: 3 * 60_000 } as const;

export class EngineClient {
  constructor(public conn: EngineConnection, private timeoutMs = 30_000) {}

  get baseUrl() {
    return this.conn.baseUrl.replace(/\/+$/, '');
  }

  /** URL directa de una imagen (el token va en la consulta porque <img> no envía cabeceras). */
  imageUrl(projectId: string, pageId: string, kind: 'original' | 'clean' | 'thumb' | 'cthumb' | 'mask', version?: number | string) {
    const v = version !== undefined ? `&v=${encodeURIComponent(String(version))}` : '';
    return `${this.baseUrl}/api/projects/${projectId}/pages/${pageId}/image/${kind}?t=${encodeURIComponent(this.conn.token)}${v}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.conn.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { method, headers, body: payload, signal: ctrl.signal, ...init });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      throw new EngineError(aborted ? 'timeout' : 'offline',
        aborted ? 'El motor tardó demasiado en responder.' : 'No se pudo conectar con el motor de STARBLITZ.', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let code = 'http_error';
      let message = `Error ${res.status}`;
      let details: Record<string, unknown> | undefined;
      try {
        const data = await res.json();
        code = data?.error?.code ?? code;
        message = data?.error?.message ?? message;
        details = data?.error?.details;
      } catch { /* respuesta sin JSON */ }
      throw new EngineError(code, message, res.status, details);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Descarga binaria (imágenes para exportar). */
  async fetchBlob(url: string): Promise<Blob> {
    const res = await fetch(url);
    if (!res.ok) throw new EngineError('http_error', `No se pudo descargar la imagen (${res.status}).`, res.status);
    return res.blob();
  }

  // -- sistema -----------------------------------------------------------
  health() { return this.request<{ ok: boolean; version: string }>('GET', '/api/health'); }
  system() { return this.request<SystemInfo>('GET', '/api/system'); }
  settings() { return this.request<Settings>('GET', '/api/settings'); }
  updateSettings(patch: DeepPartial<Settings>) { return this.request<Settings>('PATCH', '/api/settings', patch); }
  jobs(projectId?: string) {
    return this.request<Job[]>('GET', `/api/jobs${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
  }
  job(id: string) { return this.request<Job>('GET', `/api/jobs/${id}`); }
  cancelJob(id: string) { return this.request<{ cancelled: boolean }>('POST', `/api/jobs/${id}/cancel`); }
  pauseJob(id: string) { return this.request<{ paused: boolean }>('POST', `/api/jobs/${id}/pause`); }
  resumeJob(id: string) { return this.request<{ resumed: boolean }>('POST', `/api/jobs/${id}/resume`); }

  // -- modelos de visión (detector, OCR, reconstrucción) -------------------------
  models() { return this.request<ModelsInfo>('GET', '/api/models'); }
  installModel(id: string) { return this.request<Job>('POST', `/api/models/${encodeURIComponent(id)}/install`); }
  removeModel(id: string) { return this.request<{ ok: boolean }>('DELETE', `/api/models/${encodeURIComponent(id)}`); }

  // -- modelos de traducción (locales, GGUF desde Hugging Face) ---------------------
  llm() { return this.request<LLMOverview>('GET', '/api/llm'); }
  searchModels(query: string, limit = 20) {
    return this.request<HFSearchResult[]>('GET', `/api/llm/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }
  inspectRepo(repo: string) { return this.request<HFRepoInfo>('GET', `/api/llm/repo?repo=${encodeURIComponent(repo)}`); }
  installLLM(repo: string, file: string, opts: { mmproj?: string | null; force?: boolean } = {}) {
    return this.request<Job>('POST', '/api/llm/install', { repo, file, mmproj: opts.mmproj ?? null, force: !!opts.force });
  }
  removeLLM(id: string) { return this.request<{ ok: boolean }>('DELETE', `/api/llm/installed/${encodeURIComponent(id)}`); }
  activateLLM(id: string) { return this.request<{ ok: boolean; active: string }>('POST', '/api/llm/activate', { id }); }
  llmRuntime() { return this.request<RuntimeStatus>('GET', '/api/llm/runtime'); }
  unloadLLM() { return this.request<RuntimeStatus>('POST', '/api/llm/unload'); }
  compareLLMs(ids: string[]) { return this.request<Job>('POST', '/api/llm/compare', { ids }); }
  testLLM(text: string, source_lang: string) {
    return this.request<{ model: string; translation: string; confidence: number | null; flags: string[]; note: string }>(
      'POST', '/api/llm/test', { text, source_lang }, {}, SLOW_MS.llmTest);
  }

  // -- proyectos ---------------------------------------------------------
  projects() { return this.request<ProjectSummary[]>('GET', '/api/projects'); }
  createProject(data: { name: string; source_lang: string; target_variant?: string; reading_direction?: string; synopsis?: string }) {
    return this.request<Project>('POST', '/api/projects', data);
  }
  project(id: string) { return this.request<ProjectBundle>('GET', `/api/projects/${id}`); }
  updateProject(id: string, patch: Partial<Project>) { return this.request<Project>('PATCH', `/api/projects/${id}`, patch); }
  deleteProject(id: string) { return this.request<{ ok: boolean }>('DELETE', `/api/projects/${id}`); }
  importFiles(id: string, files: (File | { name: string; blob: Blob })[]) {
    const form = new FormData();
    for (const f of files) {
      if (f instanceof File) form.append('files', f, f.name);
      else form.append('files', f.blob, f.name);
    }
    return this.request<Job>('POST', `/api/projects/${id}/import`, form, {}, SLOW_MS.upload);
  }
  reorderPages(id: string, pageIds: string[]) {
    return this.request<{ page_ids: string[] }>('PUT', `/api/projects/${id}/pages/order`, { page_ids: pageIds });
  }
  page(pid: string, gid: string) { return this.request<Page>('GET', `/api/projects/${pid}/pages/${gid}`); }
  approvePage(pid: string, gid: string, approved: boolean) {
    return this.request<Page>('PATCH', `/api/projects/${pid}/pages/${gid}`, { approved });
  }
  deletePage(pid: string, gid: string) { return this.request<{ ok: boolean }>('DELETE', `/api/projects/${pid}/pages/${gid}`); }
  updateRegion(pid: string, gid: string, rid: string, patch: RegionPatch) {
    return this.request<Region>('PATCH', `/api/projects/${pid}/pages/${gid}/regions/${rid}`, patch);
  }
  putRegion(pid: string, gid: string, region: Region) {
    return this.request<Region>('PUT', `/api/projects/${pid}/pages/${gid}/regions/${region.id}`, region);
  }
  addRegion(pid: string, gid: string, bbox: BBox) {
    return this.request<Region>('POST', `/api/projects/${pid}/pages/${gid}/regions`, { bbox }, {}, SLOW_MS.ocr);
  }
  reocrRegion(pid: string, gid: string, rid: string, bbox: BBox) {
    return this.request<Region>('POST', `/api/projects/${pid}/pages/${gid}/regions/${rid}/ocr`, { bbox }, {}, SLOW_MS.ocr);
  }
  deleteRegion(pid: string, gid: string, rid: string) {
    return this.request<{ ok: boolean }>('DELETE', `/api/projects/${pid}/pages/${gid}/regions/${rid}`);
  }
  translateRegions(pid: string, gid: string, regionIds: string[]) {
    return this.request<Job>('POST', `/api/projects/${pid}/pages/${gid}/translate`, { region_ids: regionIds });
  }
  cleanPage(pid: string, gid: string) { return this.request<Job>('POST', `/api/projects/${pid}/pages/${gid}/clean`); }
  /** Procesa el proyecto completo (o las etapas/páginas indicadas). `resume` continúa la última ejecución. */
  process(pid: string, opts: { stages?: ProcessStage[]; page_ids?: string[]; force?: boolean; resume?: boolean } = {}) {
    return this.request<Job>('POST', `/api/projects/${pid}/process`, opts);
  }
  run(pid: string) { return this.request<RunInfo | null>('GET', `/api/projects/${pid}/run`); }

  /** Espera a que una tarea termine (con sondeo, útil cuando no hay SSE). */
  async waitJob(id: string, onProgress?: (job: Job) => void, intervalMs = 700): Promise<Job> {
    for (;;) {
      const job = await this.job(id);
      onProgress?.(job);
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job; // 'paused' sigue esperando
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Suscripción a eventos en tiempo real (Server-Sent Events) con reconexión automática. */
  subscribe(handlers: EngineEvents): () => void {
    let source: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      if (closed) return;
      source = new EventSource(`${this.baseUrl}/api/events?t=${encodeURIComponent(this.conn.token)}`);
      source.onopen = () => handlers.connection?.(true);
      source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data?.type === 'job') handlers.job?.(data.job as Job);
          else if (data?.type === 'page') handlers.page?.(data);
          else if (data?.type === 'run') handlers.run?.(data);
        } catch { /* evento ilegible */ }
      };
      source.onerror = () => {
        handlers.connection?.(false);
        source?.close();
        retry = setTimeout(open, 2500);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }
}
