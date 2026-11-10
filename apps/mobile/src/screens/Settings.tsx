import { BookA, Cpu, Eraser, HardDrive, Info, KeyRound, ShieldCheck, SlidersHorizontal, Wifi, WifiOff } from 'lucide-react';
import { formatBytes, type DeepPartial, type Settings, type Tier } from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import type { StorageInfo } from '../engine/api/localEngine';
import { defaultSettings } from '../engine/core/settings';
import { DictionaryEditor } from '../components/DictionaryEditor';
import { ProfilePicker } from '../components/ProfilePicker';
import { Segmented, Toggle, TopBar } from '../components/ui';
import { clearExportCache } from '../lib/exportFile';
import { navigate } from '../router';
import { confirmAction, engine, reportError, toast, useApp } from '../state/app';

const TIER_LABEL: Record<'auto' | Tier, string> = { auto: 'Auto', low: 'Ligero', mid: 'Medio', high: 'Alto', 'pc-gpu': 'Máximo' };

function StorageBar({ info }: { info: StorageInfo }) {
  const used = info.projects_bytes + info.vision_models_bytes + info.llm_bytes;
  const total = Math.max(1, info.total_bytes);
  const pct = (n: number) => `${Math.max(0.5, (n / total) * 100)}%`;
  return (
    <div>
      <div className="m-stor" role="img" aria-label={`STARBLITZ usa ${formatBytes(used)}; libres ${formatBytes(info.free_bytes)}`}>
        <i className="p" style={{ width: pct(info.projects_bytes) }} /><i className="v" style={{ width: pct(info.vision_models_bytes) }} /><i className="l" style={{ width: pct(info.llm_bytes) }} />
      </div>
      <ul className="m-legend">
        <li><b className="p" />Proyectos <span className="mono">{formatBytes(info.projects_bytes)}</span></li>
        <li><b className="v" />Modelos de visión <span className="mono">{formatBytes(info.vision_models_bytes)}</span></li>
        <li><b className="l" />Modelos de traducción <span className="mono">{formatBytes(info.llm_bytes)}</span></li>
      </ul>
      <p className="small muted">Libres en el teléfono: <span className="mono">{formatBytes(info.free_bytes)}</span> de {formatBytes(info.total_bytes)}.</p>
    </div>
  );
}

export function SettingsScreen() {
  const system = useApp((s) => s.system);
  const refreshSystem = useApp((s) => s.refreshSystem);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [token, setToken] = useState('');
  const tokenSet = useRef(false);

  const loadStorage = () => { engine().storageInfo().then(setStorage).catch(() => undefined); };
  useEffect(() => {
    engine().getSettings().then(setSettings).catch(reportError);
    loadStorage();
  }, []);

  const update = async (patch: DeepPartial<Settings>, refresh = false) => {
    try {
      setSettings(await engine().updateSettings(patch));
      if (refresh) await refreshSystem();
    } catch (e) { reportError(e); }
  };

  if (!settings) return <div className="m-screen m-center"><span className="spinner" /></div>;
  const { translation: tr, processing: pr, llm } = settings;

  return (
    <div className="m-screen">
      <TopBar title="Ajustes" />

      <section className="m-card">
        <h2><Cpu />Este teléfono</h2>
        {system && (
          <dl className="m-dl">
            <dt>Memoria</dt><dd>{system.device.ram_gb.toFixed(1)} GB</dd>
            <dt>Procesador</dt><dd>{system.hardware.cpu} · {system.hardware.threads} hilos</dd>
            <dt>Perfil aplicado</dt><dd>{system.profile.label}{system.profile.auto ? ' (automático)' : ''}</dd>
          </dl>
        )}
        <div className="field"><span className="label">Perfil de rendimiento</span>
          <Segmented label="Perfil" value={pr.profile} onChange={(v) => update({ processing: { profile: v } }, true)}
            options={(['auto', 'low', 'mid', 'high'] as const).map((id) => ({ id, label: TIER_LABEL[id] }))} /></div>
        <p className="small muted">Auto elige según la memoria libre del teléfono. Ligero usa modelos más pequeños y rápidos; Alto prioriza la calidad si tu móvil lo aguanta.</p>
      </section>

      <section className="m-card">
        <h2><SlidersHorizontal />Traducción</h2>
        <div className="field"><span className="label">Perfil por defecto en proyectos nuevos</span>
          <ProfilePicker value={tr.profile} onChange={(v) => update({ translation: { profile: v } })} label="Perfil por defecto" /></div>
        <div className="field"><span className="label">Calidad</span>
          <Segmented label="Calidad" value={tr.quality} onChange={(v) => update({ translation: { quality: v } })}
            options={[{ id: 'auto', label: 'Auto' }, { id: 'balanced', label: 'Equilibrada' }, { id: 'max', label: 'Máxima' }]} /></div>
        <div className="field"><span className="label">Español por defecto en proyectos nuevos</span>
          <Segmented label="Variante" value={tr.target_variant} onChange={(v) => update({ translation: { target_variant: v } })}
            options={[{ id: 'es-419', label: 'Latinoamérica' }, { id: 'es-ES', label: 'España' }]} /></div>
        <Toggle id="s-hon" checked={tr.honorifics === 'keep'} onChange={(v) => update({ translation: { honorifics: v ? 'keep' : 'adapt' } })} label="Conservar honoríficos" hint="-san, -kun, senpai…" />
        <Toggle id="s-sfx" checked={tr.sfx === 'note'} onChange={(v) => update({ translation: { sfx: v ? 'note' : 'keep' } })} label="Anotar efectos de sonido" />
        <label className="field"><span className="label">Marcar para revisar si la confianza baja de {Math.round(tr.review_threshold * 100)} %</span>
          <input type="range" min={0.3} max={0.95} step={0.05} value={tr.review_threshold} aria-label="Umbral de revisión" onChange={(e) => setSettings({ ...settings, translation: { ...tr, review_threshold: Number(e.target.value) } })} onPointerUp={() => update({ translation: { review_threshold: tr.review_threshold } })} onKeyUp={() => update({ translation: { review_threshold: tr.review_threshold } })} /></label>
      </section>

      <section className="m-card">
        <h2><BookA />Diccionario personal</h2>
        <p className="small muted">Términos que se traducen siempre igual en todos tus proyectos: nombres propios, técnicas, apodos…</p>
        <DictionaryEditor entries={tr.dictionary} onSave={(dictionary) => update({ translation: { dictionary } })} />
      </section>

      <section className="m-card">
        <h2><SlidersHorizontal />Procesamiento</h2>
        <div className="field"><span className="label">Reconstrucción del fondo</span>
          <Segmented label="Reconstrucción" value={pr.inpaint} onChange={(v) => update({ processing: { inpaint: v } }, true)}
            options={[{ id: 'auto', label: 'Auto' }, { id: 'fast', label: 'Rápida' }, { id: 'lama', label: 'LaMa' }]} /></div>
        <p className="small muted">LaMa rehace el fondo con más fidelidad pero necesita su modelo (208 MB), más memoria y más batería. «Rápida» basta para globos blancos y tramas simples.</p>
        <Toggle id="s-det" checked={pr.detector === 'manga-det'} onChange={(v) => update({ processing: { detector: v ? 'manga-det' : 'default' } }, true)}
          label="Detector ligero (experimental)" hint="PP-OCRv6 Manga (1,8 MB, en Modelos → Visión). Mucho más rápido, pero aún sin validar con manga y manhwa reales: puede dejar sin detectar texto pequeño u onomatopeyas. Si no está instalado, el análisis te avisará de que falta." />
        <Toggle id="s-vis" checked={llm.use_vision} onChange={(v) => update({ llm: { use_vision: v } })} label="Usar la imagen al traducir" hint="Solo con un modelo que entienda imágenes; aumenta memoria y tiempo." />
        <label className="field"><span className="label">Descargar el modelo tras {llm.idle_unload_minutes} min sin usarlo</span>
          <input type="range" min={1} max={30} step={1} value={llm.idle_unload_minutes} aria-label="Minutos hasta liberar el modelo" onChange={(e) => setSettings({ ...settings, llm: { ...llm, idle_unload_minutes: Number(e.target.value) } })} onPointerUp={() => update({ llm: { idle_unload_minutes: llm.idle_unload_minutes } })} onKeyUp={() => update({ llm: { idle_unload_minutes: llm.idle_unload_minutes } })} /></label>
        <label className="field"><span className="label">Máximo de páginas por proyecto</span>
          <select className="select" value={pr.max_pages} onChange={(e) => update({ processing: { max_pages: Number(e.target.value) } })}>
            {[10, 20, 30, 50].map((n) => <option key={n} value={n}>{n} páginas</option>)}
          </select></label>
      </section>

      <section className="m-card">
        <h2><KeyRound />Hugging Face</h2>
        <p className="small muted">El token es opcional: solo sirve para descargar modelos que lo exijan o evitar límites. Se guarda solo en la carpeta privada de STARBLITZ en este teléfono (otras apps no pueden leerla), no se vuelve a mostrar y únicamente se envía a huggingface.co.</p>
        <label className="field"><span className="label">Token {llm.hf_token ? '(guardado)' : ''}</span>
          <input className="input mono" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={llm.hf_token ? '••••••••' : 'hf_…'} value={token}
            onChange={(e) => { tokenSet.current = true; setToken(e.target.value); }} /></label>
        <div className="m-action-grid">
          <button className="btn btn-primary" disabled={!token.trim()} onClick={async () => { await update({ llm: { hf_token: token.trim() } }); setToken(''); tokenSet.current = false; toast('ok', 'Token guardado'); }}>Guardar</button>
          <button className="btn" disabled={!llm.hf_token} onClick={async () => { await update({ llm: { hf_token: '' } }); toast('ok', 'Token eliminado'); }}>Quitar</button>
        </div>
      </section>

      <section className="m-card">
        <h2><HardDrive />Almacenamiento</h2>
        {storage ? <StorageBar info={storage} /> : <span className="spinner" />}
        <div className="m-action-grid">
          <button className="btn" onClick={() => navigate('/models')}>Gestionar modelos</button>
          <button className="btn" onClick={async () => { await clearExportCache(); loadStorage(); toast('ok', 'Exportaciones temporales borradas'); }}><Eraser />Limpiar exportaciones</button>
        </div>
      </section>

      <section className="m-card">
        <h2><Wifi />Qué funciona sin internet</h2>
        <ul className="m-offline">
          {system?.offline.map((o) => (
            <li key={o.component} className={o.offline ? 'ok' : 'no'}>
              {o.offline ? <Wifi aria-hidden /> : <WifiOff aria-hidden />}
              <span><strong>{o.component}</strong>{o.requires && <span className="small muted">{o.requires}</span>}</span>
              <em className="sr-only">{o.offline ? 'funciona sin conexión' : 'necesita conexión'}</em>
            </li>
          ))}
        </ul>
      </section>

      <section className="m-card">
        <h2><ShieldCheck />Privacidad y seguridad</h2>
        <ul className="m-points small">
          <li>Tus páginas se procesan <strong>solo en este teléfono</strong>. Nada se sube a ningún servidor.</li>
          <li>Internet se usa únicamente para <strong>descargar modelos</strong> desde Hugging Face y herramientas; la traducción siempre es local.</li>
          <li>Cada descarga se comprueba por tamaño y, cuando el repositorio publica su huella, también por SHA-256. Los modelos de traducción se limitan a GGUF.</li>
          <li>Las importaciones validan el tipo real del archivo (no la extensión) y protegen contra ZIP malformados o «bombas» de compresión.</li>
          <li>Lo exportado va a <strong>Descargas/STARBLITZ</strong> solo cuando tú lo pides.</li>
        </ul>
        <button className="btn btn-danger" onClick={async () => {
          if (!(await confirmAction({ title: '¿Restablecer los ajustes?', message: 'Los proyectos y los modelos no se tocan.', confirm: 'Restablecer', danger: true }))) return;
          try {
            const d = defaultSettings();
            await update({ translation: { ...d.translation }, processing: { profile: d.processing.profile, inpaint: d.processing.inpaint, max_pages: d.processing.max_pages }, llm: { use_vision: d.llm.use_vision, idle_unload_minutes: d.llm.idle_unload_minutes, temperature: d.llm.temperature } }, true);
            toast('ok', 'Ajustes restablecidos');
          } catch (e) { reportError(e); }
        }}>Restablecer ajustes</button>
      </section>

      <section className="m-card">
        <h2><Info />Acerca de</h2>
        <p className="small muted">STARBLITZ Mobile {system?.version ?? ''} · Motor de traducción local · Código abierto. Modelos y herramientas de terceros con sus propias licencias (ver documentación: LICENCIAS-TERCEROS).</p>
      </section>
    </div>
  );
}
