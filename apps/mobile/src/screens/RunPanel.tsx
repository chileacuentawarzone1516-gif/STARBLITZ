import { AlertTriangle, Languages, Play, RotateCcw } from 'lucide-react';
import { LANGUAGES, PAGE_STATE_LABELS, plural, type Job, type Page, type Project, type RunInfo } from '@starblitz/shared';
import { PageCanvas, TranslatedThumb, useImageUrl } from '../components/images';
import { JobProgress } from '../components/ui';
import { startProcess } from '../lib/actions';
import { navigate } from '../router';

export function RunCounts({ counts }: { counts: RunInfo['counts'] }) {
  const parts = [
    { cls: 'ok', n: counts.done, label: counts.done === 1 ? 'terminada' : 'terminadas' },
    { cls: 'busy', n: counts.active, label: 'en curso' },
    { cls: 'todo', n: counts.pending, label: counts.pending === 1 ? 'pendiente' : 'pendientes' },
    { cls: 'err', n: counts.error, label: 'con error' },
  ].filter((p) => p.n > 0);
  return (
    <ul className="m-run-counts" aria-label="Estado de las páginas">
      {parts.map((p) => <li key={p.label} className={p.cls}><strong className="mono">{p.n}</strong> {p.label}</li>)}
    </ul>
  );
}

/** Última página terminada: original y traducción lado a lado, para ver el resultado sin esperar al final. */
function LivePreview({ projectId, page }: { projectId: string; page: Page }) {
  const original = useImageUrl(projectId, page.id, 'thumb');
  return (
    <button className="m-live" onClick={() => navigate(`/p/${projectId}/read/${page.index}`)} aria-label={`Abrir la página ${page.index + 1} ya traducida`}>
      <figure><div className="m-live-img">{original && <img src={original} alt="" />}</div><figcaption>Original</figcaption></figure>
      <figure><div className="m-live-img"><TranslatedThumb projectId={projectId} page={page} /></div><figcaption>Página {page.index + 1} traducida</figcaption></figure>
    </button>
  );
}

/** Progreso del procesamiento del proyecto: etapas, ETA, pausa, errores por página y recuperación tras una interrupción. */
export function RunPanel({ project, pages, job, run }: { project: Project; pages: Page[]; job: Job | undefined; run: RunInfo | null | undefined }) {
  const detected = project.source_lang === 'auto' && project.detected_lang ? LANGUAGES[project.detected_lang] ?? project.detected_lang : '';
  const lastDone = run ? [...pages].reverse().find((p) => run.pages[p.id]?.state === 'done' && p.has_clean) : undefined;
  const failed = run ? pages.filter((p) => run.pages[p.id]?.state === 'error') : [];

  if (job && job.kind === 'process') {
    return (
      <section className="m-run panel" aria-label="Procesamiento del proyecto">
        <JobProgress job={job} stages={run?.stages} />
        <div className="m-run-meta">
          {run && <RunCounts counts={run.counts} />}
          {detected && <span className="chip chip-blue"><Languages aria-hidden />Idioma detectado: {detected}</span>}
        </div>
        {lastDone && <LivePreview projectId={project.id} page={lastDone} />}
        {failed.length > 0 && (
          <ul className="m-run-errors" aria-label="Páginas con error">
            {failed.map((p) => <li key={p.id}><AlertTriangle aria-hidden /><span><strong>Página {p.index + 1}</strong> · {run!.pages[p.id].error || PAGE_STATE_LABELS.error}</span></li>)}
          </ul>
        )}
        <p className="small muted">Puedes abrir las páginas terminadas mientras el resto se procesa. Si cierras la app, el avance se conserva y podrás reanudar. Mantén el teléfono cargando y ventilado.</p>
      </section>
    );
  }
  if (run && run.resumable && (run.interrupted || run.status === 'error' || run.status === 'cancelled')) {
    const title = run.interrupted ? 'El procesamiento se interrumpió' : run.status === 'error' ? 'El procesamiento se detuvo por un error' : 'Procesamiento cancelado';
    return (
      <section className="m-run panel interrupted" role="alert">
        <div className="m-run-head">
          <AlertTriangle aria-hidden />
          <div>
            <strong>{title}</strong>
            <p className="small muted">
              {plural(run.counts.done, 'página terminada', 'páginas terminadas')} de {run.counts.total}; lo terminado se conserva y no se repetirá.
              {run.error && <> <span className="text-danger">{run.error}</span></>}
            </p>
          </div>
        </div>
        <RunCounts counts={run.counts} />
        {failed.length > 0 && (
          <ul className="m-run-errors">
            {failed.map((p) => <li key={p.id}><AlertTriangle aria-hidden /><span><strong>Página {p.index + 1}</strong> · {run.pages[p.id].error}</span></li>)}
          </ul>
        )}
        <button className="btn btn-primary m-block" onClick={() => startProcess(project.id, { resume: true })}>{run.interrupted ? <RotateCcw /> : <Play />}Reanudar</button>
      </section>
    );
  }
  return null;
}

export { PageCanvas };
