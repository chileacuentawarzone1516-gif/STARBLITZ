import { CheckCircle2, Eye, Power, PowerOff, Trash2, Zap } from 'lucide-react';
import { formatBytes, LANGUAGES, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { confirmAction } from '../../components/Dialog';
import { EmptyState } from '../../components/Chrome';
import { client, reportError } from '../../store';
import { FitBadge, LicenseBadge } from './badges';

/** Modelos instalados: cuál se usa, cuánto ocupan, si caben, y una prueba rápida en JA/EN. */
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
    await act(id, () => client().removeLLM(id));
  };


  // Descargas sin terminar: ocupan disco y antes no aparecían en ningún sitio (se reanudan instalando el mismo archivo).
  const partial = llm.incomplete ?? [];
  const partialBlock = partial.length > 0 && (
    <div className="settings-section" role="note">
      <strong>Descargas sin terminar</strong>
      <p className="small muted">Ocupan espacio. Se reanudan al volver a instalar el mismo archivo; si no las necesitas, bórralas.</p>
      {partial.map((p) => (
        <div className="row" key={p.id} style={{ gap: 8, justifyContent: 'space-between' }}>
          <span className="small">{p.id} · {formatBytes(p.bytes)}</span>
          <button className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => remove(p.id, 'la descarga sin terminar', p.bytes)}><Trash2 />Borrar</button>
        </div>
      ))}
    </div>
  );
  if (!models.length) {
    return (
      <div className="stack">
        <EmptyState icon={<Zap />} title="Aún no hay un modelo de traducción"
          action={<button className="btn btn-primary" onClick={() => goTo('recommended')}>Ver los recomendados para este equipo</button>}>
          STARBLITZ traduce con un modelo que se ejecuta en este dispositivo. Descárgalo una vez y funcionará sin Internet.
        </EmptyState>
        {partialBlock}
      </div>
    );
  }
  return (
    <div className="stack">
      <section className="settings-section">
        <div className="section-head">
          <h2>Modelos instalados</h2>
          <span className="small muted">{models.length} · {formatBytes(llm.disk_bytes)} en disco</span>
        </div>
        <div className="model-list">
          {models.map((m) => (
            <div className={`model-row ${m.active ? 'active' : ''}`} key={m.id}>
              <div className="model-info">
                <strong>{m.label}
                  {m.active && <span className="chip chip-ok"><CheckCircle2 aria-hidden />En uso</span>}
                  {llm.runtime.running && llm.runtime.model === m.id && <span className="chip chip-blue"><Power aria-hidden />En memoria</span>}
                  {m.vision && <span className="chip"><Eye aria-hidden />Ve la página</span>}
                </strong>
                <span className="small muted">{m.repo} · {m.quant || 'GGUF'} · {m.params_b ? `${m.params_b} B parámetros` : 'tamaño desconocido'}</span>
                <span className="small row" style={{ gap: 6 }}>
                  <FitBadge fit={m.fit} /><LicenseBadge info={m.license_info} />
                  <span className="faint">{formatBytes(m.size)}</span>
                </span>
              </div>
              <div className="model-actions">
                {!m.active && <button className="btn btn-sm" disabled={busy === m.id} onClick={() => act(m.id, () => client().activateLLM(m.id))}>Usar este</button>}
                <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Eliminar ${m.label}`} disabled={busy === m.id} onClick={() => remove(m.id, m.label, m.size)}><Trash2 /></button>
              </div>
            </div>
          ))}
        </div>
        {partialBlock}
        {llm.runtime.running && (
          <div className="row">
            <span className="small muted">El modelo está cargado y ocupa memoria; se descarga solo tras {llm.runtime.idle_s ? 'un rato' : 'unos minutos'} sin uso.</span>
            <button className="btn btn-sm" onClick={() => act('runtime', () => client().unloadLLM())}><PowerOff />Liberar memoria ahora</button>
          </div>
        )}
      </section>
      <TestPanel ready={llm.ready} />
    </div>
  );
}

const SAMPLES: Record<string, string> = {
  ja: '別に、あんたのために作ったわけじゃないんだからね！',
  en: "Don't get the wrong idea. I didn't make this for you or anything!",
};

function TestPanel({ ready }: { ready: boolean }) {
  const [lang, setLang] = useState<'ja' | 'en'>('ja');
  const [text, setText] = useState(SAMPLES.ja);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ model: string; translation: string; note: string; flags: string[] } | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try { setResult(await client().testLLM(text, lang)); } catch (e) { reportError(e, 'La prueba falló'); }
    setBusy(false);
  };
  return (
    <section className="settings-section">
      <h2>Probar la traducción</h2>
      <p className="muted">Traduce una frase con el modelo en uso. La primera vez tarda unos segundos mientras se carga en memoria.</p>
      <div className="row">
        <div className="segmented" role="group" aria-label="Idioma de la frase">
          {(['ja', 'en'] as const).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} aria-pressed={lang === l} onClick={() => { setLang(l); setText(SAMPLES[l]); setResult(null); }}>{LANGUAGES[l]}</button>
          ))}
        </div>
      </div>
      <div className="row">
        <input className="input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Frase de prueba en ${LANGUAGES[lang]}`} lang={lang} />
        <button className="btn btn-primary" disabled={busy || !ready || !text.trim()} onClick={run}>{busy ? <span className="spinner" /> : <Zap />}Traducir</button>
      </div>
      {result && (
        <div className="test-result" aria-live="polite">
          <p className="test-translation">{result.translation || '—'}</p>
          <span className="small muted">{result.model}{result.note ? ` · Nota: ${result.note}` : ''}</span>
        </div>
      )}
    </section>
  );
}
