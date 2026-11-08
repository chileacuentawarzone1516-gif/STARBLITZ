import { FIT_LABELS, LICENSE_CLASS_LABELS, type Fit, type LicenseInfo } from '@starblitz/shared';
import { CheckCircle2, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';

const FIT_CHIP: Record<Fit['fits'], string> = { gpu: 'chip-ok', hybrid: 'chip-blue', cpu: 'chip-warn', no: 'chip-danger' };
const SPEED: Record<Fit['speed'], string> = { fast: 'rápido', medium: 'velocidad media', slow: 'lento', none: '' };

/** Compatibilidad del modelo con ESTE dispositivo: dónde se ejecutaría y qué tan rápido. */
export function FitBadge({ fit }: { fit: Fit }) {
  return (
    <span className={`chip ${FIT_CHIP[fit.fits]}`} title={fit.note}>
      <Zap aria-hidden />{FIT_LABELS[fit.fits]}{SPEED[fit.speed] && ` · ${SPEED[fit.speed]}`}
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
