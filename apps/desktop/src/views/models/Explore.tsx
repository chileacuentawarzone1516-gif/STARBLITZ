import { ArrowLeft, Download, Heart, Lock, Search } from 'lucide-react';
import { formatBytes, type HFRepoInfo, type HFSearchResult, type LLMOverview } from '@starblitz/shared';
import { useEffect, useState } from 'react';
import { client, reportError } from '../../store';
import { FitBadge, InstalledBadge, LicenseBadge } from './badges';
import { DownloadStatus, startInstall } from './install';

const IDEAS = ['qwen gguf', 'gemma gguf', 'japanese translation gguf', 'llama gguf'];

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));

/** Búsqueda en Hugging Face (solo catálogo y descarga: no se usa ninguna API de pago ni se envía contenido). */
export function Explore({ llm }: { llm: LLMOverview }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HFSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);

  const search = async (q = query) => {
    if (!q.trim()) return;
    setBusy(true);
    try { setResults(await client().searchModels(q.trim())); } catch (e) { reportError(e, 'No se pudo buscar en Hugging Face'); }
    setBusy(false);
  };

  if (repo) return <RepoDetail repo={repo} llm={llm} onBack={() => setRepo(null)} />;

  return (
    <div className="stack">
      <section className="settings-section">
        <h2>Explorar Hugging Face</h2>
        <p className="muted">Busca modelos en formato GGUF. Necesitas Internet solo para buscar y descargar; después el modelo funciona sin conexión.</p>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input className="input" style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre, familia o idioma (p. ej. «qwen», «gemma»)" aria-label="Buscar modelos en Hugging Face" />
          <button className="btn btn-primary" type="submit" disabled={busy || !query.trim()}>{busy ? <span className="spinner" /> : <Search />}Buscar</button>
        </form>
        {!results && (
          <div className="row">
            <span className="small muted">Ideas:</span>
            {IDEAS.map((i) => <button key={i} className="chip chip-button" onClick={() => { setQuery(i); search(i); }}>{i}</button>)}
          </div>
        )}
        <DownloadStatus kinds={['llm_install']} />
        {results && (results.length === 0 ? <p className="muted">No hay resultados. Prueba con otro nombre.</p> : (
          <div className="model-list">
            {results.map((r) => (
              <div className="model-row" key={r.repo}>
                <div className="model-info">
                  <strong>{r.repo}{r.installed && <InstalledBadge />}{r.gated && <span className="chip chip-warn"><Lock aria-hidden />Requiere aceptar condiciones</span>}</strong>
                  <span className="small row" style={{ gap: 8 }}>
                    <LicenseBadge info={r.license_info} />
                    <span className="faint"><Download aria-hidden style={{ width: 12, height: 12, verticalAlign: -1 }} /> {compact(r.downloads)}</span>
                    <span className="faint"><Heart aria-hidden style={{ width: 12, height: 12, verticalAlign: -1 }} /> {compact(r.likes)}</span>
                    {r.languages.length > 0 && <span className="faint">{r.languages.slice(0, 6).join(' · ')}</span>}
                  </span>
                </div>
                <div className="model-actions"><button className="btn btn-sm" onClick={() => setRepo(r.repo)}>Ver archivos</button></div>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function RepoDetail({ repo, llm, onBack }: { repo: string; llm: LLMOverview; onBack: () => void }) {
  const [info, setInfo] = useState<HFRepoInfo | null>(null);
  const [error, setError] = useState('');
  const [withVision, setWithVision] = useState(false);
  // Se vuelve a consultar el repositorio cuando cambia el conjunto de modelos instalados: al terminar una
  // descarga, el archivo pasa a «Instalado» sin salir de la pantalla.
  const installedKey = llm.installed_models.map((m) => m.id).sort().join('|');
  useEffect(() => {
    let alive = true;
    client().inspectRepo(repo).then((i) => { if (alive) { setInfo(i); setError(''); } })
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [repo, installedKey]);
  const installing = llm.installing.length > 0;
  const mm = withVision ? info?.mmproj_suggested ?? null : null;

  return (
    <div className="stack">
      <section className="settings-section">
        <div className="row">
          <button className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft />Resultados</button>
          <h2 style={{ fontSize: 20 }}>{repo}</h2>
        </div>
        {error && <p className="text-danger">{error}</p>}
        {!info && !error && <div className="spinner" />}
        {info && (
          <>
            <div className="row" style={{ gap: 8 }}>
              <LicenseBadge info={info.license} />
              <span className="small muted">{info.arch || 'arquitectura desconocida'}{info.params_b ? ` · ${info.params_b} B parámetros` : ''}{info.context_native ? ` · contexto nativo ${info.context_native.toLocaleString('es')}` : ''}</span>
              {info.gated && !llm.hf_token_set && <span className="chip chip-warn"><Lock aria-hidden />Pide aceptar condiciones: añade tu token en «Avanzado»</span>}
            </div>
            {info.license.class !== 'permissive' && <p className="small muted">{info.license.note}</p>}
            {info.mmproj_suggested && (
              <label className="toggle-inline">
                <input type="checkbox" checked={withVision} onChange={(e) => setWithVision(e.target.checked)} />
                <span>Incluir la parte visual ({formatBytes(info.mmproj_suggested.size)}) para que el modelo vea la página.</span>
              </label>
            )}
            <DownloadStatus kinds={['llm_install']} />
            <div className="model-list">
              {info.files.length === 0 && <p className="muted" style={{ padding: 16 }}>Este repositorio no contiene archivos GGUF instalables.</p>}
              {info.files.map((f) => (
                <div className="model-row" key={f.path}>
                  <div className="model-info">
                    <strong>{f.quant || 'GGUF'} <span className="small faint mono">{f.path}</span></strong>
                    <span className="small row" style={{ gap: 6 }}>
                      <FitBadge fit={f.fit} />
                      <span className="faint">{formatBytes(f.size + (mm?.size ?? 0))}{f.shards > 1 ? ` · ${f.shards} partes` : ''} · necesita ~{f.fit.need_gb} GB de memoria</span>
                    </span>
                    {f.fit.fits === 'no' && <span className="small text-danger">{f.fit.note}</span>}
                  </div>
                  <div className="model-actions">
                    {f.installed ? <InstalledBadge /> : (
                      <button className="btn btn-sm" disabled={installing || f.fit.fits === 'no'} onClick={() => startInstall(repo, f.path, { mmproj: mm?.path ?? null })}>
                        <Download />Instalar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
