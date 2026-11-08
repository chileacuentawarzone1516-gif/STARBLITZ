import { Activity, AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, BookMarked, BookOpen, Check, Cpu, Download, FilePlus2, MoreVertical, PenLine, RefreshCw, Trash2 } from 'lucide-react';
import { LANGUAGES, PAGE_STATE_LABELS, VARIANTS, type Page, type PageState } from '@starblitz/shared';
import { useState } from 'react';
import { TranslatedThumb, useImageUrl } from '../components/images';
import { Segmented, Sheet, TopBar } from '../components/ui';
import { useBundle } from '../hooks';
import { startProcess } from '../lib/actions';
import { saveReport } from '../lib/exportFile';
import { tap } from '../lib/platform';
import { navigate } from '../router';
import { confirmAction, engine, reportError, toast, useActiveJob, useApp } from '../state/app';
import { ExportSheet } from './ExportSheet';
import { ImportSheet } from './ImportSheet';
import { RunPanel } from './RunPanel';

function Thumb({ projectId, page, state, translated, onClick }: { projectId: string; page: Page; state: PageState | undefined; translated: boolean; onClick: () => void }) {
  const url = useImageUrl(projectId, page.id, 'thumb', page.updated);
  const review = page.regions.filter((r) => r.status === 'review').length;
  const busy = state && !['pending', 'done', 'error'].includes(state);
  const showTranslated = translated && page.has_clean;
  return (
    <button className={`m-thumb ${state ?? ''} ${busy ? 'busy' : ''}`} onClick={onClick}
      aria-label={`Página ${page.index + 1}${state ? `: ${PAGE_STATE_LABELS[state]}` : ''}${page.approved ? ', aprobada' : ''}`}>
      {showTranslated ? <TranslatedThumb projectId={projectId} page={page} /> : url && <img src={url} alt="" loading="lazy" />}
      <span className="m-thumb-num mono">{page.index + 1}</span>
      {state === 'error' ? <span className="m-thumb-badge err"><AlertTriangle /></span>
        : state === 'pending' ? <span className="m-thumb-badge wait" aria-hidden>·</span>
        : busy ? <span className="m-thumb-badge work"><span className="spinner" /></span>
        : page.approved ? <span className="m-thumb-badge ok"><Check /></span>
        : review > 0 ? <span className="m-thumb-badge review">{review}</span>
        : state === 'done' ? <span className="m-thumb-badge ok"><Check /></span> : null}
    </button>
  );
}

export function ProjectScreen({ id }: { id: string }) {
  const { bundle, reload, missing } = useBundle(id);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.runs[id]);
  const job = useActiveJob(id, ['process']);
  const other = useActiveJob(id);
  const [ordering, setOrdering] = useState(false);
  const [view, setView] = useState<'original' | 'translated'>('original');

  if (missing) return <div className="m-screen m-center"><p className="muted">Este proyecto ya no existe.</p><button className="btn" onClick={() => navigate('/')}>Volver</button></div>;
  if (!bundle) return <div className="m-screen m-center"><span className="spinner" /></div>;
  const { project, pages, summary } = bundle;
  const hasClean = pages.some((p) => p.has_clean);
  const working = !!other;

  const move = async (from: number, to: number) => {
    if (to < 0 || to >= pages.length) return;
    const ids = pages.map((p) => p.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    try { await engine().reorderPages(id, ids); await reload(); } catch (e) { reportError(e); }
  };
  const exportReport = async () => {
    try {
      const saved = await saveReport(project.name, await engine().report(id));
      openSheet(null);
      toast('ok', saved[0]?.location ? `Informe guardado en ${saved[0].location}` : 'Informe listo');
    } catch (e) { reportError(e, 'No se pudo exportar el informe'); }
  };
  const removePage = async (p: Page) => {
    if (!(await confirmAction({ title: `¿Eliminar la página ${p.index + 1}?`, message: 'Se borra del proyecto en este teléfono.', confirm: 'Eliminar', danger: true }))) return;
    try { await engine().deletePage(id, p.id); await reload(); await useApp.getState().refreshProjects(); } catch (e) { reportError(e); }
  };
  const removeProject = async () => {
    openSheet(null);
    if (!(await confirmAction({ title: `¿Eliminar «${project.name}»?`, message: 'Se borran sus páginas y traducciones de este teléfono. No se puede deshacer.', confirm: 'Eliminar', danger: true }))) return;
    try { await engine().deleteProject(id); await useApp.getState().refreshProjects(); navigate('/'); } catch (e) { reportError(e); }
  };
  const reprocess = async () => {
    openSheet(null);
    if (!(await confirmAction({ title: '¿Reprocesar todo el proyecto?', message: 'Se vuelven a detectar, traducir y reconstruir todas las páginas. Se pierden las ediciones manuales de los textos.', confirm: 'Reprocesar', danger: true }))) return;
    void startProcess(id, { force: true });
  };

  const translatedCount = summary.translated;
  const lang = project.source_lang === 'auto' ? (project.detected_lang ? LANGUAGES[project.detected_lang] ?? project.detected_lang : 'Idioma automático') : LANGUAGES[project.source_lang] ?? project.source_lang;

  return (
    <div className="m-screen">
      <TopBar title={project.name} sub={`${lang} → ${VARIANTS[project.target_variant]}`}
        left={<button className="m-icon-btn" aria-label="Volver" onClick={() => navigate('/')}><ArrowLeft /></button>}
        right={<button className="m-icon-btn" aria-label="Más opciones" onClick={() => openSheet('project-menu')}><MoreVertical /></button>} />

      <section className="m-stats" aria-label="Resumen">
        <div><strong className="mono">{summary.page_count}</strong><span>{summary.page_count === 1 ? 'página' : 'páginas'}</span></div>
        <div><strong className="mono">{translatedCount}/{summary.regions}</strong><span>textos</span></div>
        <div className={summary.review ? 'review' : ''}><strong className="mono">{summary.review}</strong><span>por revisar</span></div>
      </section>

      <RunPanel project={project} pages={pages} job={job} run={run} />

      {!job && (
        <div className="m-actions">
          <button className="btn btn-primary m-action-main" disabled={!pages.length || working} onClick={() => { tap('medium'); void startProcess(id); }}>
            <Cpu />{summary.regions ? 'Procesar páginas pendientes' : 'Traducir proyecto'}
          </button>
          <div className="m-action-grid">
            <button className="btn" onClick={() => navigate(`/p/${id}/read/0`)} disabled={!pages.length}><BookOpen />Leer</button>
            <button className="btn" onClick={() => navigate(`/p/${id}/edit/0`)} disabled={!pages.length}><PenLine />Editar</button>
            <button className="btn" onClick={() => openSheet('export')} disabled={!pages.length || working}><Download />Exportar</button>
            <button className="btn" onClick={() => navigate(`/p/${id}/context`)}><BookMarked />Contexto</button>
          </div>
        </div>
      )}

      <div className="m-section-head">
        <h2>Páginas</h2>
        <div className="m-row-gap">
          {hasClean && !ordering && <Segmented<'original' | 'translated'> label="Vista de miniaturas" value={view} onChange={setView} options={[{ id: 'original', label: 'Original' }, { id: 'translated', label: 'Traducido' }]} />}
          <button className="btn btn-ghost btn-sm" disabled={!!job} onClick={() => setOrdering((v) => !v)}>{ordering ? 'Listo' : 'Ordenar'}</button>
        </div>
      </div>
      {ordering ? (
        <ol className="m-order-list">
          {pages.map((p, i) => (
            <li key={p.id}>
              <span className="mono">{i + 1}</span><span className="m-order-name">{p.filename}</span>
              <button className="m-icon-btn" aria-label={`Subir la página ${i + 1}`} onClick={() => move(i, i - 1)} disabled={i === 0}><ArrowUp /></button>
              <button className="m-icon-btn" aria-label={`Bajar la página ${i + 1}`} onClick={() => move(i, i + 1)} disabled={i === pages.length - 1}><ArrowDown /></button>
              <button className="m-icon-btn danger" aria-label={`Eliminar la página ${i + 1}`} onClick={() => removePage(p)}><Trash2 /></button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="m-thumb-grid">
          {pages.map((p) => (
            <Thumb key={p.id} projectId={id} page={p} state={run?.pages[p.id]?.state} translated={view === 'translated'}
              onClick={() => navigate(`/p/${id}/read/${p.index}`)} />
          ))}
        </div>
      )}

      <ExportSheet project={project} pages={pages} />
      <ImportSheet sheetId="import-add" projectId={id} onDone={reload} />
      <Sheet id="project-menu" title="Proyecto">
        <div className="m-menu">
          <button onClick={() => { openSheet(null); navigate(`/p/${id}/edit/0`); }}><PenLine />Abrir editor</button>
          <button onClick={() => openSheet('import-add')} disabled={working}><FilePlus2 />Añadir páginas</button>
          <button onClick={() => { openSheet(null); navigate(`/p/${id}/context`); }}><BookMarked />Contexto, glosario y estilo</button>
          <button onClick={reprocess} disabled={working || !pages.length}><RefreshCw />Reprocesar todo</button>
          <button onClick={exportReport}><Activity />Exportar informe de rendimiento (JSON)</button>
          <button className="danger" onClick={removeProject} disabled={working}><Trash2 />Eliminar proyecto</button>
        </div>
      </Sheet>
    </div>
  );
}
