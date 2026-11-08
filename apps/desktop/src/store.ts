/** Estado global de la app de escritorio. */
import { create } from 'zustand';
import {
  EngineClient, EngineError, type Job, type PageState, type ProjectSummary, type RunInfo, type RunStatus, type SystemInfo,
} from '@starblitz/shared';

export type ToastKind = 'info' | 'ok' | 'error';
export interface Toast { id: number; kind: ToastKind; title: string; message?: string }

interface AppState {
  client: EngineClient | null;
  connected: boolean;
  system: SystemInfo | null;
  projects: ProjectSummary[];
  jobs: Record<string, Job>;
  /** Estado en vivo de la última ejecución de cada proyecto (se alimenta de la carga y de los eventos del motor). */
  runs: Record<string, RunInfo | null>;
  /** Contador por proyecto que sube cada vez que una página cambia de estado (para refrescar miniaturas). */
  pageTicks: Record<string, number>;
  toasts: Toast[];
  setClient(client: EngineClient): void;
  setConnected(v: boolean): void;
  refreshSystem(): Promise<void>;
  refreshProjects(): Promise<void>;
  upsertJob(job: Job): void;
  setRun(projectId: string, run: RunInfo | null): void;
  applyPageEvent(e: { project_id: string; page_id: string; state: PageState; error: string }): void;
  applyRunEvent(e: { project_id: string; status: RunStatus; counts: RunInfo['counts'] }): void;
  toast(kind: ToastKind, title: string, message?: string): void;
  dismiss(id: number): void;
}

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  client: null,
  connected: false,
  system: null,
  projects: [],
  jobs: {},
  runs: {},
  pageTicks: {},
  toasts: [],
  setClient: (client) => set({ client }),
  setConnected: (connected) => set({ connected }),
  refreshSystem: async () => {
    const c = get().client;
    if (!c) return;
    try { set({ system: await c.system() }); } catch (e) { reportError(e); }
  },
  refreshProjects: async () => {
    const c = get().client;
    if (!c) return;
    try { set({ projects: await c.projects() }); } catch (e) { reportError(e); }
  },
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  setRun: (projectId, run) => set((s) => ({ runs: { ...s.runs, [projectId]: run } })),
  applyPageEvent: (e) => set((s) => {
    const run = s.runs[e.project_id];
    const pageTicks = { ...s.pageTicks, [e.project_id]: (s.pageTicks[e.project_id] ?? 0) + 1 };
    if (!run) return { pageTicks };
    const pages = { ...run.pages, [e.page_id]: { state: e.state, error: e.error, t: Date.now() / 1000 } };
    return { pageTicks, runs: { ...s.runs, [e.project_id]: { ...run, pages, counts: countStates(pages) } } };
  }),
  applyRunEvent: (e) => set((s) => {
    const run = s.runs[e.project_id];
    if (!run) return {};
    const status = run.status === 'interrupted' && e.status === 'running' ? 'running' : e.status;
    return { runs: { ...s.runs, [e.project_id]: { ...run, status, interrupted: false, counts: e.counts } } };
  }),
  toast: (kind, title, message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, message }] }));
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function client(): EngineClient {
  const c = useApp.getState().client;
  if (!c) throw new EngineError('offline', 'El motor no está conectado.', 0);
  return c;
}

/** Muestra un error comprensible; nunca trazas técnicas. */
export function reportError(err: unknown, title = 'No se pudo completar la acción') {
  const message = err instanceof EngineError || err instanceof Error ? err.message : String(err);
  useApp.getState().toast('error', title, message);
}

function countStates(pages: RunInfo['pages']): RunInfo['counts'] {
  const states = Object.values(pages).map((p) => p.state);
  const total = states.length;
  const done = states.filter((x) => x === 'done').length;
  const error = states.filter((x) => x === 'error').length;
  const pending = states.filter((x) => x === 'pending').length;
  return { total, done, error, pending, active: total - done - error - pending };
}

export const isLive = (j: Job) => j.status === 'queued' || j.status === 'running' || j.status === 'paused';

/** Tarea activa (en cola, ejecutándose o en pausa) de un proyecto. */
export function useActiveJob(projectId: string | undefined, kinds?: string[]): Job | undefined {
  return useApp((s) => Object.values(s.jobs)
    .filter((j) => j.project_id === projectId && isLive(j) && (!kinds || kinds.includes(j.kind)))
    .sort((a, b) => b.created - a.created)[0]);
}

/** Tarea activa de un tipo que no pertenece a ningún proyecto (descarga de un modelo, comparación…). */
export function useActiveKind(kind: string): Job | undefined {
  return useApp((s) => Object.values(s.jobs).filter((j) => j.kind === kind && isLive(j)).sort((a, b) => b.created - a.created)[0]);
}
