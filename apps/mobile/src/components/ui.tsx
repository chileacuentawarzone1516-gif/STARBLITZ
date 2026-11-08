import { AlertTriangle, Brain, Check, CheckCircle2, Info, Pause, Play, ScanText, Sparkles, X } from 'lucide-react';
import { formatDuration, STAGE_LABELS, type Job } from '@starblitz/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { engine, reportError, useApp } from '../state/app';

/** Hoja inferior táctil: se cierra con el fondo, con Atrás o deslizando el asa hacia abajo. */
export function Sheet({ id, title, children, onClose }: { id: string; title?: string; children: ReactNode; onClose?: () => void }) {
  const sheet = useApp((s) => s.sheet);
  const openSheet = useApp((s) => s.openSheet);
  const open = sheet === id;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current) { wasOpen.current = false; onClose?.(); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;
  let startY = 0;
  return (
    <div className="m-sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) openSheet(null); }}>
      <section className="m-sheet" role="dialog" aria-modal="true" aria-label={title}
        onTouchStart={(e) => { startY = e.touches[0].clientY; }}
        onTouchEnd={(e) => { if (e.changedTouches[0].clientY - startY > 90 && (e.target as HTMLElement).closest('.m-sheet-grip')) openSheet(null); }}>
        <div className="m-sheet-grip" aria-hidden><i /></div>
        {title && (
          <header className="m-sheet-head">
            <h3>{title}</h3>
            <button className="m-icon-btn" aria-label="Cerrar" onClick={() => openSheet(null)}><X /></button>
          </header>
        )}
        <div className="m-sheet-body">{children}</div>
      </section>
    </div>
  );
}

/** Confirmación propia (los diálogos del navegador no son accesibles ni se ven como parte de la app). */
export function ConfirmDialog() {
  const c = useApp((s) => s.confirm);
  const answer = useApp((s) => s.answer);
  if (!c) return null;
  return (
    <div className="m-sheet-backdrop center" onClick={(e) => { if (e.target === e.currentTarget) answer(false); }}>
      <section className="m-dialog" role="alertdialog" aria-modal="true" aria-labelledby="m-dialog-title" aria-describedby={c.message ? 'm-dialog-msg' : undefined}>
        <h3 id="m-dialog-title">{c.title}</h3>
        {c.message && <p id="m-dialog-msg" className="muted">{c.message}</p>}
        <div className="m-dialog-actions">
          <button className="btn btn-ghost" onClick={() => answer(false)} autoFocus>Cancelar</button>
          <button className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => answer(true)}>{c.confirm ?? 'Aceptar'}</button>
        </div>
      </section>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="m-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`m-toast ${t.kind}`}>
          {t.kind === 'error' ? <AlertTriangle /> : t.kind === 'ok' ? <CheckCircle2 /> : <Info />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function TopBar({ title, left, right, sub }: { title: ReactNode; left?: ReactNode; right?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="m-topbar">
      <div className="m-topbar-side">{left}</div>
      <div className="m-topbar-title"><h1>{title}</h1>{sub && <span>{sub}</span>}</div>
      <div className="m-topbar-side right">{right}</div>
    </header>
  );
}

export function Progress({ value, label, paused, hideLabel }: { value: number | null; label?: string; paused?: boolean; hideLabel?: boolean }) {
  const pct = Math.round((value ?? 0) * 100);
  return (
    <div className="m-progress-wrap">
      {label && !hideLabel && <span className="m-progress-label">{label}</span>}
      <div className={`progress ${value === null ? 'indeterminate' : ''} ${paused ? 'paused' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : pct} aria-label={label}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="m-empty">
      {icon}
      <p><strong>{title}</strong></p>
      {children && <p className="muted small">{children}</p>}
      {action}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange(v: T): void; label: string }) {
  return (
    <div className="segmented m-seg" role="group" aria-label={label}>
      {options.map((o) => <button key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>{o.label}</button>)}
    </div>
  );
}

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

/** Pausar/reanudar (si la tarea lo admite) y cancelar. */
export function JobControls({ job }: { job: Job }) {
  const call = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { reportError(e); } };
  if (!['queued', 'running', 'paused'].includes(job.status)) return null;
  return (
    <div className="m-job-controls">
      {job.pausable && job.status === 'running' && <button className="btn btn-sm" onClick={() => call(() => engine().pauseJob(job.id))}><Pause />Pausar</button>}
      {job.pausable && job.status === 'paused' && <button className="btn btn-sm btn-primary" onClick={() => call(() => engine().resumeJob(job.id))}><Play />Reanudar</button>}
      <button className="btn btn-sm btn-ghost" onClick={() => call(() => engine().cancelJob(job.id))}><X />Cancelar</button>
    </div>
  );
}

/** Progreso de una tarea; en el procesamiento completo muestra la secuencia real de etapas. */
export function JobProgress({ job, stages, compact }: { job: Job; stages?: string[]; compact?: boolean }) {
  const elapsed = useElapsed(job);
  const pct = Math.round(job.progress * 100);
  const paused = job.status === 'paused';
  const eta = job.status === 'running' ? job.eta_s : null;
  const pipeline = job.kind === 'process' ? PIPELINE.filter((p) => !stages || stages.includes(p.id)) : [];
  const currentIdx = pipeline.findIndex((p) => p.id === job.stage);
  return (
    <div className={`m-job-progress ${compact ? 'compact' : ''}`}>
      {pipeline.length > 0 && (
        <ol className="m-pipeline" aria-label="Etapas del procesamiento">
          {pipeline.map((p, i) => {
            const state = job.stage === 'done' || i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'todo';
            const Icon = state === 'done' ? Check : p.icon;
            return <li key={p.id} className={state}><span className="m-pipeline-dot"><Icon aria-hidden /></span><span>{STAGE_LABELS[p.id]}</span></li>;
          })}
        </ol>
      )}
      <div className="m-job-text">
        <strong>{paused ? (job.message || 'En pausa') : job.message || job.title}</strong>
        <span className="small muted mono">
          {job.status === 'queued' ? 'En cola' : `${pct} %`}
          {elapsed > 0 && ` · ${formatDuration(elapsed)}`}
          {eta !== null && eta !== undefined && ` · quedan ~${formatDuration(eta)}`}
        </span>
      </div>
      <Progress value={job.status === 'queued' ? null : job.progress} label={job.title} hideLabel paused={paused} />
      {!compact && <JobControls job={job} />}
    </div>
  );
}

export function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange(v: boolean): void; label: string; hint?: string }) {
  return (
    <label className="m-toggle-row" htmlFor={id}>
      <span><strong>{label}</strong>{hint && <span className="small muted">{hint}</span>}</span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
