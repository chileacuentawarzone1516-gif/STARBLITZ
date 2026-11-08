import {
  CheckCheck, ChevronLeft, ChevronRight, Columns2, Download, Eye, Image as ImageIcon, Languages, Maximize, MousePointer2, Redo2,
  RefreshCw, Sparkles, SquarePlus, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { EmptyState } from '../components/Chrome';
import { ExportDialog } from '../components/ExportDialog';
import { navigate } from '../router';
import { client, reportError, useApp } from '../store';
import { useProjectBundle } from '../views/ProjectView';
import { Inspector } from './Inspector';
import { Stage } from './Stage';
import { flushPending, useEditor, type ViewMode } from './useEditor';

function useHistoryState() {
  const history = useEditor((s) => s.history);
  return useSyncExternalStore((cb) => history.subscribe(cb), () => `${history.canUndo}|${history.canRedo}|${history.undoLabel}|${history.redoLabel}`);
}

function PageStrip() {
  const { project, pages, pageIndex, setPage } = useEditor();
  const api = useApp((s) => s.client);
  return (
    <nav className="page-strip" aria-label="Páginas">
      {pages.map((p, i) => (
        <button key={p.id} className={`strip-item ${i === pageIndex ? 'on' : ''}`} onClick={() => setPage(i)} aria-current={i === pageIndex ? 'page' : undefined}>
          {api && project && <img src={api.imageUrl(project.id, p.id, 'thumb', p.updated)} alt="" loading="lazy" />}
          <span className="strip-num mono">{i + 1}</span>
          {p.approved && <span className="strip-ok" aria-label="Aprobada"><CheckCheck /></span>}
          {!p.approved && p.regions.some((r) => r.status === 'review') && <span className="strip-review" aria-label="Con textos por revisar" />}
        </button>
      ))}
    </nav>
  );
}

export function EditorView({ projectId, pageId }: { projectId?: string; pageId?: string }) {
  const projects = useApp((s) => s.projects);
  const { bundle } = useProjectBundle(projectId);
  const ed = useEditor();
  const hist = useHistoryState();
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState<'' | 'clean' | 'translate'>('');
  const page = ed.pages[ed.pageIndex];
  const [canUndo, canRedo, undoLabel, redoLabel] = hist.split('|');

  useEffect(() => {
    if (bundle) ed.load(bundle.project, bundle.pages, pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle]);

  useEffect(() => () => { flushPending(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ed = useEditor.getState();
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? ed.history.redo() : ed.history.undo(); }
      else if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); ed.history.redo(); }
      else if (typing) return;
      else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !mod)) ed.setPage(ed.pageIndex + 1);
      else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !mod)) ed.setPage(ed.pageIndex - 1);
      else if (e.key === 'Escape') { ed.select(null); ed.setTool('select'); }
      else if (e.key.toLowerCase() === 'n') ed.setTool('draw');
      else if (e.key === '1') ed.setView('original');
      else if (e.key === '2') ed.setView('translated');
      else if (e.key === '3') ed.setView('compare');
      else if (e.key === '0') ed.setZoom(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!projectId) {
    return (
      <div className="page">
        <h1>Editor</h1>
        <EmptyState icon={<Languages />} title={projects.length ? 'Elige un proyecto para editar' : 'Aún no tienes proyectos'}>
          {projects.length ? '' : 'Importa un capítulo desde Inicio.'}
        </EmptyState>
        <div className="project-pick">
          {projects.map((p) => <button key={p.id} className="btn" onClick={() => navigate(`/editor/${p.id}`)}>{p.name}</button>)}
        </div>
      </div>
    );
  }
  if (!bundle || !ed.project) return <div className="page center"><div className="spinner" /></div>;

  const stale = page ? !!ed.staleClean[page.id] : false;
  const reclean = async () => {
    if (!page || !ed.project) return;
    setBusy('clean');
    try {
      await flushPending();
      const job = await client().cleanPage(ed.project.id, page.id);
      const done = await client().waitJob(job.id, undefined, 500);
      if (done.status !== 'done') throw new Error(done.error || 'No se pudo reconstruir.');
      ed.replacePage(await client().page(ed.project.id, page.id));
      ed.markClean(page.id, false);
    } catch (e) { reportError(e, 'No se pudo reconstruir la página'); }
    setBusy('');
  };
  const retranslatePage = async () => {
    if (!page || !ed.project) return;
    const ids = page.regions.filter((r) => r.status !== 'approved' && r.status !== 'edited').map((r) => r.id);
    if (!ids.length) { useApp.getState().toast('info', 'Nada que retraducir', 'Todos los textos están aprobados o editados por ti.'); return; }
    setBusy('translate');
    try {
      await flushPending();
      const job = await client().translateRegions(ed.project.id, page.id, ids);
      const done = await client().waitJob(job.id, undefined, 800);
      if (done.status !== 'done') throw new Error(done.error || 'No se pudo retraducir.');
      ed.replacePage(await client().page(ed.project.id, page.id));
    } catch (e) { reportError(e, 'No se pudo retraducir la página'); }
    setBusy('');
  };
  const approve = async () => {
    if (!page || !ed.project) return;
    try {
      await flushPending();
      ed.replacePage(await client().approvePage(ed.project.id, page.id, !page.approved));
      useApp.getState().refreshProjects();
    } catch (e) { reportError(e); }
  };

  const views: [ViewMode, string, typeof Eye][] = [['original', 'Original', ImageIcon], ['translated', 'Traducido', Eye], ['compare', 'Comparar', Columns2]];

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <div className="tb-group">
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/project/${ed.project!.id}`)} title="Volver al proyecto"><ChevronLeft />{ed.project.name}</button>
        </div>
        <div className="segmented" role="group" aria-label="Vista">
          {views.map(([v, label, Icon]) => <button key={v} aria-pressed={ed.view === v} onClick={() => ed.setView(v)}><Icon />{label}</button>)}
        </div>
        <div className="segmented" role="group" aria-label="Herramienta">
          <button aria-pressed={ed.tool === 'select'} onClick={() => ed.setTool('select')} title="Seleccionar y mover (Esc)"><MousePointer2 />Editar</button>
          <button aria-pressed={ed.tool === 'draw'} onClick={() => ed.setTool('draw')} title="Dibuja un recuadro sobre un texto no detectado (N)"><SquarePlus />Nuevo texto</button>
        </div>
        <div className="tb-group">
          <button className="btn btn-ghost btn-icon btn-sm" disabled={canUndo !== 'true'} onClick={() => ed.history.undo()} title={`Deshacer ${undoLabel} (Ctrl+Z)`} aria-label="Deshacer"><Undo2 /></button>
          <button className="btn btn-ghost btn-icon btn-sm" disabled={canRedo !== 'true'} onClick={() => ed.history.redo()} title={`Rehacer ${redoLabel} (Ctrl+Y)`} aria-label="Rehacer"><Redo2 /></button>
        </div>
        <div className="tb-group">
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Alejar" onClick={() => ed.setZoom((ed.zoom || 0.5) / 1.2)}><ZoomOut /></button>
          <button className="btn btn-ghost btn-sm mono" onClick={() => ed.setZoom(0)} title="Ajustar a la ventana (0)"><Maximize />{ed.zoom ? `${Math.round(ed.zoom * 100)} %` : 'Ajustar'}</button>
          <button className="btn btn-ghost btn-icon btn-sm" aria-label="Acercar" onClick={() => ed.setZoom((ed.zoom || 0.5) * 1.2)}><ZoomIn /></button>
        </div>
        <div className="tb-group push">
          {ed.saving > 0 && <span className="small muted">Guardando…</span>}
          <button className="btn btn-sm" onClick={retranslatePage} disabled={!!busy || !page}>{busy === 'translate' ? <span className="spinner" /> : <RefreshCw />}Retraducir página</button>
          <button className={`btn btn-sm ${stale ? 'btn-primary' : ''}`} onClick={reclean} disabled={!!busy || !page} title="Vuelve a borrar el texto original con los recuadros actuales">
            {busy === 'clean' ? <span className="spinner" /> : <Sparkles />}Reconstruir
          </button>
          <button className={`btn btn-sm ${page?.approved ? 'btn-approved' : ''}`} onClick={approve} disabled={!page}><CheckCheck />{page?.approved ? 'Aprobada' : 'Aprobar página'}</button>
          <button className="btn btn-sm" onClick={() => setExporting(true)}><Download />Exportar</button>
        </div>
      </div>
      {stale && <div className="stale-banner">Has cambiado qué texto se borra. Pulsa «Reconstruir» para actualizar la imagen limpia.</div>}
      <div className="editor-body">
        <PageStrip />
        <div className="stage-col">
          <Stage />
          <div className="stage-footer">
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Página anterior" disabled={ed.pageIndex === 0} onClick={() => ed.setPage(ed.pageIndex - 1)}><ChevronLeft /></button>
            <span className="small mono">Página {ed.pageIndex + 1} de {ed.pages.length}</span>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Página siguiente" disabled={ed.pageIndex >= ed.pages.length - 1} onClick={() => ed.setPage(ed.pageIndex + 1)}><ChevronRight /></button>
            <span className="small faint">Ctrl + rueda para zoom · ← → para cambiar de página</span>
          </div>
        </div>
        <Inspector />
      </div>
      {exporting && <ExportDialog project={ed.project} pages={ed.pages} currentPageId={page?.id} onClose={() => setExporting(false)} />}
    </div>
  );
}
