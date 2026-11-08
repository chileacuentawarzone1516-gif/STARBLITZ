import { Cpu, Download } from 'lucide-react';
import { formatBytes, TIER_LABELS } from '@starblitz/shared';
import { EmptyState } from '../components/Chrome';
import { useLLM, useSettings } from '../hooks';
import { navigate } from '../router';
import { useApp } from '../store';
import { Advanced } from './models/Advanced';
import { Compare } from './models/Compare';
import { Explore } from './models/Explore';
import { Installed } from './models/Installed';
import { Recommended } from './models/Recommended';
import { Vision } from './models/Vision';

const TABS = [
  { id: 'installed', label: 'Mis modelos' },
  { id: 'recommended', label: 'Recomendados' },
  { id: 'explore', label: 'Explorar Hugging Face' },
  { id: 'compare', label: 'Comparar' },
  { id: 'vision', label: 'Visión y OCR' },
  { id: 'advanced', label: 'Avanzado' },
] as const;

/** Administración de los modelos que se ejecutan en este dispositivo. */
export function ModelsView({ tab = 'installed' }: { tab?: string }) {
  const { data: llm, reload } = useLLM();
  const { settings, update } = useSettings();
  const system = useApp((s) => s.system);
  const current = TABS.some((t) => t.id === tab) ? tab : 'installed';
  const goTo = (id: string) => navigate(`/models/${id}`);

  return (
    <div className="page models-page">
      <header className="models-head">
        <div>
          <h1>Modelos</h1>
          <p className="muted">Todo se ejecuta en este dispositivo. Los modelos se descargan una vez y después funcionan sin Internet.</p>
        </div>
        {llm && (
          <div className="device-card panel" aria-label="Este dispositivo">
            <Cpu aria-hidden />
            <div>
              <strong>{TIER_LABELS[llm.advice.profile.id]}{system?.profile.auto === false ? ' (elegido por ti)' : ''}</strong>
              <span className="small muted">
                {llm.advice.device.ram_gb} GB de RAM{llm.advice.device.vram_gb ? ` · ${llm.advice.device.gpu} (${llm.advice.device.vram_gb} GB)` : ' · sin GPU dedicada'}
              </span>
              <span className="small faint"><Download aria-hidden style={{ width: 12, height: 12, verticalAlign: -1 }} /> {formatBytes(llm.disk_bytes)} en modelos</span>
            </div>
          </div>
        )}
      </header>
      <div className="tabs" role="tablist" aria-label="Secciones de modelos">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? 'on' : ''} onClick={() => goTo(t.id)}>{t.label}</button>
        ))}
      </div>
      {!llm || !settings ? <div className="center"><div className="spinner" /></div> : (
        <div role="tabpanel">
          {current === 'installed' && <Installed llm={llm} reload={reload} goTo={goTo} />}
          {current === 'recommended' && <Recommended llm={llm} />}
          {current === 'explore' && <Explore llm={llm} />}
          {current === 'compare' && <Compare llm={llm} goTo={goTo} />}
          {current === 'vision' && <Vision />}
          {current === 'advanced' && <Advanced llm={llm} settings={settings} update={update} />}
          {!llm.runtime.available && llm.provider === 'builtin' && current !== 'vision' && (
            <EmptyState icon={<Cpu />} title="Falta el servidor de modelos integrado">
              No se encontró <span className="mono">llama-server</span> junto a la aplicación. Reinstala STARBLITZ o usa un servidor propio desde «Avanzado».
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
