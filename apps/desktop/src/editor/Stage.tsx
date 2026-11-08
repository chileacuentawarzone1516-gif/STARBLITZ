import { loadLetteringFonts, regionFits, renderPage, type BBox, type Page, type Region } from '@starblitz/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useApp } from '../store';
import { useEditor } from './useEditor';

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
interface Drag { id: string; handle: Handle; start: [number, number]; box: BBox; orig: BBox; field: 'layout_box' | 'bbox' }

function useImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) { setImg(null); return; }
    let alive = true;
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.decoding = 'async';
    el.onload = () => { if (alive) setImg(el); };
    el.src = src;
    return () => { alive = false; };
  }, [src]);
  return img;
}

let fontsReady = false;
const fontsPromise = loadLetteringFonts().then(() => { fontsReady = true; });

function toImage(svg: SVGSVGElement, e: { clientX: number; clientY: number }): [number, number] {
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return [p.x, p.y];
}

function moveBox(d: Drag, x: number, y: number, page: Page): BBox {
  const dx = x - d.start[0];
  const dy = y - d.start[1];
  let [x1, y1, x2, y2] = d.orig;
  if (d.handle === 'move') { x1 += dx; x2 += dx; y1 += dy; y2 += dy; }
  if (d.handle.includes('n')) y1 += dy;
  if (d.handle.includes('s')) y2 += dy;
  if (d.handle.includes('w')) x1 += dx;
  if (d.handle.includes('e')) x2 += dx;
  const min = 12;
  if (x2 - x1 < min) { if (d.handle.includes('w')) x1 = x2 - min; else x2 = x1 + min; }
  if (y2 - y1 < min) { if (d.handle.includes('n')) y1 = y2 - min; else y2 = y1 + min; }
  const clampX = (v: number) => Math.max(0, Math.min(page.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(page.height, v));
  return [clampX(x1), clampY(y1), clampX(x2), clampY(y2)].map(Math.round) as BBox;
}

function Overlay({ page, field, scale, drag, setDrag, draft, setDraft }: {
  page: Page; field: 'layout_box' | 'bbox'; scale: number; drag: Drag | null; setDrag: (d: Drag | null) => void;
  draft: BBox | null; setDraft: (b: BBox | null) => void;
}) {
  const { selectedId, select, tool, patchRegion, addRegion } = useEditor();
  const svgRef = useRef<SVGSVGElement>(null);
  const drawStart = useRef<[number, number] | null>(null);
  const stroke = 1.5 / scale;
  const handleSize = 9 / scale;

  const begin = (e: RPointerEvent, region: Region, handle: Handle) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    select(region.id);
    const svg = svgRef.current!;
    svg.setPointerCapture(e.pointerId);
    const box = region[field];
    setDrag({ id: region.id, handle, start: toImage(svg, e), box, orig: box, field });
  };

  const onDown = (e: RPointerEvent) => {
    if (tool === 'draw') {
      const svg = svgRef.current!;
      svg.setPointerCapture(e.pointerId);
      drawStart.current = toImage(svg, e);
      setDraft([...drawStart.current, ...drawStart.current] as BBox);
    } else {
      select(null);
    }
  };
  const onMove = (e: RPointerEvent) => {
    const svg = svgRef.current!;
    const [x, y] = toImage(svg, e);
    if (drag) setDrag({ ...drag, box: moveBox(drag, x, y, page) });
    else if (drawStart.current) {
      const [sx, sy] = drawStart.current;
      setDraft([Math.min(sx, x), Math.min(sy, y), Math.max(sx, x), Math.max(sy, y)].map(Math.round) as BBox);
    }
  };
  const onUp = () => {
    if (drag) {
      const changed = drag.box.some((v, i) => v !== drag.orig[i]);
      if (changed) patchRegion(drag.id, { [drag.field]: drag.box }, drag.field === 'bbox' ? 'Mover área original' : 'Mover texto');
      setDrag(null);
    } else if (drawStart.current && draft) {
      drawStart.current = null;
      if (draft[2] - draft[0] > 12 && draft[3] - draft[1] > 12) addRegion(draft).finally(() => setDraft(null));
      else setDraft(null);
    }
  };

  return (
    <svg ref={svgRef} className={`overlay tool-${tool}`} viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {page.regions.map((r, i) => {
        const box = drag?.id === r.id ? drag.box : r[field];
        const [x1, y1, x2, y2] = box;
        const sel = r.id === selectedId;
        const warn = field === 'layout_box' && !regionFits(r, page);
        const cls = `ov-box ${sel ? 'sel' : ''} ${r.status === 'review' ? 'review' : ''} ${warn ? 'warn' : ''} ${!r.render ? 'hidden-text' : ''}`;
        return (
          <g key={r.id}>
            <rect className={cls} x={x1} y={y1} width={x2 - x1} height={y2 - y1} strokeWidth={stroke * (sel ? 1.6 : 1)}
              onPointerDown={(e) => begin(e, r, 'move')} />
            <g className="ov-badge" transform={`translate(${x1} ${y1}) scale(${1 / scale})`} onPointerDown={(e) => begin(e, r, 'move')}>
              <circle r={11} className={sel ? 'sel' : r.status === 'review' ? 'review' : ''} />
              <text textAnchor="middle" dy="4">{i + 1}</text>
            </g>
            {sel && tool === 'select' && (['nw', 'ne', 'sw', 'se'] as Handle[]).map((h) => (
              <rect key={h} className={`ov-handle h-${h}`} width={handleSize} height={handleSize}
                x={(h.includes('w') ? x1 : x2) - handleSize / 2} y={(h.includes('n') ? y1 : y2) - handleSize / 2}
                onPointerDown={(e) => begin(e, r, h)} />
            ))}
          </g>
        );
      })}
      {draft && <rect className="ov-draft" x={draft[0]} y={draft[1]} width={draft[2] - draft[0]} height={draft[3] - draft[1]} strokeWidth={stroke * 1.5} />}
    </svg>
  );
}

function TranslatedCanvas({ page, base, drag }: { page: Page; base: HTMLImageElement | null; drag: Drag | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(fontsReady);
  useEffect(() => { if (!fontsReady) fontsPromise.then(() => setReady(true)); }, []);
  const view = useMemo<Page>(() => (drag && drag.field === 'layout_box'
    ? { ...page, regions: page.regions.map((r) => (r.id === drag.id ? { ...r, layout_box: drag.box } : r)) } : page), [page, drag]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !base || !ready) return;
    const raf = requestAnimationFrame(() => {
      const ctx = c.getContext('2d');
      if (ctx) renderPage(ctx, base, view);
    });
    return () => cancelAnimationFrame(raf);
  }, [view, base, ready]);
  return <canvas ref={canvas} width={page.width} height={page.height} className="sheet-layer" aria-label={`Página ${page.index + 1} traducida`} />;
}

function Sheet({ page, scale, children, label }: { page: Page; scale: number; children: React.ReactNode; label?: string }) {
  return (
    <div className="sheet" style={{ width: page.width * scale, height: page.height * scale }}>
      {label && <span className="sheet-label">{label}</span>}
      {children}
    </div>
  );
}

export function Stage() {
  const { project, pages, pageIndex, view, zoom, setZoom } = useEditor();
  const api = useApp((s) => s.client);
  const page = pages[pageIndex];
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<BBox | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const baseUrl = page && api && project ? api.imageUrl(project.id, page.id, page.has_clean ? 'clean' : 'original', page.updated) : null;
  const origUrl = page && api && project ? api.imageUrl(project.id, page.id, 'original') : null;
  const base = useImage(view === 'original' ? null : baseUrl);

  const panes = view === 'compare' ? 2 : 1;
  const fit = page ? Math.min((size.w - 48 - (panes - 1) * 24) / panes / page.width, (size.h - 48) / page.height) : 1;
  const scale = zoom || Math.max(0.05, fit);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, [scale, setZoom]);

  if (!page) return <div className="stage empty-stage"><p className="muted">Este proyecto no tiene páginas.</p></div>;

  return (
    <div className={`stage view-${view}`} ref={wrap} onWheel={onWheel}>
      <div className="stage-inner">
        {(view === 'original' || view === 'compare') && (
          <Sheet page={page} scale={scale} label={view === 'compare' ? 'Original' : undefined}>
            {origUrl && <img src={origUrl} className="sheet-layer" alt={`Página ${page.index + 1} original`} draggable={false} />}
            {view === 'original' && <Overlay page={page} field="bbox" scale={scale} drag={drag} setDrag={setDrag} draft={draft} setDraft={setDraft} />}
          </Sheet>
        )}
        {(view === 'translated' || view === 'compare') && (
          <Sheet page={page} scale={scale} label={view === 'compare' ? 'Traducido' : undefined}>
            {!base && <div className="sheet-loading"><span className="spinner" /></div>}
            <TranslatedCanvas page={page} base={base} drag={drag} />
            <Overlay page={page} field="layout_box" scale={scale} drag={drag} setDrag={setDrag} draft={draft} setDraft={setDraft} />
          </Sheet>
        )}
      </div>
    </div>
  );
}
