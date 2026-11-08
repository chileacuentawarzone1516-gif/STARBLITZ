/** Hooks compartidos por las vistas que leen ajustes o el estado de los modelos de traducción. */
import type { DeepPartial, LLMOverview, Settings } from '@starblitz/shared';
import { useCallback, useEffect, useState } from 'react';
import { client, reportError, useApp } from './store';

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => { client().settings().then(setSettings).catch(reportError); }, []);
  const update = useCallback(async (patch: DeepPartial<Settings>) => {
    try {
      setSettings(await client().updateSettings(patch));
      useApp.getState().refreshSystem();
    } catch (e) { reportError(e, 'No se pudo guardar el ajuste'); }
  }, []);
  return { settings, update };
}

export type UpdateSettings = (patch: DeepPartial<Settings>) => Promise<void>;

/** Estado de los modelos de traducción; se recarga solo cuando termina una descarga o una comparación. */
export function useLLM() {
  const [data, setData] = useState<LLMOverview | null>(null);
  const jobs = useApp((s) => s.jobs);
  const finished = Object.values(jobs).filter((j) => j.kind === 'llm_install' && (j.status === 'done' || j.status === 'cancelled' || j.status === 'error')).length;
  const reload = useCallback(() => client().llm().then(setData).catch(reportError), []);
  useEffect(() => { reload(); }, [reload, finished]);
  return { data, reload };
}
