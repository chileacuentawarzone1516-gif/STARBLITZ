import { KeyRound } from 'lucide-react';
import type { LLMOverview, Settings } from '@starblitz/shared';
import { useState } from 'react';
import { Toggle } from '../../components/Toggle';
import type { UpdateSettings } from '../../hooks';

export function Advanced({ llm, settings, update }: { llm: LLMOverview; settings: Settings; update: UpdateSettings }) {
  const s = settings;
  const [token, setToken] = useState('');
  const profiles = llm.advice.profiles;
  const chosen = profiles.find((p) => p.id === s.processing.profile);
  return (
    <div className="stack">
      <section className="settings-section">
        <h2>Rendimiento</h2>
        <div className="form-grid">
          <div className="field span-2">
            <label htmlFor="adv-profile">Perfil de rendimiento</label>
            <select id="adv-profile" className="select" value={s.processing.profile} onChange={(e) => update({ processing: { profile: e.target.value as Settings['processing']['profile'] } })}>
              <option value="auto">Automático: {llm.advice.profile.label} (según este dispositivo)</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="hint">{(chosen ?? llm.advice.profile).description}</span>
          </div>
          <div className="field">
            <label htmlFor="adv-quality">Calidad de traducción</label>
            <select id="adv-quality" className="select" value={s.translation.quality} onChange={(e) => update({ translation: { quality: e.target.value as Settings['translation']['quality'] } })}>
              <option value="auto">Automática según el perfil</option>
              <option value="max">Máxima: traducción + revisión editorial (≈2× tiempo)</option>
              <option value="balanced">Equilibrada: una sola pasada</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="adv-idle">Liberar memoria tras</label>
            <select id="adv-idle" className="select" value={s.llm.idle_unload_minutes} onChange={(e) => update({ llm: { idle_unload_minutes: +e.target.value } })}>
              {[[0, 'Nunca (mantener cargado)'], [2, '2 minutos sin usar'], [5, '5 minutos sin usar'], [10, '10 minutos sin usar'], [30, '30 minutos sin usar']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="adv-ctx">Memoria de contexto máxima (tokens)</label>
            <select id="adv-ctx" className="select" value={s.llm.context_window} onChange={(e) => update({ llm: { context_window: +e.target.value } })}>
              {[4096, 8192, 12288, 16384, 24576, 32768].map((n) => <option key={n} value={n}>{n.toLocaleString('es')}</option>)}
            </select>
            <span className="hint">El perfil limita este valor para que el modelo quepa en el dispositivo.</span>
          </div>
          <div className="field">
            <label htmlFor="adv-temp">Creatividad: {s.llm.temperature.toFixed(2)}</label>
            <input id="adv-temp" type="range" min={0} max={80} value={Math.round(s.llm.temperature * 100)} onChange={(e) => update({ llm: { temperature: +e.target.value / 100 } })} />
            <span className="hint">Valores bajos son más fieles; 0,30 es un buen equilibrio.</span>
          </div>
        </div>
        <Toggle id="adv-vision" checked={s.llm.use_vision} onChange={(v) => update({ llm: { use_vision: v } })}
          label="Mostrar la página al modelo (si lo admite)" hint="Identifica mejor quién habla y con qué emoción. Solo se usa si el perfil y el modelo lo permiten." />
      </section>

      <section className="settings-section">
        <h2>Hugging Face</h2>
        <p className="muted">Solo se usa para buscar y descargar modelos. Un token es opcional: únicamente hace falta para repositorios restringidos.</p>
        <div className="row">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="adv-hf">Token de acceso {llm.hf_token_set && <span className="chip chip-ok">Guardado</span>}</label>
            <input id="adv-hf" className="input" type="password" autoComplete="off" spellCheck={false} placeholder={llm.hf_token_set ? '•••• (escribe uno nuevo para reemplazarlo)' : 'hf_…'}
              value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <button className="btn" disabled={!token.trim()} onClick={() => { update({ llm: { hf_token: token.trim() } }); setToken(''); }}><KeyRound />Guardar</button>
          {llm.hf_token_set && <button className="btn btn-ghost" onClick={() => update({ llm: { hf_token: '' } })}>Quitar</button>}
        </div>
      </section>

      <section className="settings-section">
        <h2>Motor de traducción</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="adv-prov">Origen del modelo</label>
            <select id="adv-prov" className="select" value={s.llm.provider} onChange={(e) => update({ llm: { provider: e.target.value as Settings['llm']['provider'] } })}>
              <option value="builtin">Integrado en STARBLITZ (recomendado, sin instalar nada más)</option>
              <option value="ollama">Servidor Ollama que ya tengo instalado</option>
              <option value="openai">Servidor compatible con OpenAI en mi equipo (LM Studio, llama.cpp…)</option>
            </select>
          </div>
          {s.llm.provider !== 'builtin' && (
            <>
              <div className="field"><label htmlFor="adv-url">Dirección del servidor</label>
                <input id="adv-url" className="input" defaultValue={s.llm.base_url} onBlur={(e) => e.target.value !== s.llm.base_url && update({ llm: { base_url: e.target.value } })} /></div>
              <div className="field"><label htmlFor="adv-model">Nombre del modelo</label>
                <input id="adv-model" className="input" list="adv-models" defaultValue={s.llm.model} onBlur={(e) => e.target.value !== s.llm.model && update({ llm: { model: e.target.value.trim() } })} />
                <datalist id="adv-models">{(llm.external?.models ?? []).map((m) => <option key={m} value={m} />)}</datalist>
                <span className="hint">{llm.external ? (llm.external.ok ? 'Servidor conectado.' : 'No se pudo conectar con el servidor.') : ''}</span></div>
            </>
          )}
        </div>
        <p className="small faint">STARBLITZ no necesita ningún servidor externo. Esta opción existe solo para quien ya usa uno propio, y nunca sale del equipo.</p>
      </section>

      <section className="settings-section">
        <h2>Registro del servidor de modelos</h2>
        <pre className="log-tail" tabIndex={0} aria-label="Últimas líneas del registro">{llm.runtime.log_tail.length ? llm.runtime.log_tail.join('\n') : 'Sin actividad todavía.'}</pre>
        {llm.runtime.error && <p className="small text-danger">{llm.runtime.error}</p>}
      </section>
    </div>
  );
}
