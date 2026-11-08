import { AlertTriangle, BookOpen, CheckCircle2, Download, Play, Sparkles } from 'lucide-react';
import { formatRelative, LANGUAGES, plural, type ProjectSummary } from '@starblitz/shared';
import { useImageUrl } from '../components/images';
import { EmptyState } from '../components/ui';
import { tap } from '../lib/platform';
import { navigate } from '../router';
import { engine, isLive, reportError, useApp } from '../state/app';

function ProjectRow({ project }: { project: ProjectSummary }) {
  const url = useImageUrl(project.id, project.cover_page_id, 'thumb');
  const job = useApp((s) => Object.values(s.jobs).find((j) => j.project_id === project.id && j.kind === 'process' && isLive(j)));
  const pct = project.regions ? project.translated / project.regions : 0;
  const lang = LANGUAGES[project.source_lang === 'auto' ? project.detected_lang || 'auto' : project.source_lang] ?? project.source_lang;
  return (
    <button className="m-project" onClick={() => { tap(); navigate(`/p/${project.id}`); }}>
      <div className="m-cover">{url && <img src={url} alt="" />}</div>
      <div className="m-project-info">
        <strong>{project.name}</strong>
        <span className="muted small">{plural(project.page_count, 'página', 'páginas')} · {lang}</span>
        <span className="faint small">{formatRelative(project.updated)}</span>
        <div className="m-project-progress">
          <div className="progress"><i style={{ width: `${Math.round((job ? job.progress : pct) * 100)}%` }} /></div>
          <span className="small mono muted">{job ? `${Math.round(job.progress * 100)} %` : project.regions ? `${Math.round(pct * 100)} %` : 'Sin traducir'}</span>
        </div>
        <div className="m-chip-row">
          {job && <span className={`chip ${job.status === 'paused' ? 'chip-warn' : 'chip-blue'}`}>{job.status === 'paused' ? 'En pausa' : 'Procesando'}</span>}
          {project.review > 0 && <span className="chip chip-review">{project.review} por revisar</span>}
        </div>
      </div>
    </button>
  );
}

/** Qué le falta a ESTE teléfono para traducir sin Internet. No descarga nada por su cuenta: lleva a Modelos, donde se ve el tamaño y si cabe. */
function Readiness() {
  const system = useApp((s) => s.system);
  if (!system) return null;
  const detector = system.models.find((m) => m.id === 'text-detector');
  const missing: string[] = [];
  if (detector && !detector.installed) missing.push('detector de texto');
  if (!system.llm.ready) missing.push(system.llm.runtime_available ? 'modelo de traducción' : 'motor de lenguaje (no disponible en este teléfono)');
  if (!missing.length) {
    return <div className="m-ready ok"><CheckCircle2 /><span>Todo listo: traduce sin conexión.</span></div>;
  }
  return (
    <div className="m-ready" role="status">
      <Download />
      <div>
        <strong>Falta preparar este teléfono</strong>
        <p className="small muted">Descarga una sola vez: {missing.join(' y ')}. Después todo funciona sin Internet.</p>
      </div>
      <button className="btn btn-sm btn-primary" onClick={() => navigate('/models')}>Modelos</button>
    </div>
  );
}

function Interrupted() {
  const projects = useApp((s) => s.projects);
  const runs = useApp((s) => s.runs);
  const jobs = useApp((s) => s.jobs);
  const items = projects.filter((p) => {
    const run = runs[p.id];
    return run?.resumable && (run.interrupted || run.status === 'error') && !Object.values(jobs).some((j) => j.project_id === p.id && isLive(j));
  });
  if (!items.length) return null;
  return (
    <>
      {items.map((p) => {
        const run = runs[p.id]!;
        return (
          <div className="m-ready warn" role="alert" key={p.id}>
            <AlertTriangle />
            <div>
              <strong>«{p.name}» quedó a medias</strong>
              <p className="small muted">{run.counts.done} de {run.counts.total} páginas terminadas; lo hecho se conserva.</p>
            </div>
            <button className="btn btn-sm btn-primary" onClick={async () => {
              try { useApp.getState().upsertJob(await engine().process(p.id, { resume: true })); navigate(`/p/${p.id}`); } catch (e) { reportError(e, 'No se pudo reanudar'); }
            }}><Play />Reanudar</button>
          </div>
        );
      })}
    </>
  );
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const openSheet = useApp((s) => s.openSheet);
  return (
    <div className="m-screen">
      <header className="m-home-head">
        <div className="m-brand"><img src="./mark.svg" width={30} height={30} alt="" /><span className="wordmark">STARBLITZ</span></div>
        <span className="m-pill"><Sparkles aria-hidden />En tu teléfono</span>
      </header>
      <h1 className="m-title">Proyectos</h1>
      <Readiness />
      <Interrupted />
      {projects.length ? (
        <div className="m-list">{projects.map((p) => <ProjectRow key={p.id} project={p} />)}</div>
      ) : (
        <EmptyState icon={<BookOpen />} title="Todavía no hay proyectos"
          action={<button className="btn btn-primary" onClick={() => openSheet('import')}>Importar un capítulo</button>}>
          Importa un ZIP, PDF o imágenes (JPG, PNG, WEBP). Todo se procesa en este teléfono.
        </EmptyState>
      )}
    </div>
  );
}
