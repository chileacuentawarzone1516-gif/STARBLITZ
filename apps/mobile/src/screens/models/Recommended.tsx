import { Download, Eye } from 'lucide-react';
import { formatBytes, TIER_LABELS, type CatalogModel, type LLMOverview } from '@starblitz/shared';
import { useState } from 'react';
import { DownloadStatus, FitBadge, InstalledBadge, LicenseBadge, startInstall } from './shared';

const fitRank = (o: CatalogModel) => ({ gpu: 0, hybrid: 1, cpu: 2, no: 3 })[o.fit.fits];

/** Catálogo curado (pesos abiertos, licencias permisivas), ordenado según ESTE teléfono. */
export function Recommended({ llm }: { llm: LLMOverview }) {
  const { advice } = llm;
  const [withVision, setWithVision] = useState(advice.profile.vision_llm);
  const options = [...advice.options].sort((a, b) => Number(b.recommended) - Number(a.recommended) || fitRank(a) - fitRank(b) || a.size - b.size);
  const installing = llm.installing.length > 0;
  const rec = options.find((o) => o.id === advice.recommended);
  return (
    <div className="m-stack">
      <div className="m-callout">
        <Eye aria-hidden />
        <div>
          <strong>{advice.supported ? `Para este teléfono (${TIER_LABELS[advice.profile.id]}) recomendamos ${rec?.label ?? advice.recommended}` : 'Este teléfono tiene poca memoria para traducir en local'}</strong>
          <p className="small muted">{advice.reason}</p>
        </div>
      </div>
      <label className="m-check">
        <input type="checkbox" checked={withVision} onChange={(e) => setWithVision(e.target.checked)} />
        <span>Descargar también la parte visual (el modelo «ve» la página). <span className="faint">Añade 0,3–1 GB y gasta más memoria: en teléfonos modestos conviene dejarlo desactivado.</span></span>
      </label>
      <DownloadStatus kinds={['llm_install']} />
      <div className="m-model-list">
        {options.map((o) => {
          const mm = withVision && o.mmproj ? o.mmproj : null;
          const total = o.size + (mm ? o.mmproj_size : 0);
          return (
            <article key={o.id} className={`m-model ${o.active ? 'active' : ''}`}>
              <header>
                <strong>{o.label}</strong>
                <span className="m-chip-row">
                  {o.recommended && <span className="chip chip-blue">Recomendado</span>}
                  {o.active && <span className="chip chip-ok">En uso</span>}
                </span>
              </header>
              <p className="small muted">{o.summary}</p>
              <div className="m-chip-row">
                <FitBadge fit={o.fit} />
                <LicenseBadge info={{ id: o.license, class: 'permissive', note: 'Licencia permisiva: uso libre, también comercial.' }} />
              </div>
              <p className="small faint">{formatBytes(total)} · {o.quant} · {o.params_b} B{o.active_b && o.active_b !== o.params_b ? ` (${o.active_b} B activos)` : ''} · {o.languages}</p>
              <footer>
                {o.installed ? <InstalledBadge /> : (
                  <button className="btn btn-sm btn-primary" disabled={installing || o.fit.fits === 'no'} title={o.fit.fits === 'no' ? o.fit.note : undefined}
                    onClick={() => startInstall(o.repo, o.file, { mmproj: mm, size: total })}><Download />Descargar</button>
                )}
                {o.fit.fits === 'no' && <span className="small text-danger">{o.fit.note}</span>}
              </footer>
            </article>
          );
        })}
      </div>
      <p className="small faint">¿Buscas otro modelo? En «Explorar» puedes instalar cualquier GGUF de Hugging Face; antes te decimos si cabe en este teléfono.</p>
    </div>
  );
}
