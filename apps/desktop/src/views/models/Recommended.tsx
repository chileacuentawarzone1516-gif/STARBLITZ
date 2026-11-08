import { Download, Eye } from 'lucide-react';
import { formatBytes, TIER_LABELS, type CatalogModel, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { DownloadStatus, startInstall } from './install';
import { FitBadge, InstalledBadge, LicenseBadge } from './badges';

/** Catálogo curado: solo modelos de pesos abiertos con licencia permisiva, ordenados según este dispositivo. */
export function Recommended({ llm }: { llm: LLMOverview }) {
  const { advice } = llm;
  const [withVision, setWithVision] = useState(advice.profile.vision_llm);
  const options = [...advice.options].sort((a, b) => Number(b.recommended) - Number(a.recommended) || fitRank(a) - fitRank(b) || a.size - b.size);
  const installing = llm.installing.length > 0;

  return (
    <div className="stack">
      <section className="settings-section">
        <div className="callout callout-info">
          <Eye aria-hidden />
          <div>
            <strong>{advice.supported ? `Para este equipo (${TIER_LABELS[advice.profile.id]}) recomendamos ${labelOf(options, advice.recommended)}` : 'Este equipo es muy justo para traducir en local'}</strong>
            <p className="small muted">{advice.reason}</p>
          </div>
        </div>
        <label className="toggle-inline">
          <input type="checkbox" checked={withVision} onChange={(e) => setWithVision(e.target.checked)} />
          <span>
            Descargar también la parte visual (el modelo «ve» la página para saber quién habla y con qué emoción).
            <span className="hint"> Añade entre 0,3 y 1 GB y gasta más memoria; en equipos modestos es mejor dejarlo desactivado.</span>
          </span>
        </label>
        <DownloadStatus kinds={['llm_install']} />
        <div className="model-list">
          {options.map((o) => <Row key={o.id} o={o} withVision={withVision} locked={installing} />)}
        </div>
        <p className="small faint">¿Buscas otro modelo? En «Explorar Hugging Face» puedes instalar cualquier archivo GGUF compatible; STARBLITZ te dirá antes si cabe en este dispositivo.</p>
      </section>
    </div>
  );
}

const fitRank = (o: CatalogModel) => ({ gpu: 0, hybrid: 1, cpu: 2, no: 3 })[o.fit.fits];
const labelOf = (list: CatalogModel[], id: string) => list.find((o) => o.id === id)?.label ?? id;

function Row({ o, withVision, locked }: { o: CatalogModel; withVision: boolean; locked: boolean }) {
  const mm = withVision && o.mmproj ? o.mmproj : null;
  const total = o.size + (mm ? o.mmproj_size : 0);
  return (
    <div className={`model-row ${o.active ? 'active' : ''}`}>
      <div className="model-info">
        <strong>{o.label}
          {o.recommended && <span className="chip chip-blue">Recomendado</span>}
          {o.active && <span className="chip chip-ok">En uso</span>}
          {o.tiers.map((t) => <span className="chip" key={t}>{TIER_LABELS[t]}</span>)}
        </strong>
        <span className="small muted">{o.summary}</span>
        <span className="small row" style={{ gap: 6 }}>
          <FitBadge fit={o.fit} /><LicenseBadge info={{ id: o.license, class: 'permissive', note: 'Licencia permisiva: uso libre, también comercial.' }} />
          <span className="faint">{formatBytes(total)} · {o.quant} · {o.params_b} B{o.active_b && o.active_b !== o.params_b ? ` (${o.active_b} B activos)` : ''}</span>
        </span>
        <span className="small faint">{o.languages}</span>
      </div>
      <div className="model-actions">
        {o.installed ? <InstalledBadge /> : (
          <button className="btn btn-sm" disabled={locked || o.fit.fits === 'no'} title={o.fit.fits === 'no' ? o.fit.note : undefined}
            onClick={() => startInstall(o.repo, o.file, { mmproj: mm })}>
            <Download />Descargar
          </button>
        )}
      </div>
    </div>
  );
}
