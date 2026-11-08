import {
  AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, Check, EyeOff, Eraser, Flag, Italic, Languages, RefreshCw, ScanText, Trash2, Wand2,
} from 'lucide-react';
import {
  FLAG_LABELS, FONT_ROLE_LABELS, KIND_LABELS, layoutRegion, regionFits, STATUS_LABELS, type FontRole, type Region, type RegionKind,
  type TextStyle,
} from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import { confirmAction } from '../components/Dialog';
import { client, reportError, useApp } from '../store';
import { flushPending, useEditor } from './useEditor';

function RegionList() {
  const { pages, pageIndex, selectedId, select } = useEditor();
  const page = pages[pageIndex];
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  if (!page) return null;
  if (!page.regions.length) {
    return <p className="muted small inspector-empty">No se detectó texto en esta página. Usa «Nuevo texto» y dibuja un recuadro sobre el globo.</p>;
  }
  return (
    <ol className="region-list" ref={listRef} role="listbox" aria-label="Textos de la página">
      {page.regions.map((r, i) => (
        <li key={r.id} role="option" aria-selected={r.id === selectedId} className={`region-item ${r.id === selectedId ? 'sel' : ''}`}
          onClick={() => select(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && select(r.id)}>
          <span className={`region-num ${r.status}`}>{i + 1}</span>
          <div className="region-text">
            <span className="src">{r.source_text || '—'}</span>
            <span className="tgt">{r.translation || <em className="faint">Sin traducir</em>}</span>
          </div>
          {r.status === 'review' && <Flag className="flag-icon" aria-label="Revisar" />}
          {!regionFits(r, page) && <span className="chip chip-warn" title="No cabe con el tamaño mínimo">Largo</span>}
        </li>
      ))}
    </ol>
  );
}

function StylePanel({ region }: { region: Region }) {
  const patchRegion = useEditor((s) => s.patchRegion);
  const page = useEditor((s) => s.pages[s.pageIndex]);
  const s = region.style;
  const setStyle = (patch: Partial<TextStyle>, label = 'Cambiar estilo', key?: string) =>
    patchRegion(region.id, { style: { ...s, ...patch } }, label, key);
  const autoSize = page ? layoutRegion(region, page).fontSize : 16;

  return (
    <div className="style-panel">
      <div className="row">
        <select className="select" aria-label="Tipo de letra" value={s.font} onChange={(e) => setStyle({ font: e.target.value as FontRole }, 'Cambiar tipografía')}>
          {Object.entries(FONT_ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <div className="segmented" role="group" aria-label="Alineación">
          {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
            <button key={a} aria-pressed={s.align === a} aria-label={`Alinear ${a === 'left' ? 'a la izquierda' : a === 'right' ? 'a la derecha' : 'al centro'}`}
              onClick={() => setStyle({ align: a }, 'Cambiar alineación')}><Icon /></button>
          ))}
        </div>
      </div>
      <div className="row">
        <div className="segmented" role="group" aria-label="Formato">
          <button aria-pressed={s.bold} aria-label="Negrita" onClick={() => setStyle({ bold: !s.bold })}><Bold /></button>
          <button aria-pressed={s.italic} aria-label="Cursiva" onClick={() => setStyle({ italic: !s.italic })}><Italic /></button>
          <button aria-pressed={s.uppercase} aria-label="Mayúsculas" onClick={() => setStyle({ uppercase: !s.uppercase })}><CaseUpper /></button>
        </div>
        <label className="color-field" title="Color del texto">
          <input type="color" value={s.color} onChange={(e) => setStyle({ color: e.target.value }, 'Cambiar color', 'color')} aria-label="Color del texto" />
        </label>
        <label className="color-field" title="Color del contorno">
          <input type="color" value={s.stroke_color} onChange={(e) => setStyle({ stroke_color: e.target.value }, 'Cambiar contorno', 'scolor')} aria-label="Color del contorno" />
        </label>
      </div>
      <div className="slider-row">
        <label className="check"><input type="checkbox" checked={s.size === null} onChange={(e) => setStyle({ size: e.target.checked ? null : Math.round(autoSize) }, 'Tamaño automático')} /><span>Tamaño automático</span></label>
        <span className="mono small muted">{Math.round(s.size ?? autoSize)} px</span>
      </div>
      {s.size !== null && (
        <input type="range" min={6} max={Math.max(80, Math.round((page?.height ?? 1600) * 0.06))} step={0.5} value={s.size}
          aria-label="Tamaño de letra" onChange={(e) => setStyle({ size: +e.target.value }, 'Cambiar tamaño', 'size')} />
      )}
      <div className="slider-row"><span className="small">Contorno</span><span className="mono small muted">{s.stroke_width} px</span></div>
      <input type="range" min={0} max={16} step={0.5} value={s.stroke_width} aria-label="Grosor del contorno"
        onChange={(e) => setStyle({ stroke_width: +e.target.value }, 'Cambiar contorno', 'stroke')} />
      <div className="slider-row"><span className="small">Interlineado</span><span className="mono small muted">{s.line_height.toFixed(2)}</span></div>
      <input type="range" min={0.8} max={1.8} step={0.02} value={s.line_height} aria-label="Interlineado"
        onChange={(e) => setStyle({ line_height: +e.target.value }, 'Cambiar interlineado', 'lh')} />
      <div className="slider-row"><span className="small">Rotación</span><span className="mono small muted">{s.rotation}°</span></div>
      <input type="range" min={-45} max={45} step={1} value={s.rotation} aria-label="Rotación"
        onChange={(e) => setStyle({ rotation: +e.target.value }, 'Rotar texto', 'rot')} />
    </div>
  );
}

function RegionDetail({ region, index }: { region: Region; index: number }) {
  const { patchRegion, deleteRegion, reocr, project, pages, pageIndex, replacePage } = useEditor();
  const page = pages[pageIndex];
  const [busy, setBusy] = useState<'' | 'translate' | 'ocr'>('');
  const fits = page ? regionFits(region, page) : true;
  const count = region.translation.length;

  const retranslate = async () => {
    if (!project || !page) return;
    setBusy('translate');
    try {
      await flushPending();
      const job = await client().translateRegions(project.id, page.id, [region.id]);
      const done = await client().waitJob(job.id, undefined, 600);
      if (done.status !== 'done') throw new Error(done.error || 'No se pudo retraducir.');
      replacePage(await client().page(project.id, page.id));
    } catch (e) { reportError(e, 'No se pudo retraducir'); }
    setBusy('');
  };

  return (
    <div className="region-detail">
      <div className="detail-head">
        <h3>Texto {index + 1}</h3>
        <select className="select select-sm" aria-label="Tipo de texto" value={region.kind}
          onChange={(e) => patchRegion(region.id, { kind: e.target.value as RegionKind }, 'Cambiar tipo')}>
          {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className={`chip ${region.status === 'review' ? 'chip-review' : region.status === 'approved' ? 'chip-ok' : ''}`}>{STATUS_LABELS[region.status]}</span>
      </div>

      <div className="field">
        <div className="label-row">
          <label htmlFor="src-text" className="label">Original</label>
          <button className="btn btn-ghost btn-sm" onClick={async () => { setBusy('ocr'); await reocr(region.id); setBusy(''); }} disabled={!!busy}
            title="Vuelve a leer el texto del área original">
            {busy === 'ocr' ? <span className="spinner" /> : <ScanText />}Reconocer de nuevo
          </button>
        </div>
        <textarea id="src-text" className="textarea src-area" rows={2} value={region.source_text} lang={project?.source_lang}
          onChange={(e) => patchRegion(region.id, { source_text: e.target.value }, 'Corregir OCR', 'src')} />
        {region.ocr_fix && region.ocr_fix !== region.source_text && (
          <div className="suggestion">
            <span className="small">Lectura sugerida: <strong>{region.ocr_fix}</strong></span>
            <button className="btn btn-sm" onClick={() => patchRegion(region.id, { source_text: region.ocr_fix, flags: region.flags.filter((f) => f !== 'ocr_suspect') }, 'Aplicar lectura sugerida')}>Aplicar</button>
          </div>
        )}
      </div>

      <div className="field">
        <div className="label-row">
          <label htmlFor="tgt-text" className="label">Traducción</label>
          <span className={`small mono ${region.max_chars && count > region.max_chars ? 'text-warn' : 'muted'}`}>{count}{region.max_chars ? ` / ~${region.max_chars}` : ''}</span>
        </div>
        <textarea id="tgt-text" className="textarea tgt-area" rows={4} value={region.translation} lang="es" spellCheck
          onChange={(e) => patchRegion(region.id, { translation: e.target.value }, 'Editar traducción', 'tgt')} />
        {!fits && <p className="small text-warn">No cabe con el tamaño mínimo legible: acorta el texto o amplía el recuadro.</p>}
      </div>

      {(region.speaker || region.emotion || region.confidence !== null) && (
        <dl className="meta-grid">
          {region.speaker && (<><dt>Habla</dt><dd>{region.speaker}</dd></>)}
          {region.emotion && (<><dt>Emoción</dt><dd>{region.emotion}</dd></>)}
          {region.confidence !== null && (<><dt>Confianza</dt><dd><span className="confidence"><i style={{ width: `${Math.round((region.confidence ?? 0) * 100)}%` }} /></span> {Math.round((region.confidence ?? 0) * 100)} %</dd></>)}
        </dl>
      )}
      {region.flags.length > 0 && (
        <div className="flags">{region.flags.map((f) => <span key={f} className={`chip ${f === 'ocr_suspect' || f === 'ambiguous' ? 'chip-review' : 'chip-blue'}`}>{FLAG_LABELS[f] ?? f}</span>)}</div>
      )}
      {region.note && <p className="note"><Wand2 aria-hidden /><span>{region.note}</span></p>}
      {region.review_note && <p className="note subtle"><Languages aria-hidden /><span>Revisión editorial: {region.review_note}</span></p>}

      <div className="detail-actions">
        <button className="btn btn-sm" onClick={retranslate} disabled={!!busy}>
          {busy === 'translate' ? <span className="spinner" /> : <RefreshCw />}Retraducir
        </button>
        {region.status !== 'approved'
          ? <button className="btn btn-sm" onClick={() => patchRegion(region.id, { status: 'approved' }, 'Aprobar texto')}><Check />Aprobar</button>
          : <button className="btn btn-sm" onClick={() => patchRegion(region.id, { status: 'review' }, 'Marcar para revisar')}><Flag />Revisar</button>}
      </div>
      <div className="toggle-row compact">
        <span className="small"><EyeOff aria-hidden />Rotular la traducción</span>
        <label className="switch"><input type="checkbox" checked={region.render} onChange={(e) => patchRegion(region.id, { render: e.target.checked }, 'Mostrar/ocultar traducción')} aria-label="Rotular la traducción" /><span /></label>
      </div>
      <div className="toggle-row compact">
        <span className="small"><Eraser aria-hidden />Borrar el texto original</span>
        <label className="switch"><input type="checkbox" checked={region.erase} onChange={(e) => patchRegion(region.id, { erase: e.target.checked }, 'Cambiar borrado')} aria-label="Borrar el texto original" /><span /></label>
      </div>

      <details className="style-details" open>
        <summary>Tipografía y posición</summary>
        <StylePanel region={region} />
      </details>

      <button className="btn btn-danger btn-sm delete-region" onClick={async () => {
        if (await confirmAction({ title: `¿Eliminar el texto ${index + 1}?`, message: 'Podrás recuperarlo con Deshacer.', confirm: 'Eliminar', danger: true })) deleteRegion(region.id);
      }}><Trash2 />Eliminar texto</button>
    </div>
  );
}

export function Inspector() {
  const { pages, pageIndex, selectedId } = useEditor();
  const page = pages[pageIndex];
  const idx = page?.regions.findIndex((r) => r.id === selectedId) ?? -1;
  const region = idx >= 0 ? page!.regions[idx] : null;
  const translated = page?.regions.filter((r) => r.translation.trim()).length ?? 0;
  const connected = useApp((s) => s.connected);
  return (
    <aside className="inspector" aria-label="Inspector de textos">
      <div className="inspector-head">
        <strong>Textos</strong>
        <span className="small muted mono">{translated}/{page?.regions.length ?? 0}</span>
        {!connected && <span className="chip chip-warn">Sin conexión</span>}
      </div>
      <RegionList />
      {region && <RegionDetail key={region.id} region={region} index={idx} />}
    </aside>
  );
}
