/** Estado global de STARBLITZ Mobile: el motor local, sus tareas en vivo, los proyectos y los avisos. */
import { create } from 'zustand';
import type { Job, PageState, ProjectSummary, RunInfo, RunStatus, SystemInfo } from '@starblitz/shared';
import type { LocalEngine } from '../engine/api/localEngine';
import type { EngineEvent } from '../engine/core/events';
import { navigate } from '../router';
import { createDeviceEngine, type DeviceEngine, type DeviceEngineOptions } from '../engine/host/bootstrap';

export type ToastKind = 'info' | 'ok' | 'error';
export interface Toast { id: number; kind: ToastKind; text: string }

export interface ConfirmOptions { title: string; message?: string; confirm?: string; danger?: boolean }
interface PendingConfirm extends ConfirmOptions { resolve(ok: boolean): void }

interface AppState {
  boot: 'loading' | 'ready' | 'error';
  bootError: string;
  handle: DeviceEngine | null;
  system: SystemInfo | null;
  projects: ProjectSummary[];
  jobs: Record<string, Job>;
  /** Última ejecución de cada proyecto (se alimenta al cargar y con los eventos del motor). */
  runs: Record<string, RunInfo | null>;
  /** Sube cada vez que una página de un proyecto cambia de estado: refresca miniaturas. */
  pageTicks: Record<string, number>;
  toasts: Toast[];
  sheet: string | null;
  confirm: PendingConfirm | null;
  start(opts?: DeviceEngineOptions): Promise<void>;
  refreshProjects(): Promise<void>;
  refreshSystem(): Promise<void>;
  loadRun(projectId: string): Promise<void>;
  upsertJob(job: Job): void;
  toast(kind: ToastKind, text: string): void;
  openSheet(id: string | null): void;
  ask(options: ConfirmOptions): Promise<boolean>;
  answer(ok: boolean): void;
}

let toastSeq = 0;
let started: Promise<void> | null = null;

export const useApp = create<AppState>((set, get) => ({
  boot: 'loading',
  bootError: '',
  handle: null,
  system: null,
  projects: [],
  jobs: {},
  runs: {},
  pageTicks: {},
  toasts: [],
  sheet: null,
  confirm: null,

  start: (opts) => {
    started ??= (async () => {
      try {
        const handle = await createDeviceEngine(opts);
        set({ handle });
        // Solo en la compilación de pruebas (VITE_E2E=1): permite a las pruebas de Chromium preparar ajustes. No existe en la app publicada.
        if (import.meta.env.VITE_E2E) (window as unknown as { __sb?: unknown }).__sb = { engine: handle.engine };
        handle.engine.listen((e) => onEvent(e));
        await Promise.all([get().refreshProjects(), get().refreshSystem()]);
        for (const p of get().projects) void get().loadRun(p.id);
        set({ boot: 'ready' });
      } catch (e) {
        started = null;
        set({ boot: 'error', bootError: (e as Error)?.message || String(e) });
      }
    })();
    return started;
  },

  refreshProjects: async () => {
    const h = get().handle;
    if (!h) return;
    try { set({ projects: await h.engine.projects() }); } catch (e) { reportError(e); }
  },
  refreshSystem: async () => {
    const h = get().handle;
    if (!h) return;
    try { set({ system: await h.engine.system() }); } catch (e) { reportError(e); }
  },
  loadRun: async (projectId) => {
    const h = get().handle;
    if (!h) return;
    try {
      const run = await h.engine.run(projectId);
      set((s) => ({ runs: { ...s.runs, [projectId]: run } }));
    } catch { set((s) => ({ runs: { ...s.runs, [projectId]: null } })); }
  },
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),

  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  },
  openSheet: (sheet) => set({ sheet }),
  ask: (options) => new Promise<boolean>((resolve) => {
    get().confirm?.resolve(false);
    set({ confirm: { ...options, resolve } });
  }),
  answer: (ok) => {
    const c = get().confirm;
    set({ confirm: null });
    c?.resolve(ok);
  },
}));

// -- eventos del motor -------------------------------------------------------------------------------------------
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleRefresh = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void useApp.getState().refreshProjects(); }, 250);
};

const TERMINAL = new Set(['done', 'error', 'cancelled']);

function countStates(pages: RunInfo['pages']): RunInfo['counts'] {
  const states = Object.values(pages).map((p) => p.state);
  const total = states.length;
  const done = states.filter((x) => x === 'done').length;
  const error = states.filter((x) => x === 'error').length;
  const pending = states.filter((x) => x === 'pending').length;
  return { total, done, error, pending, active: total - done - error - pending };
}

function onEvent(e: EngineEvent): void {
  const s = useApp.getState();
  if (e.type === 'job') {
    s.upsertJob(e.job);
    if (TERMINAL.has(e.job.status)) {
      scheduleRefresh();
      if (e.job.project_id) void s.loadRun(e.job.project_id);
      if (e.job.kind === 'model_install' || e.job.kind === 'llm_install') void s.refreshSystem();
    }
  } else if (e.type === 'page') {
    applyPage(e.project_id, e.page_id, e.state, e.error);
  } else if (e.type === 'run') {
    applyRun(e.project_id, e.status, e.counts);
  }
}

function applyPage(projectId: string, pageId: string, state: PageState, error: string): void {
  useApp.setState((s) => {
    const pageTicks = { ...s.pageTicks, [projectId]: (s.pageTicks[projectId] ?? 0) + 1 };
    const run = s.runs[projectId];
    if (!run) return { pageTicks };
    const pages = { ...run.pages, [pageId]: { state, error, t: Date.now() / 1000 } };
    return { pageTicks, runs: { ...s.runs, [projectId]: { ...run, pages, counts: countStates(pages) } } };
  });
}

function applyRun(projectId: string, status: RunStatus, counts: RunInfo['counts']): void {
  useApp.setState((s) => {
    const run = s.runs[projectId];
    if (!run) { void s.loadRun(projectId); return {}; }
    return { runs: { ...s.runs, [projectId]: { ...run, status, interrupted: false, counts } } };
  });
}

// -- accesos cómodos ---------------------------------------------------------------------------------------------
export function engine(): LocalEngine {
  const h = useApp.getState().handle;
  if (!h) throw new Error('El motor todavía no está listo.');
  return h.engine;
}

/** Muestra un error comprensible; nunca trazas técnicas. */
export function reportError(err: unknown, title?: string): void {
  if ((err as Error)?.name === 'AbortError' || (err as { code?: string })?.code === 'cancelled') return;
  const message = (err as Error)?.message || String(err);
  useApp.getState().toast('error', title ? `${title}: ${message}` : message);
}

export const toast = (kind: ToastKind, text: string) => useApp.getState().toast(kind, text);
export const confirmAction = (o: ConfirmOptions) => useApp.getState().ask(o);

/** Espera a que una tarea termine (por los eventos del motor) y la devuelve. */
export function waitForJob(id: string): Promise<Job> {
  return new Promise<Job>((resolve) => {
    let unsub = () => undefined as void;
    const check = (jobs: Record<string, Job>) => {
      const j = jobs[id];
      if (j && ['done', 'error', 'cancelled'].includes(j.status)) { unsub(); resolve(j); return true; }
      return false;
    };
    if (check(useApp.getState().jobs)) return;
    unsub = useApp.subscribe((s) => { check(s.jobs); });
  });
}

export const isLive = (j: Job) => j.status === 'queued' || j.status === 'running' || j.status === 'paused';

export function useActiveJob(projectId: string | undefined, kinds?: string[]): Job | undefined {
  return useApp((s) => Object.values(s.jobs)
    .filter((j) => j.project_id === projectId && isLive(j) && (!kinds || kinds.includes(j.kind)))
    .sort((a, b) => b.created - a.created)[0]);
}

export function useActiveKind(kind: string): Job | undefined {
  return useApp((s) => Object.values(s.jobs).filter((j) => j.kind === kind && isLive(j)).sort((a, b) => b.created - a.created)[0]);
}

/** Botón Atrás de Android: primero cierra lo que esté encima (diálogo, hoja), luego retrocede; en la raíz sale de la app. */
export function handleBack(): boolean {
  const s = useApp.getState();
  if (s.confirm) { s.answer(false); return true; }
  if (s.sheet) { s.openSheet(null); return true; }
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (hash !== '/') {
    if (history.length > 1) history.back(); else navigate('/'); // sin historial (enlace directo): vuelve al inicio en vez de quedarse atascado
    return true;
  }
  return false;
}
