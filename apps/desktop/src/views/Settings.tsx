import { CheckCircle2, Cpu, FolderOpen, HardDrive, Plus, Trash2, XCircle, Zap } from 'lucide-react';
import { TIER_LABELS, TRANSLATION_PROFILES, VARIANTS, type GlossaryEntry, type Settings as SettingsT, type TranslationProfile } from '@starblitz/shared';
import { useState } from 'react';
import { bridge } from '../bridge';
import { Toggle } from '../components/Toggle';
import { useSettings, type UpdateSettings } from '../hooks';
import { navigate } from '../router';
import { useApp } from '../store';

const TABS = [
  { id: 'translation', label: 'Traducción', icon: Zap },
  { id: 'processing', label: 'Procesamiento', icon: Cpu },
  { id: 'system', label: 'Sistema', icon: HardDrive },
] as const;

export function SettingsView({ tab = 'translation' }: { tab?: string }) {
  const { settings, update } = useSettings();
  const current = TABS.some((t) => t.id === tab) ? tab : 'translation';
  return (
    <div className="page settings">
      <h1>Configuración</h1>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Secciones de configuración">
          {TABS.map((t) => (
            <button key={t.id} className={current === t.id ? 'on' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => navigate(`/settings/${t.id}`)}>
              <t.icon aria-hidden />{t.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {!settings ? <div className="spinner" /> : (
            <>
              {current === 'translation' && <TranslationTab settings={settings} update={update} />}
              {current === 'processing' && <ProcessingTab settings={settings} update={update} />}
              {current === 'system' && <SystemTab />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TranslationTab({ settings, update }: { settings: SettingsT; update: UpdateSettings }) {
  const t = settings.translation;
  return (
    <div className="stack settings-section">
      <h2>Traducción</h2>
      <div className="form-grid">
        <div className="field"><label htmlFor="st-var">Español por defecto para proyectos nuevos</label>
          <select id="st-var" className="select" value={t.target_variant} onChange={(e) => update({ translation: { target_variant: e.target.value as typeof t.target_variant } })}>
            {Object.entries(VARIANTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <span className="hint">Por defecto, español latinoamericano neutro.</span></div>
        <div className="field"><label htmlFor="st-h">Honoríficos por defecto</label>
          <select id="st-h" className="select" value={t.honorifics} onChange={(e) => update({ translation: { honorifics: e.target.value as 'adapt' | 'keep' } })}>
            <option value="adapt">Adaptar al trato en español</option><option value="keep">Conservar</option></select></div>
        <div className="field span-2"><label htmlFor="st-p">Perfil de traducción por defecto</label>
          <select id="st-p" className="select" value={t.profile} onChange={(e) => update({ translation: { profile: e.target.value as TranslationProfile } })}>
            {TRANSLATION_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <span className="hint">{TRANSLATION_PROFILES.find((p) => p.id === t.profile)?.description} Cada proyecto puede cambiarlo en sus ajustes.</span></div>
        <div className="field span-2"><label htmlFor="st-r">Marcar para revisión si la confianza es menor de {Math.round(t.review_threshold * 100)} %</label>
          <input id="st-r" type="range" min={40} max={95} value={Math.round(t.review_threshold * 100)}
            onChange={(e) => update({ translation: { review_threshold: +e.target.value / 100 } })} /></div>
      </div>
      <DictionarySection entries={t.dictionary} onSave={(dictionary) => update({ translation: { dictionary } })} />
      <p className="small muted">El modelo, la calidad y la memoria de contexto se administran en <button className="link-btn" onClick={() => navigate('/models/advanced')}>Modelos → Avanzado</button>.</p>
    </div>
  );
}

function ProcessingTab({ settings, update }: { settings: SettingsT; update: UpdateSettings }) {
  const p = settings.processing;
  return (
    <div className="stack settings-section">
      <h2>Procesamiento</h2>
      <div className="form-grid">
        <div className="field"><label htmlFor="sp-dev">Dispositivo para OCR y reconstrucción</label>
          <select id="sp-dev" className="select" value={p.device} onChange={(e) => update({ processing: { device: e.target.value as typeof p.device } })}>
            <option value="auto">Automático (GPU si está disponible)</option><option value="gpu">GPU</option><option value="cpu">Solo CPU</option></select></div>
        <div className="field"><label htmlFor="sp-inp">Reconstrucción del fondo</label>
          <select id="sp-inp" className="select" value={p.inpaint} onChange={(e) => update({ processing: { inpaint: e.target.value as typeof p.inpaint } })}>
            <option value="auto">Automática: relleno exacto en globos y LaMa sobre dibujo</option>
            <option value="lama">Usar LaMa siempre que haga falta</option>
            <option value="fast">Rápida: sin LaMa (peor sobre tramas)</option></select></div>
        <div className="field"><label htmlFor="sp-max">Límite de páginas por proyecto</label>
          <input id="sp-max" className="input" type="number" min={1} max={1000} defaultValue={p.max_pages}
            onBlur={(e) => { const v = Math.max(1, Math.min(1000, +e.target.value || 50)); if (v !== p.max_pages) update({ processing: { max_pages: v } }); }} />
          <span className="hint">50 es el valor recomendado; más páginas tardan más pero no reducen la calidad.</span></div>
      </div>
      <Toggle id="sp-auto" checked={p.profile === 'auto'} onChange={(v) => update({ processing: { profile: v ? 'auto' : 'mid' } })}
        label="Elegir el perfil de rendimiento automáticamente" hint="STARBLITZ mide la memoria y la GPU de este dispositivo. Desactívalo solo si quieres forzar un perfil." />
      {p.profile !== 'auto' && (
        <div className="field"><label htmlFor="sp-prof">Perfil</label>
          <select id="sp-prof" className="select" value={p.profile} onChange={(e) => update({ processing: { profile: e.target.value as typeof p.profile } })}>
            {(Object.keys(TIER_LABELS) as (keyof typeof TIER_LABELS)[]).map((k) => <option key={k} value={k}>{TIER_LABELS[k]}</option>)}</select></div>
      )}
    </div>
  );
}

function SystemTab() {
  const system = useApp((s) => s.system);
  if (!system) return <div className="spinner" />;
  const hw = system.hardware;
  return (
    <div className="stack settings-section">
      <h2>Sistema</h2>
      <dl className="specs">
        <dt>Procesador</dt><dd>{hw.cpu} ({hw.cores} núcleos, {hw.threads} hilos)</dd>
        <dt>Memoria RAM</dt><dd>{(hw.ram_mb / 1024).toFixed(1)} GB</dd>
        <dt>Gráficas</dt><dd>{hw.gpus.length ? hw.gpus.map((g) => `${g.name} (${(g.vram_mb / 1024).toFixed(1)} GB)`).join(' · ') : 'No se detectó GPU dedicada'}</dd>
        <dt>Aceleración</dt><dd>{system.accelerator.name}</dd>
        <dt>Perfil</dt><dd>{TIER_LABELS[system.profile.id]}{system.profile.auto ? ' (automático)' : ' (elegido por ti)'}</dd>
        <dt>Versión</dt><dd>STARBLITZ {system.version}</dd>
      </dl>
      <h3>Qué funciona sin Internet</h3>
      <ul className="offline-list">
        {system.offline.map((o) => (
          <li key={o.component} className={o.offline ? 'ok' : ''}>
            {o.offline ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
            <span><strong>{o.component}</strong>{o.requires && <span className="small muted"> — {o.requires}</span>}</span>
          </li>
        ))}
      </ul>
      {bridge && (
        <div className="row">
          <button className="btn" onClick={() => bridge!.openDataDir()}><FolderOpen />Abrir carpeta de datos</button>
          <button className="btn" onClick={() => bridge!.openDataDir('logs')}><FolderOpen />Abrir registros</button>
        </div>
      )}
      <p className="small faint">Datos en: <span className="mono">{system.data_dir}</span></p>
    </div>
  );
}

/** Diccionario personal: términos que se aplican en todos los proyectos (el glosario del proyecto manda si coinciden). */
function DictionarySection({ entries, onSave }: { entries: GlossaryEntry[]; onSave: (entries: GlossaryEntry[]) => Promise<unknown> | void }) {
  const [rows, setRows] = useState<GlossaryEntry[]>(entries);
  const [dirty, setDirty] = useState(false);
  const edit = (i: number, patch: Partial<GlossaryEntry>) => { setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  return (
    <section className="stack">
      <div className="section-head">
        <h3>Diccionario personal</h3>
        <button className="btn btn-sm" disabled={rows.length >= 500} onClick={() => { setRows([...rows, { source: '', target: '', note: '', locked: true }]); setDirty(true); }}><Plus />Añadir</button>
      </div>
      <p className="small muted">Términos que se traducen siempre igual en todos tus proyectos: nombres propios, técnicas, apodos… Si el glosario de un proyecto tiene el mismo término, manda el del proyecto.</p>
      <div className="table table-3" role="table" aria-label="Diccionario personal">
        <div className="tr th" role="row"><span>Término original</span><span>Traducción</span><span>Nota</span><span /></div>
        {rows.length === 0 && <p className="muted small" style={{ padding: 12 }}>Tu diccionario está vacío.</p>}
        {rows.map((r, i) => (
          <div className="tr" role="row" key={i}>
            <input className="input" aria-label="Término original" maxLength={200} value={r.source} onChange={(e) => edit(i, { source: e.target.value })} />
            <input className="input" aria-label="Traducción" maxLength={200} value={r.target} onChange={(e) => edit(i, { target: e.target.value })} />
            <input className="input" aria-label="Nota" maxLength={300} value={r.note} onChange={(e) => edit(i, { note: e.target.value })} />
            <span className="row-actions"><button className="btn btn-ghost btn-icon btn-sm" aria-label="Eliminar" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 /></button></span>
          </div>
        ))}
      </div>
      <div><button className="btn btn-primary" disabled={!dirty} onClick={async () => { await onSave(rows.filter((r) => r.source.trim() && r.target.trim())); setDirty(false); }}>Guardar diccionario</button></div>
    </section>
  );
}
