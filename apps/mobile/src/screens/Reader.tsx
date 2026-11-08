import { ArrowLeft, Languages, PenLine } from 'lucide-react';
import type { Page } from '@starblitz/shared';
import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { PageCanvas } from '../components/images';
import { useBundle } from '../hooks';
import { tap } from '../lib/platform';
import { navigate } from '../router';

/** Zoom táctil: pellizcar para ampliar, doble toque para alternar, arrastrar para desplazarse. */
function Zoomable({ children, onZoomChange }: { children: React.ReactNode; onZoomChange: (zoomed: boolean) => void }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const g = useRef<{ d0: number; s0: number; x0: number; y0: number; px: number; py: number; lastTap: number }>({ d0: 0, s0: 1, x0: 0, y0: 0, px: 0, py: 0, lastTap: 0 });
  const apply = (n: { s: number; x: number; y: number }) => {
    const s = Math.max(1, Math.min(5, n.s));
    const clamped = s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: n.x, y: n.y };
    setT(clamped);
    onZoomChange(clamped.s > 1.01);
  };
  const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  return (
    <div className="m-zoom"
      onTouchStart={(e) => {
        if (e.touches.length === 2) Object.assign(g.current, { d0: dist(e), s0: t.s, x0: t.x, y0: t.y });
        else if (e.touches.length === 1) {
          const now = Date.now();
          if (now - g.current.lastTap < 280) {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const cx = e.touches[0].clientX - r.left - r.width / 2;
            const cy = e.touches[0].clientY - r.top - r.height / 2;
            apply(t.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: -cx * 1.5, y: -cy * 1.5 });
          }
          g.current.lastTap = now;
          Object.assign(g.current, { px: e.touches[0].clientX, py: e.touches[0].clientY, x0: t.x, y0: t.y });
        }
      }}
      onTouchMove={(e) => {
        if (e.touches.length === 2 && g.current.d0) apply({ s: g.current.s0 * (dist(e) / g.current.d0), x: g.current.x0, y: g.current.y0 });
        else if (e.touches.length === 1 && t.s > 1) apply({ s: t.s, x: g.current.x0 + e.touches[0].clientX - g.current.px, y: g.current.y0 + e.touches[0].clientY - g.current.py });
      }}
      onTouchEnd={() => { g.current.d0 = 0; }}>
      <div className="m-zoom-inner" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})` }}>{children}</div>
    </div>
  );
}

function Slide({ projectId, page, near, translated, onZoom }: { projectId: string; page: Page; near: boolean; translated: boolean; onZoom: (z: boolean) => void }) {
  return (
    <div className="m-slide" data-index={page.index}>
      {near ? <Zoomable onZoomChange={onZoom}><PageCanvas projectId={projectId} page={page} translated={translated} className="m-page-canvas" /></Zoomable> : <div className="m-slide-placeholder" />}
    </div>
  );
}

export function Reader({ id, start }: { id: string; start: number }) {
  const { bundle } = useBundle(id);
  const [index, setIndex] = useState(start);
  const [translated, setTranslated] = useState(true);
  const [chrome, setChrome] = useState(true);
  const [zoomed, setZoomed] = useState(false);
  const pager = useRef<HTMLDivElement>(null);
  const pages = bundle?.pages ?? [];
  const rtl = bundle?.project.reading_direction === 'rtl';

  useEffect(() => {
    const el = pager.current;
    if (!el || !pages.length) return;
    el.querySelector<HTMLElement>(`[data-index="${start}"]`)?.scrollIntoView({ behavior: 'instant' as ScrollBehavior, inline: 'start' });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) setIndex(Number((e.target as HTMLElement).dataset.index));
    }, { root: el, threshold: [0.6] });
    el.querySelectorAll('.m-slide').forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [pages.length, start]);

  if (!bundle) return <div className="m-reader" />;
  const page = pages[index];
  return (
    <div className="m-reader" onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setChrome((c) => !c); }}>
      <div ref={pager} className={`m-pager ${zoomed ? 'locked' : ''}`} dir={rtl ? 'rtl' : 'ltr'}>
        {pages.map((p) => <Slide key={p.id} projectId={id} page={p} near={Math.abs(p.index - index) <= 1} translated={translated} onZoom={setZoomed} />)}
      </div>
      {chrome && (
        <>
          <header className="m-reader-top">
            <button className="m-icon-btn" aria-label="Cerrar lector" onClick={() => navigate(`/p/${id}`)}><ArrowLeft /></button>
            <span className="m-reader-title">{bundle.project.name}</span>
            <button className="m-icon-btn" aria-label="Editar esta página" onClick={() => navigate(`/p/${id}/edit/${index}`)}><PenLine /></button>
          </header>
          <footer className="m-reader-bottom">
            <button className={`m-toggle ${translated ? 'on' : ''}`} onClick={() => { tap(); setTranslated((v) => !v); }} aria-pressed={translated}>
              <Languages />{translated ? 'Traducido' : 'Original'}
            </button>
            <span className="mono">{index + 1} / {pages.length}</span>
            {page && !page.has_clean && translated && <span className="small faint">Sin reconstruir</span>}
          </footer>
        </>
      )}
    </div>
  );
}
