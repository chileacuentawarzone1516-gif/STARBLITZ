import type { Page, Project, ProjectSummary, RunInfo } from '@starblitz/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { engine, reportError, useApp } from './state/app';

export interface Bundle { project: Project; pages: Page[]; summary: ProjectSummary; run: RunInfo | null }

/** Proyecto abierto: se recarga solo cuando el motor cambia páginas o termina una tarea suya. */
export function useBundle(id: string) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [missing, setMissing] = useState(false);
  const tick = useApp((s) => s.pageTicks[id] ?? 0);
  const finished = useApp((s) => Object.values(s.jobs).filter((j) => j.project_id === id && ['done', 'error', 'cancelled'].includes(j.status)).length);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(async () => {
    try { setBundle(await engine().project(id)); setMissing(false); } catch (e) {
      if ((e as { code?: string })?.code === 'not_found') setMissing(true); else reportError(e);
    }
  }, [id]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void load(); }, tick ? 300 : 0);
    return () => clearTimeout(timer.current);
  }, [load, tick, finished]);
  return { bundle, reload: load, missing };
}
