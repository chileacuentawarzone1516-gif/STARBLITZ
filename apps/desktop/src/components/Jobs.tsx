import { Brain, Check, Pause, Play, ScanText, Sparkles, X } from 'lucide-react';
import { formatDuration, STAGE_LABELS, type Job } from '@starblitz/shared';
import { useEffect, useState } from 'react';
import { client, reportError } from '../store';

const PIPELINE = [
  { id: 'analyze', icon: ScanText },
  { id: 'translate', icon: Brain },
  { id: 'clean', icon: Sparkles },
];

function useElapsed(job: Job) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    if (job.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [job.status]);
  return job.started ? (job.finished ?? now) - job.started : 0;
}

/** Botones de control de una tarea: pausar/reanudar (si la tarea lo admite) y cancelar. */
export function JobControls({ job, size = 'sm' }: { job: Job; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'btn btn-ghost btn-sm' : 'btn btn-sm';
  const call = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { reportError(e); }
  };
  const live = job.status === 'queued' || job.status === 'running' || job.status === 'paused';
  if (!live) return null;
  return (
    <div className="row" style={{ gap: 6 }}>
      {job.pausable && job.status === 'running' && (
        <button className={cls} onClick={() => call(() => client().pauseJob(job.id))}><Pause />Pausar</button>
      )}
      {job.pausable && job.status === 'paused' && (
        <button className={`${cls} btn-primary`} onClick={() => call(() => client().resumeJob(job.id))}><Play />Reanudar</button>
      )}
      <button className={cls} onClick={() => call(() => client().cancelJob(job.id))}><X />Cancelar</button>
    </div>
  );
}

/** Progreso de una tarea; para el procesamiento completo muestra la secuencia real de etapas. */
export function JobProgress({ job, stages, compact }: { job: Job; stages?: string[]; compact?: boolean }) {
  const elapsed = useElapsed(job);
  const pct = Math.round(job.progress * 100);
  const paused = job.status === 'paused';
  const eta = job.status === 'running' ? job.eta_s : null;
  const pipeline = job.kind === 'process' ? PIPELINE.filter((p) => !stages || stages.includes(p.id)) : [];
  const currentIdx = pipeline.findIndex((p) => p.id === job.stage);

  return (
    <div className={`job ${compact ? 'job-compact' : ''}`}>
      {pipeline.length > 0 && (
        <ol className="pipeline" aria-label="Etapas del procesamiento">
          {pipeline.map((p, i) => {
            const state = job.stage === 'done' || i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'todo';
            const Icon = state === 'done' ? Check : p.icon;
            return (
              <li key={p.id} className={`pipeline-step ${state}`}>
                <span className="pipeline-dot"><Icon aria-hidden /></span>
                <span>{STAGE_LABELS[p.id]}</span>
              </li>
            );
          })}
        </ol>
      )}
      <div className="job-row">
        <div className="job-text">
          <strong>{paused ? 'En pausa' : job.message || job.title}</strong>
          <span className="small muted mono">
            {job.status === 'queued' ? 'En cola' : `${pct} %`}
            {elapsed > 0 && ` · ${formatDuration(elapsed)}`}
            {eta !== null && eta !== undefined && ` · quedan ~${formatDuration(eta)}`}
          </span>
        </div>
        <JobControls job={job} />
      </div>
      <div className={`progress ${job.status === 'queued' ? 'indeterminate' : ''} ${paused ? 'paused' : ''}`} role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={job.title}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
