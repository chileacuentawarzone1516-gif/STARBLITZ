import { Scale } from 'lucide-react';
import { LANGUAGES, type CompareResult, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { EmptyState } from '../../components/Chrome';
import { client, isLive, reportError, useApp } from '../../store';
import { DownloadStatus } from './install';

/** Compara varios modelos instalados con las mismas frases (japonés e inglés): calidad, tiempo y velocidad. */
export function Compare({ llm, goTo }: { llm: LLMOverview; goTo: (tab: string) => void }) {
  const models = llm.installed_models;
  const [picked, setPicked] = useState<string[]>([]);
  const jobs = useApp((s) => s.jobs);
  const running = Object.values(jobs).some((j) => j.kind === 'llm_compare' && isLive(j));
  const last = Object.values(jobs).filter((j) => j.kind === 'llm_compare' && j.status === 'done' && j.result).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))[0];
  const result = last?.result as CompareResult | undefined;

  if (models.length < 1) {
    return <EmptyState icon={<Scale />} title="Instala un modelo para compararlo"
      action={<button className="btn btn-primary" onClick={() => goTo('recommended')}>Ver recomendados</button>}>Con dos o más modelos podrás ver cuál traduce mejor y más rápido en este equipo.</EmptyState>;
  }
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-4)));
  const start = async () => {
    try { useApp.getState().upsertJob(await client().compareLLMs(picked)); } catch (e) { reportError(e, 'No se pudo iniciar la comparación'); }
  };

  return (
    <div className="stack">
      <section className="settings-section">
        <h2>Comparar modelos</h2>
        <p className="muted">Se traducen las mismas frases con cada modelo, una por una (se cargan y descargan de memoria en orden). Elige hasta 4.</p>
        <div className="model-list">
          {models.map((m) => (
            <label className="model-row pick" key={m.id}>
              <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
              <div className="model-info"><strong>{m.label}{m.active && <span className="chip chip-ok">En uso</span>}</strong><span className="small faint">{m.quant} · {m.params_b} B</span></div>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="btn btn-primary" disabled={!picked.length || running} onClick={start}><Scale />Comparar {picked.length ? `(${picked.length})` : ''}</button>
          {picked.length === 1 && <span className="small muted">Con un solo modelo verás su tiempo y velocidad.</span>}
        </div>
        <DownloadStatus kinds={['llm_compare']} />
      </section>
      {result && <Results result={result} labels={Object.fromEntries(models.map((m) => [m.id, m.label]))} />}
    </div>
  );
}

function Results({ result, labels }: { result: CompareResult; labels: Record<string, string> }) {
  return (
    <section className="settings-section" aria-live="polite">
      <h3>Resultado</h3>
      {Object.entries(result.samples).map(([lang, lines]) => (
        <div className="compare-block" key={lang}>
          <h4>{LANGUAGES[lang] ?? lang}</h4>
          <div className="compare-table" style={{ gridTemplateColumns: `minmax(160px, 1.1fr) repeat(${result.models.length}, minmax(0, 1fr))` }}>
            <span className="th">Original</span>
            {result.models.map((m) => {
              const l = m.languages[lang];
              return (
                <span className="th" key={m.id}>{labels[m.id] ?? m.id}
                  <small className="muted mono">{m.error ? 'Con error' : l ? `${l.seconds} s · ${l.tokens_per_s.toFixed(1)} tok/s` : '—'}</small>
                </span>
              );
            })}
            {lines.map((src, i) => (
              <div className="compare-row" key={i}>
                <span lang={lang} className="compare-src">{src}</span>
                {result.models.map((m) => (
                  <span key={m.id} className={m.error ? 'text-danger' : ''}>{m.error ? m.error : m.languages[lang]?.items[i]?.translation || '—'}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
