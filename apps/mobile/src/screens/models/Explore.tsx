import { ArrowLeft, Download, Heart, Lock, Search } from 'lucide-react';
import { formatBytes, type HFRepoInfo, type HFSearchResult, type LLMOverview } from '@starblitz/shared';
import { useEffect, useState } from 'react';
import { engine, reportError } from '../../state/app';
import { DownloadStatus, FitBadge, InstalledBadge, LicenseBadge, startInstall } from './shared';

const IDEAS = ['qwen gguf', 'gemma gguf', 'japanese translation gguf', 'llama gguf'];
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n));

/** Búsqueda en Hugging Face: solo catálogo y descarga. No se envía ningún contenido de las personas. */
export function Explore({ llm }: { llm: LLMOverview }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HFSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);

  const search = async (q = query) => {
    if (!q.trim()) return;
    setBusy(true);
    try { setResults(await engine().searchModels(q.trim())); } catch (e) { reportError(e, 'No se pudo buscar en Hugging Face'); }
    setBusy(false);
  };
  if (repo) return <RepoDetail repo={repo} llm={llm} onBack={() => setRepo(null)} />;

  return (
    <div className="m-stack">
      <p className="muted small">Busca modelos en formato GGUF. Se necesita Internet solo para buscar y descargar; después el modelo funciona sin conexión.</p>
      <form className="m-search" role="search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre, familia o idioma («qwen», «gemma»)" aria-label="Buscar modelos en Hugging Face" enterKeyHint="search" />
        <button className="btn btn-primary" type="submit" disabled={busy || !query.trim()} aria-label="Buscar">{busy ? <span className="spinner" /> : <Search />}</button>
      </form>
      {!results && <div className="m-chips">{IDEAS.map((i) => <button key={i} className="m-chip" onClick={() => { setQuery(i); void search(i); }}>{i}</button>)}</div>}
      <DownloadStatus kinds={['llm_install']} />
      {results && (results.length === 0 ? <p className="muted">No hay resultados. Prueba con otro nombre.</p> : (
        <div className="m-model-list">
          {results.map((r) => (
            <article className="m-model" key={r.repo}>
              <header><strong className="m-break">{r.repo}</strong>{r.installed && <InstalledBadge />}</header>
              <div className="m-chip-row">
                <LicenseBadge info={r.license_info} />
                {r.gated && <span className="chip chip-warn"><Lock aria-hidden />Requiere aceptar condiciones</span>}
              </div>
              <p className="small faint">
                <Download aria-hidden className="m-inline-icon" /> {compact(r.downloads)} · <Heart aria-hidden className="m-inline-icon" /> {compact(r.likes)}
                {r.languages.length > 0 && ` · ${r.languages.slice(0, 6).join(' · ')}`}
              </p>
              <footer><button className="btn btn-sm" onClick={() => setRepo(r.repo)}>Ver archivos</button></footer>
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

function RepoDetail({ repo, llm, onBack }: { repo: string; llm: LLMOverview; onBack: () => void }) {
  const [info, setInfo] = useState<HFRepoInfo | null>(null);
  const [error, setError] = useState('');
  const [withVision, setWithVision] = useState(false);
  const installedKey = llm.installed_models.map((m) => m.id).sort().join('|');
  useEffect(() => {
    let alive = true;
    engine().inspectRepo(repo).then((i) => { if (alive) { setInfo(i); setError(''); } }).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [repo, installedKey]);
  const installing = llm.installing.length > 0;
  const mm = withVision ? info?.mmproj_suggested ?? null : null;
  return (
    <div className="m-stack">
      <div className="m-row-gap"><button className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft />Resultados</button></div>
      <h2 className="m-break">{repo}</h2>
      {error && <p className="text-danger" role="alert">{error}</p>}
      {!info && !error && <div className="m-center"><span className="spinner" /></div>}
      {info && (
        <>
          <div className="m-chip-row"><LicenseBadge info={info.license} />{info.gated && !llm.hf_token_set && <span className="chip chip-warn"><Lock aria-hidden />Pide aceptar condiciones: añade tu token en Ajustes</span>}</div>
          <p className="small muted">{info.arch || 'arquitectura desconocida'}{info.params_b ? ` · ${info.params_b} B parámetros` : ''}{info.context_native ? ` · contexto nativo ${info.context_native.toLocaleString('es')}` : ''}</p>
          {info.license.class !== 'permissive' && <p className="small muted">{info.license.note}</p>}
          {info.mmproj_suggested && (
            <label className="m-check"><input type="checkbox" checked={withVision} onChange={(e) => setWithVision(e.target.checked)} /><span>Incluir la parte visual ({formatBytes(info.mmproj_suggested.size)}).</span></label>
          )}
          <DownloadStatus kinds={['llm_install']} />
          <div className="m-model-list">
            {info.files.length === 0 && <p className="muted">Este repositorio no contiene archivos GGUF instalables.</p>}
            {info.files.map((f) => (
              <article className="m-model" key={f.path}>
                <header><strong>{f.quant || 'GGUF'}</strong>{f.installed && <InstalledBadge />}</header>
                <p className="small faint mono m-break">{f.path}</p>
                <div className="m-chip-row"><FitBadge fit={f.fit} /></div>
                <p className="small faint">{formatBytes(f.size + (mm?.size ?? 0))}{f.shards > 1 ? ` · ${f.shards} partes` : ''} · necesita ~{f.fit.need_gb} GB de memoria</p>
                {f.fit.fits === 'no' && <p className="small text-danger">{f.fit.note}</p>}
                {!f.installed && (
                  <footer><button className="btn btn-sm btn-primary" disabled={installing || f.fit.fits === 'no'}
                    onClick={() => startInstall(repo, f.path, { mmproj: mm?.path ?? null, size: f.size + (mm?.size ?? 0) })}><Download />Instalar</button></footer>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
