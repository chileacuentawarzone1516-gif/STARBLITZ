import {
  AlignCenter, AlignLeft, AlignRight, ArrowLeft, Check, ChevronLeft, ChevronRight, Flag, MoreVertical, Minus, Move, Plus, PlusSquare, Redo2, RefreshCw, ScanText, Trash2, Undo2,
} from 'lucide-react';
import { FLAG_LABELS, History, KIND_LABELS, layoutRegion, regionFits, type BBox, type Page, type Region } from '@starblitz/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PageCanvas } from '../components/images';
import { Sheet } from '../components/ui';
import { tap } from '../lib/platform';
import { navigate } from '../router';
import { confirmAction, engine, reportError, toast, useApp, waitForJob } from '../state/app';

const history = new History(100, 1500);
const SAVE_DELAY = 400;

type Mode = 'select' | 'move' | 'draw';

export function MobileEditor({ id, start }: { id: string; start: number }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [sourceLang, setSourceLang] = useState('ja');
  const [index, setIndex] = useState(start);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('select');
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<BBox | null>(null);
  const openSheet = useApp((s) => s.openSheet);
  const sheet = useApp((s) => s.sheet);
  const processing = useApp((s) => Object.values(s.jobs).some((j) => j.project_id === id && j.kind === 'process' && ['queued', 'running', 'paused'].includes(j.status)));
  const stageRef = useRef<HTMLDivElement>(null);
  const queue = useRef(new Map<string, { gid: string; rid: string; patch: Record<string, unknown> }>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useSyncExternalStore((cb) => history.subscribe(cb), () => `${history.canUndo}${history.canRedo}`);

  useEffect(() => {
    let alive = true;
    engine().project(id).then((b) => { if (alive) { setPages(b.pages); setSourceLang(b.project.source_lang === 'auto' ? b.project.detected_lang || 'ja' : b.project.source_lang); } }).catch(reportError);
    return () => { alive = false; };
  }, [id]);

  // -- guardado de ediciones (agrupado y en orden) ---------------------------------------------------------------
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const items = [...queue.current.values()];
    queue.current.clear();
    for (const it of items) {
      try { await engine().updateRegion(id, it.gid, it.rid, it.patch); } catch (e) { reportError(e, 'No se pudo guardar el cambio'); }
    }
  }, [id]);
  useEffect(() => () => { void flush(); history.clear(); }, [flush]);

  const persist = (gid: string, rid: string, patch: Record<string, unknown>) => {
    const key = `${gid}/${rid}`;
    const prev = queue.current.get(key);
    queue.current.set(key, { gid, rid, patch: { ...(prev?.patch ?? {}), ...patch } });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, SAVE_DELAY);
  };
  const mutate = (gid: string, rid: string, patch: Partial<Region>) => {
    setPages((list) => list && list.map((p) => (p.id !== gid ? p : { ...p, regions: p.regions.map((r) => (r.id === rid ? { ...r, ...patch, updated: Date.now() / 1000 } : r)) })));
    persist(gid, rid, patch as Record<string, unknown>);
  };

  const page = pages?.[index];
  const region = page?.regions.find((r) => r.id === selected) ?? null;

  const edit = (patch: Partial<Region>, label: string, key?: string) => {
    if (!page || !region) return;
    const before: Partial<Region> = {};
    for (const k of Object.keys(patch) as (keyof Region)[]) (before as Record<string, unknown>)[k] = structuredClone(region[k]);
    const gid = page.id;
    const rid = region.id;
    const finalPatch = patch.translation !== undefined && region.status !== 'approved' ? { ...patch, status: 'edited' as const } : patch;
    mutate(gid, rid, finalPatch);
    history.push({ label, mergeKey: key ? `${rid}:${key}` : undefined, apply: () => mutate(gid, rid, finalPatch), revert: () => mutate(gid, rid, { ...before, status: region.status }) });
  };

  const refreshPage = async (gid: string) => {
    await flush();
    const fresh = await engine().page(id, gid);
    setPages((list) => list && list.map((p) => (p.id === gid ? fresh : p)));
    return fresh;
  };

  // -- gestos sobre la página --------------------------------------------------------------------------------------
  const [stageW, setStageW] = useState(window.innerWidth);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages === null]);
  const scale = page ? stageW / page.width : 1;
  const drag = useRef<{ x: number; y: number; box: BBox } | null>(null);
  const pageXY = (t: React.Touch): [number, number] => {
    const r = stageRef.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(page!.width, (t.clientX - r.left) / scale)), Math.max(0, Math.min(page!.height, (t.clientY - r.top) / scale))];
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (!page) return;
    if (mode === 'move' && region) drag.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, box: region.layout_box };
    if (mode === 'draw') { const [x, y] = pageXY(e.touches[0]); setDraft([x, y, x, y]); }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!page) return;
    if (mode === 'move' && region && drag.current) {
      const dx = (e.touches[0].clientX - drag.current.x) / scale;
      const dy = (e.touches[0].clientY - drag.current.y) / scale;
      const [x1, y1, x2, y2] = drag.current.box;
      mutate(page.id, region.id, { layout_box: [x1 + dx, y1 + dy, x2 + dx, y2 + dy].map(Math.round) as BBox });
    } else if (mode === 'draw' && draft) {
      const [x, y] = pageXY(e.touches[0]);
      setDraft([draft[0], draft[1], x, y]);
    }
  };
  const onTouchEnd = async () => {
    if (mode === 'move' && region && drag.current && page) {
      const from = drag.current.box;
      const to = region.layout_box;
      const gid = page.id;
      const rid = region.id;
      history.push({ label: 'Mover texto', apply: () => mutate(gid, rid, { layout_box: to }), revert: () => mutate(gid, rid, { layout_box: from }) });
    }
    drag.current = null;
    if (mode === 'draw' && draft && page) {
      const box: BBox = [Math.min(draft[0], draft[2]), Math.min(draft[1], draft[3]), Math.max(draft[0], draft[2]), Math.max(draft[1], draft[3])].map(Math.round) as BBox;
      setDraft(null);
      setMode('select');
      if (box[2] - box[0] < 12 || box[3] - box[1] < 12) { toast('info', 'El recuadro es demasiado pequeño: dibuja uno más grande.'); return; }
      setBusy('Leyendo el texto…');
      try {
        await flush();
        const created = await engine().addRegion(id, page.id, box);
        setPages((list) => list && list.map((p) => (p.id === page.id ? { ...p, regions: [...p.regions, created] } : p)));
        setSelected(created.id);
        openSheet('region');
      } catch (e) { reportError(e, 'No se pudo añadir el texto'); }
      setBusy(null);
    }
  };

  // -- acciones con el motor ----------------------------------------------------------------------------------------
  const runJob = async (label: string, start: () => Promise<{ id: string }>, gid: string) => {
    setBusy(label);
    try {
      await flush();
      const queued = await start();
      const done = await waitForJob(queued.id);
      if (done.status === 'error') throw new Error(done.error || 'La tarea falló.');
      await refreshPage(gid);
    } catch (e) { reportError(e); }
    setBusy(null);
  };
  const retranslate = async () => {
    if (!page || !region) return;
    const before = { translation: region.translation, status: region.status, flags: region.flags, confidence: region.confidence, note: region.note };
    const gid = page.id;
    const rid = region.id;
    await runJob('Retraduciendo…', async () => { const j = await engine().translateRegions(id, gid, [rid]); useApp.getState().upsertJob(j); return j; }, gid);
    history.push({ label: 'Retraducir', apply: () => undefined, revert: () => mutate(gid, rid, before as Partial<Region>) });
  };
  const rebuild = async () => {
    if (!page) return;
    openSheet(null);
    await runJob('Reconstruyendo la página…', async () => { const j = await engine().cleanPage(id, page.id); useApp.getState().upsertJob(j); return j; }, page.id);
  };
  const retranslatePage = async () => {
    if (!page) return;
    openSheet(null);
    if (!(await confirmAction({ title: '¿Retraducir toda la página?', message: 'Se sustituyen las traducciones de esta página, también las que editaste.', confirm: 'Retraducir', danger: true }))) return;
    const ids = page.regions.map((r) => r.id);
    await runJob('Retraduciendo la página…', async () => { const j = await engine().translateRegions(id, page.id, ids); useApp.getState().upsertJob(j); return j; }, page.id);
  };
  const approvePage = async () => {
    if (!page) return;
    openSheet(null);
    try { await flush(); const fresh = await engine().approvePage(id, page.id, !page.approved); setPages((l) => l && l.map((p) => (p.id === page.id ? fresh : p))); } catch (e) { reportError(e); }
  };
  const reread = async () => {
    if (!page || !region) return;
    setBusy('Leyendo de nuevo…');
    try {
      await flush();
      const fresh = await engine().reocrRegion(id, page.id, region.id, region.bbox);
      setPages((l) => l && l.map((p) => (p.id === page.id ? { ...p, regions: p.regions.map((r) => (r.id === fresh.id ? fresh : r)) } : p)));
    } catch (e) { reportError(e, 'No se pudo leer de nuevo'); }
    setBusy(null);
  };
  const removeRegion = async () => {
    if (!page || !region) return;
    if (!(await confirmAction({ title: '¿Eliminar este texto?', message: 'Se quita de la página (el original no se modifica).', confirm: 'Eliminar', danger: true }))) return;
    try {
      await flush();
      await engine().deleteRegion(id, page.id, region.id);
      setPages((l) => l && l.map((p) => (p.id === page.id ? { ...p, regions: p.regions.filter((r) => r.id !== region.id) } : p)));
      setSelected(null);
      openSheet(null);
    } catch (e) { reportError(e); }
  };

  const goto = (i: number) => {
    if (!pages || i < 0 || i >= pages.length) return;
    tap();
    void flush();
    setSelected(null);
    setMode('select');
    setIndex(i);
  };

  if (!pages || !page) {
    return <div className="m-screen m-center">{pages && !pages.length ? <><p className="muted">Este proyecto no tiene páginas.</p><button className="btn" onClick={() => navigate(`/p/${id}`)}>Volver</button></> : <span className="spinner" />}</div>;
  }
  const autoSize = region ? layoutRegion(region, page).fontSize : 0;

  return (
    <div className="m-editor">
      <header className="m-topbar compact">
        <button className="m-icon-btn" aria-label="Volver" onClick={() => { void flush(); navigate(`/p/${id}`); }}><ArrowLeft /></button>
        <div className="m-topbar-title"><h1>Página {index + 1} de {pages.length}</h1>{page.approved && <span>Aprobada</span>}</div>
        <div className="m-topbar-side right">
          <button className="m-icon-btn" aria-label="Deshacer" disabled={!history.canUndo} onClick={() => history.undo()}><Undo2 /></button>
          <button className="m-icon-btn" aria-label="Rehacer" disabled={!history.canRedo} onClick={() => history.redo()}><Redo2 /></button>
          <button className="m-icon-btn" aria-label="Más acciones de la página" onClick={() => openSheet('page-menu')}><MoreVertical /></button>
        </div>
      </header>

      {processing && <p className="m-banner" role="status">Se está procesando el proyecto: las páginas que aún no terminaron pueden cambiar.</p>}

      <div className={`m-edit-stage ${mode}`} ref={stageRef} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={() => { void onTouchEnd(); }}>
        <div className="m-edit-sheet" style={{ height: page.height * scale }}>
          <PageCanvas projectId={id} page={page} translated className="m-page-canvas abs" />
          <svg className="m-edit-overlay" viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none">
            {page.regions.map((r, i) => {
              const [x1, y1, x2, y2] = r.layout_box;
              const sel = r.id === selected;
              return (
                <g key={r.id} onClick={() => { if (mode !== 'select') return; tap(); setSelected(r.id); openSheet('region'); }} role="button" aria-label={`Texto ${i + 1}`}>
                  <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} className={`m-ov ${sel ? 'sel' : ''} ${r.status === 'review' ? 'review' : ''} ${!regionFits(r, page) ? 'warn' : ''}`} />
                  <circle cx={x1} cy={y1} r={14 / scale} className={`m-ov-dot ${r.status}`} />
                  <text x={x1} y={y1} dy={5 / scale} textAnchor="middle" fontSize={13 / scale} className="m-ov-num">{i + 1}</text>
                </g>
              );
            })}
            {draft && <rect x={Math.min(draft[0], draft[2])} y={Math.min(draft[1], draft[3])} width={Math.abs(draft[2] - draft[0])} height={Math.abs(draft[3] - draft[1])} className="m-ov sel" />}
          </svg>
        </div>
        {mode === 'move' && <div className="m-move-hint"><Move />Arrastra para mover el texto · <button onClick={() => setMode('select')}>Listo</button></div>}
        {mode === 'draw' && <div className="m-move-hint"><PlusSquare />Dibuja un recuadro sobre el texto · <button onClick={() => { setMode('select'); setDraft(null); }}>Cancelar</button></div>}
        {busy && <div className="m-busy" role="status"><span className="spinner" />{busy}</div>}
      </div>

      <footer className="m-edit-nav">
        <button className="m-icon-btn" aria-label="Página anterior" disabled={index === 0} onClick={() => goto(index - 1)}><ChevronLeft /></button>
        <span className="small muted">Toca un globo para editarlo</span>
        <button className="m-icon-btn" aria-label="Página siguiente" disabled={index >= pages.length - 1} onClick={() => goto(index + 1)}><ChevronRight /></button>
      </footer>

      <Sheet id="page-menu" title="Esta página">
        <div className="m-menu">
          <button onClick={() => { openSheet(null); setSelected(null); setMode('draw'); }}><PlusSquare />Añadir un texto que falta</button>
          <button onClick={approvePage}><Check />{page.approved ? 'Quitar aprobación' : 'Aprobar la página'}</button>
          <button onClick={rebuild} disabled={!!busy || processing}><RefreshCw />Reconstruir el fondo tras editar</button>
          <button onClick={retranslatePage} disabled={!!busy || processing || !page.regions.length}><ScanText />Retraducir toda la página</button>
        </div>
      </Sheet>

      {region && sheet === 'region' && (
        <Sheet id="region" title={`Texto ${page.regions.indexOf(region) + 1} · ${KIND_LABELS[region.kind]}`}>
          <div className="m-stack">
            <p className="m-source" lang={sourceLang}>{region.source_text || <span className="faint">(sin texto leído)</span>}</p>
            <label className="field"><span className="label">Traducción</span>
              <textarea className="textarea m-tgt" rows={3} lang="es" value={region.translation} onChange={(e) => edit({ translation: e.target.value }, 'Editar traducción', 'tgt')} /></label>
            {!regionFits(region, page) && <p className="small text-warn">No cabe en el globo: acorta el texto o reduce el tamaño.</p>}
            {region.note && <p className="small m-note">{region.note}</p>}
            {region.review_note && <p className="small m-note">Revisión: {region.review_note}</p>}
            {region.flags.length > 0 && <div className="m-chips">{region.flags.map((f) => <span key={f} className="chip chip-review">{FLAG_LABELS[f] ?? f}</span>)}</div>}
            <div className="m-tools">
              <div className="segmented">
                <button aria-label="Reducir texto" onClick={() => edit({ style: { ...region.style, size: Math.max(6, (region.style.size ?? autoSize) - 1) } }, 'Tamaño', 'size')}><Minus /></button>
                <button aria-pressed={region.style.size === null} onClick={() => edit({ style: { ...region.style, size: null } }, 'Tamaño automático')}>{Math.round(region.style.size ?? autoSize)} px</button>
                <button aria-label="Ampliar texto" onClick={() => edit({ style: { ...region.style, size: (region.style.size ?? autoSize) + 1 } }, 'Tamaño', 'size')}><Plus /></button>
              </div>
              <div className="segmented">
                {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
                  <button key={a} aria-label={`Alinear ${a}`} aria-pressed={region.style.align === a} onClick={() => edit({ style: { ...region.style, align: a } }, 'Alineación')}><Icon /></button>
                ))}
              </div>
            </div>
            <div className="m-action-grid">
              <button className="btn" onClick={() => { openSheet(null); setMode('move'); }}><Move />Mover</button>
              {region.status !== 'approved'
                ? <button className="btn" onClick={() => edit({ status: 'approved' }, 'Aprobar')}><Check />Aprobar</button>
                : <button className="btn" onClick={() => edit({ status: 'review' }, 'Revisar')}><Flag />Revisar</button>}
              <button className="btn" disabled={!!busy || processing} onClick={retranslate}>{busy ? <span className="spinner" /> : <RefreshCw />}Retraducir</button>
              <button className="btn" onClick={() => edit({ render: !region.render }, 'Mostrar/ocultar')}>{region.render ? 'Ocultar' : 'Mostrar'}</button>
              <button className="btn" disabled={!!busy || processing} onClick={reread}><ScanText />Leer de nuevo</button>
              <button className="btn btn-danger-ghost" onClick={removeRegion}><Trash2 />Eliminar</button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
