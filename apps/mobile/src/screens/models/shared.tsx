import { CheckCircle2, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';
import { FIT_LABELS, formatBytes, LICENSE_CLASS_LABELS, type Fit, type LicenseInfo, type LLMOverview } from '@starblitz/shared';
import { useCallback, useEffect, useState } from 'react';
import { JobProgress } from '../../components/ui';
import { confirmAction, engine, isLive, reportError, useApp } from '../../state/app';

const FIT_CHIP: Record<Fit['fits'], string> = { gpu: 'chip-ok', hybrid: 'chip-blue', cpu: 'chip-warn', no: 'chip-danger' };
const SPEED: Record<Fit['speed'], string> = { fast: 'rápido', medium: 'velocidad media', slow: 'lento', none: '' };
/** En el teléfono no hay GPU que cuente: «cpu» significa que cabe en la memoria del dispositivo. */
const FIT_PHONE: Record<Fit['fits'], string> = { gpu: 'Cabe', hybrid: 'Cabe', cpu: 'Cabe', no: FIT_LABELS.no };

export function FitBadge({ fit }: { fit: Fit }) {
  return (
    <span className={`chip ${FIT_CHIP[fit.fits]}`} title={fit.note}>
      <Zap aria-hidden />{FIT_PHONE[fit.fits]}{SPEED[fit.speed] && ` · ${SPEED[fit.speed]}`}{fit.tight && fit.fits !== 'no' ? ' · justo' : ''}
    </span>
  );
}

export function LicenseBadge({ info, name }: { info: LicenseInfo; name?: string }) {
  const ok = info.class === 'permissive';
  const chip = ok ? 'chip-ok' : info.class === 'restricted' ? 'chip-danger' : 'chip-warn';
  const Icon = ok ? ShieldCheck : ShieldAlert;
  return <span className={`chip ${chip}`} title={info.note}><Icon aria-hidden />{name || info.id || LICENSE_CLASS_LABELS[info.class]}</span>;
}

export const InstalledBadge = () => <span className="chip chip-ok"><CheckCircle2 aria-hidden />Instalado</span>;

/** Descarga e instalación de un GGUF. Antes de empezar avisa del tamaño: los modelos son archivos de varios cientos de MB o GB. */
export async function startInstall(repo: string, file: string, opts: { mmproj?: string | null; size: number }): Promise<void> {
  const big = opts.size >= 300 * 1024 * 1024;
  if (big && !(await confirmAction({
    title: `Descargar ${formatBytes(opts.size)}`,
    message: 'Es una descarga grande: usa Wi-Fi y mantén el teléfono cargando. Puedes pausarla o cancelarla, y si se corta continuará donde se quedó.',
    confirm: 'Descargar',
  }))) return;
  try {
    useApp.getState().upsertJob(await engine().installLLM(repo, file, { mmproj: opts.mmproj ?? null }));
  } catch (e) { reportError(e, 'No se pudo iniciar la descarga'); }
}

/** Descargas en curso (con pausa/reanudación y cancelación) de los tipos indicados. */
export function DownloadStatus({ kinds }: { kinds: string[] }) {
  const jobs = useApp((s) => s.jobs);
  const live = Object.values(jobs).filter((j) => kinds.includes(j.kind) && isLive(j));
  if (!live.length) return null;
  return <div className="panel m-job-panel" aria-live="polite">{live.map((j) => <JobProgress key={j.id} job={j} />)}</div>;
}

/** Estado de los modelos de traducción; se recarga solo cuando termina una descarga o una comparación. */
export function useLLM() {
  const [data, setData] = useState<LLMOverview | null>(null);
  const jobs = useApp((s) => s.jobs);
  const finished = Object.values(jobs).filter((j) => (j.kind === 'llm_install' || j.kind === 'llm_compare') && ['done', 'cancelled', 'error'].includes(j.status)).length;
  const reload = useCallback(() => engine().llm().then(setData).catch(reportError), []);
  useEffect(() => { void reload(); }, [reload, finished]);
  return { data, reload };
}
