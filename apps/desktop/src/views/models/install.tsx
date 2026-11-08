import { client, isLive, reportError, useApp } from '../../store';
import { JobProgress } from '../../components/Jobs';

/** Lanza la descarga e instalación de un GGUF desde Hugging Face (comprobación de compatibilidad incluida en el motor). */
export async function startInstall(repo: string, file: string, opts: { mmproj?: string | null; force?: boolean } = {}) {
  try {
    useApp.getState().upsertJob(await client().installLLM(repo, file, opts));
  } catch (e) { reportError(e, 'No se pudo iniciar la descarga'); }
}

/** Descargas en curso (con pausa/reanudación y cancelación) de los tipos indicados. */
export function DownloadStatus({ kinds }: { kinds: string[] }) {
  const jobs = useApp((s) => s.jobs);
  const live = Object.values(jobs).filter((j) => kinds.includes(j.kind) && isLive(j));
  if (!live.length) return null;
  return (
    <div className="panel job-panel" aria-live="polite">
      {live.map((j) => <JobProgress key={j.id} job={j} />)}
    </div>
  );
}
