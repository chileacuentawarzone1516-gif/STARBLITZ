/**
 * Estado persistente de una ejecución de proyecto completo (equivalente a `pipeline/runstate.py`).
 *
 * Sirve para tres cosas: mostrar en vivo en qué punto está cada página, calcular progreso y tiempo restante, y
 * recuperar un trabajo interrumpido (cierre de la app, batería agotada…). El estado queda guardado y, al volver, la
 * interfaz ofrece «Reanudar». Las etapas son idempotentes: reanudar solo hace lo que falta.
 */
import type { PageState, RunInfo, RunStatus } from '@starblitz/shared';
import type { EventBus } from '../core/events';
import type { ProjectStore } from '../store/projects';

// Peso de cada etapa en el progreso global (el modelo de lenguaje es lo más lento).
export const STAGE_WEIGHT: Record<string, number> = { analyze: 0.25, translate: 0.55, clean: 0.20 };

export interface RunData {
  version: number;
  job_id: string;
  status: Exclude<RunStatus, 'interrupted'>;
  stages: string[];
  force: boolean;
  started: number;
  updated: number;
  finished: number | null;
  error: string;
  language: string;
  pages: Record<string, { state: PageState; error: string; t: number }>;
}

const nowS = () => Date.now() / 1000;

export class RunState {
  data: RunData = null as unknown as RunData;
  private chain: Promise<void> = Promise.resolve();

  constructor(private store: ProjectStore, readonly projectId: string, private bus?: EventBus) {}

  begin(stages: string[], pageIds: string[], initial: Record<string, PageState>, force: boolean, jobId: string): Promise<void> {
    const t = nowS();
    this.data = {
      version: 1, job_id: jobId, status: 'running', stages, force, started: t, updated: t, finished: null, error: '', language: '',
      pages: Object.fromEntries(pageIds.map((pid) => [pid, { state: initial[pid] ?? 'pending', error: '', t }])),
    };
    const saved = this.save();
    this.emitRun();
    return saved;
  }

  finish(status: Exclude<RunStatus, 'interrupted'>, error = ''): Promise<void> {
    if (!this.data) return Promise.resolve();
    Object.assign(this.data, { status, error, finished: nowS(), updated: nowS() });
    const saved = this.save();
    this.emitRun();
    return saved;
  }

  setStatus(status: Exclude<RunStatus, 'interrupted'>): void {
    if (this.data && this.data.status !== status) {
      this.data.status = status;
      void this.save();
      this.emitRun();
    }
  }

  setLanguage(lang: string): void {
    this.data.language = lang;
    void this.save();
  }

  setPage(pageId: string, state: PageState, error = ''): void {
    const entry = this.data.pages[pageId];
    if (!entry) return;
    Object.assign(entry, { state, error, t: nowS() });
    this.data.updated = nowS();
    void this.save();
    this.bus?.publish({ type: 'page', project_id: this.projectId, page_id: pageId, state, error });
  }

  counts(): RunInfo['counts'] {
    return countStates(Object.values(this.data?.pages ?? {}).map((p) => p.state));
  }

  /** Espera a que todo lo pendiente esté escrito. */
  flush(): Promise<void> { return this.chain; }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.chain = this.chain.then(() => this.store.saveRun(this.projectId, snapshot)).catch((e) => { console.warn('No se pudo guardar el estado de la ejecución', e); });
    return this.chain;
  }

  private emitRun(): void {
    this.bus?.publish({ type: 'run', project_id: this.projectId, status: this.data.status, counts: this.counts() });
  }
}

export function countStates(states: PageState[]): RunInfo['counts'] {
  const n = (s: PageState) => states.filter((x) => x === s).length;
  const total = states.length;
  return { total, done: n('done'), error: n('error'), pending: n('pending'), active: total - n('done') - n('error') - n('pending') };
}

/** Estado público de la última ejecución, marcando como «interrumpida» la que quedó a medias sin tarea viva. */
export async function describeRun(store: ProjectStore, projectId: string, hasActiveJob: boolean): Promise<RunInfo | null> {
  const data = await store.loadRun<RunData>(projectId);
  if (!data) return null;
  const pages = data.pages ?? {};
  const states = Object.values(pages).map((p) => p.state);
  let status: RunStatus = data.status ?? 'done';
  const interrupted = (status === 'running' || status === 'paused') && !hasActiveJob;
  if (interrupted) status = 'interrupted';
  const counts = countStates(states);
  return {
    status, interrupted, job_id: data.job_id ?? null, stages: (data.stages ?? []) as RunInfo['stages'], started: data.started ?? null,
    updated: data.updated ?? null, finished: data.finished ?? null, error: data.error ?? '', language: data.language ?? '', pages, counts,
    resumable: ['interrupted', 'error', 'cancelled'].includes(status) && counts.done < states.length,
  };
}
