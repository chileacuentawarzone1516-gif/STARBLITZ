import { FolderOpen, MoreVertical, Plus, Search, Trash2 } from 'lucide-react';
import { formatRelative, LANGUAGES, type ProjectSummary, plural } from '@starblitz/shared';
import { useMemo, useState } from 'react';
import { EmptyState } from '../components/Chrome';
import { confirmAction } from '../components/Dialog';
import { pickFiles, useImportFlow } from '../components/ImportFlow';
import { navigate } from '../router';
import { client, reportError, useApp } from '../store';

type Sort = 'recent' | 'name' | 'pages';

function Progress({ p }: { p: ProjectSummary }) {
  const pct = p.regions ? Math.round((p.translated / p.regions) * 100) : 0;
  return (
    <div className="card-progress" title={`${p.translated} de ${p.regions} textos traducidos`}>
      <div className="progress"><i style={{ width: `${pct}%` }} /></div>
      <span className="small muted mono">{p.regions ? `${pct} %` : 'Sin procesar'}</span>
    </div>
  );
}

export function Projects() {
  const { projects, refreshProjects } = useApp();
  const api = useApp((s) => s.client);
  const start = useImportFlow((s) => s.start);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [menu, setMenu] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    return [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'es')
      : sort === 'pages' ? b.page_count - a.page_count : b.updated - a.updated);
  }, [projects, query, sort]);

  const remove = async (p: ProjectSummary) => {
    setMenu(null);
    const ok = await confirmAction({ title: `¿Eliminar «${p.name}»?`, message: 'Se borrarán sus páginas, traducciones e imágenes reconstruidas. No se puede deshacer.', confirm: 'Eliminar proyecto', danger: true });
    if (!ok) return;
    try {
      await client().deleteProject(p.id);
      useApp.getState().toast('ok', 'Proyecto eliminado');
      refreshProjects();
    } catch (e) { reportError(e); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Mis proyectos</h1>
        <button className="btn btn-primary" onClick={() => pickFiles((f) => start(f))}><Plus />Nuevo proyecto</button>
      </div>
      <div className="toolbar-row">
        <label className="search">
          <Search aria-hidden />
          <input className="input" placeholder="Buscar proyectos" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar proyectos" />
        </label>
        <div className="segmented" role="group" aria-label="Ordenar por">
          {([['recent', 'Recientes'], ['name', 'Nombre'], ['pages', 'Páginas']] as [Sort, string][]).map(([k, l]) => (
            <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={<FolderOpen />} title={projects.length ? 'Ningún proyecto coincide con la búsqueda' : 'Aún no tienes proyectos'}
          action={!projects.length && <button className="btn btn-primary" onClick={() => pickFiles((f) => start(f))}><Plus />Importar un capítulo</button>}>
          {projects.length ? 'Prueba con otro nombre.' : 'Importa un ZIP, PDF o imágenes para crear el primero.'}
        </EmptyState>
      ) : (
        <div className="project-grid">
          {list.map((p) => (
            <article key={p.id} className="project-card">
              <button className="cover" onClick={() => navigate(`/project/${p.id}`)} aria-label={`Abrir ${p.name}`}>
                {p.cover_page_id && api && <img src={api.imageUrl(p.id, p.cover_page_id, 'thumb')} alt="" loading="lazy" />}
                {p.review > 0 && <span className="chip chip-review cover-badge">{p.review} por revisar</span>}
              </button>
              <div className="project-meta">
                <div style={{ minWidth: 0 }}>
                  <h3 title={p.name}>{p.name}</h3>
                  <span className="small muted">{plural(p.page_count, 'página', 'páginas')} · {LANGUAGES[p.source_lang] ?? p.source_lang} · {formatRelative(p.updated)}</span>
                </div>
                <div className="menu-wrap">
                  <button className="btn btn-ghost btn-icon btn-sm" aria-label="Más acciones" aria-expanded={menu === p.id}
                    onClick={() => setMenu(menu === p.id ? null : p.id)}><MoreVertical /></button>
                  {menu === p.id && (
                    <div className="menu" role="menu" onMouseLeave={() => setMenu(null)}>
                      <button role="menuitem" onClick={() => navigate(`/editor/${p.id}`)}>Abrir en el editor</button>
                      <button role="menuitem" className="danger" onClick={() => remove(p)}><Trash2 />Eliminar</button>
                    </div>
                  )}
                </div>
              </div>
              <Progress p={p} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
