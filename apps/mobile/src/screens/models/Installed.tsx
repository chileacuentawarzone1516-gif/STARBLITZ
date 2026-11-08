import { CheckCircle2, Eye, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { formatBytes, LANGUAGES, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { EmptyState } from '../../components/ui';
import { confirmAction, engine, reportError } from '../../state/app';
import { FitBadge, LicenseBadge } from './shared';

const SAMPLES: Record<string, string> = {
  ja: '別に、あんたのために作ったわけじゃないんだからね！',
  en: "Don't get the wrong idea. I didn't make this for you or anything!",
};

export function Installed({ llm, reload, goTo }: { llm: LLMOverview; reload: () => void; goTo: (tab: string) => void }) {
  const models = llm.installed_models;
  const [busy, setBusy] = useState('');
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try { await fn(); reload(); } catch (e) { reportError(e); }
    setBusy('');
  };
  const remove = async (id: string, label: string, size: number) => {
    if (!(await confirmAction({ title: `¿Eliminar ${label}?`, message: `Se liberarán ${formatBytes(size)}. Podrás volver a descargarlo cuando quieras.`, confirm: 'Eliminar', danger: true }))) return;
    await act(id, () => engine().removeLLM(id));
  };
  if (!models.length) {
    return (
      <EmptyState icon={<Zap />} title="Aún no hay un modelo de traducción"
        action={<button className="btn btn-primary" onClick={() => goTo('recommended')}>Ver los recomendados</button>}>
        STARBLITZ traduce con un modelo que se ejecuta en este teléfono. Se descarga una vez y funciona sin Internet.
      </EmptyState>
    );
  }
  return (
    <div className="m-stack">
      <p className="small muted">{models.length} {models.length === 1 ? 'modelo' : 'modelos'} · {formatBytes(llm.disk_bytes)} en el teléfono</p>
      <div className="m-model-list">
        {models.map((m) => (
          <article className={`m-model ${m.active ? 'active' : ''}`} key={m.id}>
            <header>
              <strong>{m.label}</strong>
              <span className="m-chip-row">
                {m.active && <span className="chip chip-ok"><CheckCircle2 aria-hidden />En uso</span>}
                {llm.runtime.running && llm.runtime.model === m.id && <span className="chip chip-blue"><Power aria-hidden />En memoria</span>}
                {m.vision && <span className="chip"><Eye aria-hidden />Ve la página</span>}
              </span>
            </header>
            <p className="small muted m-break">{m.repo} · {m.quant || 'GGUF'}{m.params_b ? ` · ${m.params_b} B` : ''}</p>
            <div className="m-chip-row"><FitBadge fit={m.fit} /><LicenseBadge info={m.license_info} /></div>
            <p className="small faint">{formatBytes(m.size)}</p>
            <footer>
              {!m.active && <button className="btn btn-sm" disabled={busy === m.id} onClick={() => act(m.id, () => engine().activateLLM(m.id))}>Usar este</button>}
              <button className="btn btn-ghost btn-sm" aria-label={`Eliminar ${m.label}`} disabled={busy === m.id} onClick={() => remove(m.id, m.label, m.size)}><Trash2 />Eliminar</button>
            </footer>
          </article>
        ))}
      </div>
      {llm.runtime.running && (
        <div className="m-callout">
          <PowerOff aria-hidden />
          <div>
            <p className="small muted">El modelo está cargado y ocupa memoria; se descarga solo tras un rato sin uso.</p>
            <button className="btn btn-sm" onClick={() => act('runtime', () => engine().unloadLLM())}>Liberar memoria ahora</button>
          </div>
        </div>
      )}
      <TestPanel ready={llm.ready} />
    </div>
  );
}

function TestPanel({ ready }: { ready: boolean }) {
  const [lang, setLang] = useState<'ja' | 'en'>('ja');
  const [text, setText] = useState(SAMPLES.ja);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ model: string; translation: string; note: string; flags: string[] } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try { setResult(await engine().testLLM(text, lang)); } catch (e) { reportError(e, 'La prueba falló'); }
    setBusy(false);
  };
  return (
    <section className="m-card">
      <h2>Probar la traducción</h2>
      <p className="small muted">Traduce una frase con el modelo en uso. La primera vez tarda mientras se carga en memoria.</p>
      <div className="segmented" role="group" aria-label="Idioma de la frase">
        {(['ja', 'en'] as const).map((l) => <button key={l} aria-pressed={lang === l} onClick={() => { setLang(l); setText(SAMPLES[l]); setResult(null); }}>{LANGUAGES[l]}</button>)}
      </div>
      <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Frase de prueba en ${LANGUAGES[lang]}`} lang={lang} />
      <button className="btn btn-primary" disabled={busy || !ready || !text.trim()} onClick={run}>{busy ? <span className="spinner" /> : <Zap />}Traducir</button>
      {result && (
        <div className="m-test-result" aria-live="polite">
          <p className="m-tgt-sample">{result.translation || '—'}</p>
          <span className="small muted">{result.model}{result.note ? ` · Nota: ${result.note}` : ''}</span>
        </div>
      )}
    </section>
  );
}
