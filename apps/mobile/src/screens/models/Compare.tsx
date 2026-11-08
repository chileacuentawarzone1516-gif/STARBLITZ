import { Scale } from 'lucide-react';
import { LANGUAGES, type CompareResult, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { EmptyState } from '../../components/ui';
import { engine, isLive, reportError, useApp } from '../../state/app';
import { DownloadStatus } from './shared';

/** Compara modelos instalados con las mismas frases (japonés e inglés): calidad, tiempo y velocidad en ESTE teléfono. */
export function Compare({ llm, goTo }: { llm: LLMOverview; goTo: (tab: string) => void }) {
  const models = llm.installed_models;
  const [picked, setPicked] = useState<string[]>([]);
  const jobs = useApp((s) => s.jobs);
  const running = Object.values(jobs).some((j) => j.kind === 'llm_compare' && isLive(j));
  const last = Object.values(jobs).filter((j) => j.kind === 'llm_compare' && j.status === 'done' && j.result).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))[0];
  const result = last?.result as CompareResult | undefined;
  if (models.length < 1) {
    return <EmptyState icon={<Scale />} title="Instala un modelo para compararlo" action={<button className="btn btn-primary" onClick={() => goTo('recommended')}>Ver recomendados</button>}>
      Con dos o más modelos verás cuál traduce mejor y más rápido en este teléfono.</EmptyState>;
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-4)));
  const start = async () => {
    try { useApp.getState().upsertJob(await engine().compareLLMs(picked)); } catch (e) { reportError(e, 'No se pudo iniciar la comparación'); }
  };
  const labels = Object.fromEntries(models.map((m) => [m.id, m.label]));
  return (
    <div className="m-stack">
      <p className="muted small">Se traducen las mismas frases con cada modelo, una por una (se cargan y descargan de memoria en orden). Elige hasta 4. Puede tardar varios minutos y calienta el teléfono.</p>
      <div className="m-model-list">
        {models.map((m) => (
          <label className="m-model pick" key={m.id}>
            <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
            <span><strong>{m.label}</strong>{m.active && <span className="chip chip-ok">En uso</span>}<br /><span className="small faint">{m.quant} · {m.params_b} B</span></span>
          </label>
        ))}
      </div>
      <button className="btn btn-primary" disabled={!picked.length || running} onClick={start}><Scale />Comparar {picked.length ? `(${picked.length})` : ''}</button>
      <DownloadStatus kinds={['llm_compare']} />
      {result && (
        <section aria-live="polite" className="m-stack">
          {Object.entries(result.samples).map(([lang, lines]) => (
            <div className="m-card" key={lang}>
              <h2>{LANGUAGES[lang] ?? lang}</h2>
              {lines.map((src, i) => (
                <div className="m-compare-item" key={i}>
                  <p lang={lang} className="m-source">{src}</p>
                  {result.models.map((m) => (
                    <p key={m.id} className={m.error ? 'text-danger' : ''}><strong className="small">{labels[m.id] ?? m.id}</strong><br />{m.error ? m.error : m.languages[lang]?.items[i]?.translation || '—'}</p>
                  ))}
                </div>
              ))}
              <p className="small muted">{result.models.map((m) => `${labels[m.id] ?? m.id}: ${m.error ? 'con error' : m.languages[lang] ? `${m.languages[lang].seconds} s · ${m.languages[lang].tokens_per_s.toFixed(1)} tok/s` : '—'}`).join(' · ')}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
