/** Acciones de alto nivel de la interfaz sobre el motor, con mensajes accionables cuando falta algo. */
import type { Job, ProcessStage } from '@starblitz/shared';
import { AppError } from '../engine/core/errors';
import { navigate } from '../router';
import { confirmAction, engine, reportError, useApp } from '../state/app';

/** Si falta un modelo o el motor de lenguaje, lleva a «Modelos» en lugar de limitarse a mostrar un error. */
async function explainMissing(e: unknown): Promise<boolean> {
  if (e instanceof AppError && (e.code === 'model_missing' || e.code === 'llm_unavailable')) {
    const go = await confirmAction({ title: 'Falta preparar el teléfono', message: e.message, confirm: 'Ir a Modelos' });
    if (go) navigate('/models');
    return true;
  }
  return false;
}

export async function startProcess(projectId: string, opts: { stages?: ProcessStage[]; page_ids?: string[]; force?: boolean; resume?: boolean } = {}): Promise<Job | null> {
  try {
    const job = await engine().process(projectId, opts);
    useApp.getState().upsertJob(job);
    void useApp.getState().loadRun(projectId);
    return job;
  } catch (e) {
    if (!(await explainMissing(e))) reportError(e, opts.resume ? 'No se pudo reanudar' : 'No se pudo iniciar');
    return null;
  }
}

export { explainMissing };
