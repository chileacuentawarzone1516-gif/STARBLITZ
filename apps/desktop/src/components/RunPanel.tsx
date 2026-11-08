import { AlertTriangle, Languages, Play, RotateCcw } from 'lucide-react';
import { LANGUAGES, plural, type Job, type Project, type RunInfo } from '@starblitz/shared';
import { JobProgress } from './Jobs';
import { client, reportError, useApp } from '../store';

/** Cuántas páginas hay en cada punto del recorrido (listas, en curso, pendientes, con error). */
export function RunCounts({ counts }: { counts: RunInfo['counts'] }) {
  const parts = [
    { cls: 'ok', n: counts.done, label: counts.done === 1 ? 'terminada' : 'terminadas' },
    { cls: 'busy', n: counts.active, label: 'en curso' },
    { cls: 'todo', n: counts.pending, label: counts.pending === 1 ? 'pendiente' : 'pendientes' },
    { cls: 'err', n: counts.error, label: counts.error === 1 ? 'con error' : 'con error' },
  ].filter((p) => p.n > 0);
  return (
    <ul className="run-counts" aria-label="Estado de las páginas">
      {parts.map((p) => <li key={p.label} className={p.cls}><strong className="mono">{p.n}</strong> {p.label}</li>)}
    </ul>
  );
}

/** Estado del procesamiento automático del proyecto: progreso global, ETA, pausa/reanudación y recuperación. */
export function RunPanel({ project, job, run }: { project: Project; job: Job | undefined; run: RunInfo | null | undefined }) {
  const detected = project.source_lang === 'auto' && project.detected_lang ? LANGUAGES[project.detected_lang] ?? project.detected_lang : '';

  const resume = async () => {
    try { useApp.getState().upsertJob(await client().process(project.id, { resume: true })); } catch (e) { reportError(e, 'No se pudo reanudar'); }
  };

  if (job && job.kind === 'process') {
    return (
      <section className="panel run-panel" aria-label="Procesamiento del proyecto">
        <JobProgress job={job} stages={run?.stages} />
        <div className="run-meta">
          {run && <RunCounts counts={run.counts} />}
          {detected && <span className="chip chip-blue"><Languages aria-hidden />Idioma detectado: {detected}</span>}
        </div>
        <p className="small muted">Puedes abrir las páginas terminadas mientras el resto se procesa. Si cierras STARBLITZ, el avance se conserva y podrás reanudar.</p>
      </section>
    );
  }
  if (run && run.resumable && (run.interrupted || run.status === 'error' || run.status === 'cancelled')) {
    const title = run.interrupted ? 'El procesamiento se interrumpió' : run.status === 'error' ? 'El procesamiento se detuvo por un error' : 'Procesamiento cancelado';
    return (
      <section className="panel run-panel run-interrupted" role="alert">
        <div className="run-interrupted-head">
          <AlertTriangle aria-hidden />
          <div>
            <strong>{title}</strong>
            <p className="small muted">
              {plural(run.counts.done, 'página terminada', 'páginas terminadas')} de {run.counts.total}; lo terminado se conserva y no se repetirá.
              {run.error && <> <span className="text-danger">{run.error}</span></>}
            </p>
          </div>
          <button className="btn btn-primary" onClick={resume}>{run.interrupted ? <RotateCcw /> : <Play />}Reanudar</button>
        </div>
        <RunCounts counts={run.counts} />
      </section>
    );
  }
  return null;
}
