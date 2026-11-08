import { Download, FileArchive, FileImage, FileText } from 'lucide-react';
import { exportPages, loadLetteringFonts, type ExportFormat, type ImageFormat, type Page, type Project } from '@starblitz/shared';
import { useRef, useState } from 'react';
import { saveFiles } from '../bridge';
import { client, reportError, useApp } from '../store';
import { Dialog } from './Dialog';

const FORMATS: { id: ExportFormat; label: string; hint: string; icon: typeof FileText }[] = [
  { id: 'pdf', label: 'PDF', hint: 'Un único documento para leer', icon: FileText },
  { id: 'zip', label: 'ZIP', hint: 'Páginas numeradas comprimidas', icon: FileArchive },
  { id: 'jpg', label: 'JPG', hint: 'Imágenes sueltas', icon: FileImage },
  { id: 'png', label: 'PNG', hint: 'Imágenes sin pérdida', icon: FileImage },
  { id: 'webp', label: 'WEBP', hint: 'Imágenes ligeras', icon: FileImage },
];

export async function loadPageBase(projectId: string, page: Page): Promise<ImageBitmap> {
  const c = client();
  const url = c.imageUrl(projectId, page.id, page.has_clean ? 'clean' : 'original', page.updated);
  return createImageBitmap(await c.fetchBlob(url));
}

export function ExportDialog({ project, pages, currentPageId, onClose }:
  { project: Project; pages: Page[]; currentPageId?: string; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [inner, setInner] = useState<ImageFormat>('jpg');
  const [quality, setQuality] = useState(92);
  const [range, setRange] = useState<'all' | 'approved' | 'current'>('all');
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const selected = range === 'approved' ? pages.filter((p) => p.approved)
    : range === 'current' ? pages.filter((p) => p.id === currentPageId) : pages;
  const notReady = selected.filter((p) => !p.has_clean).length;

  const run = async () => {
    abort.current = new AbortController();
    setProgress(0);
    try {
      await loadLetteringFonts();
      const files = await exportPages(selected, {
        format, imageFormat: inner, quality: quality / 100, baseName: project.name,
        loadBase: (p) => loadPageBase(project.id, p),
        onProgress: (d, t) => setProgress(d / t),
        signal: abort.current.signal,
      });
      const saved = await saveFiles(files, format.toUpperCase());
      if (saved) useApp.getState().toast('ok', 'Exportación guardada', `${saved} archivo${saved > 1 ? 's' : ''} guardado${saved > 1 ? 's' : ''}.`);
      onClose();
    } catch (e) {
      if ((e as Error).name !== 'AbortError') reportError(e, 'No se pudo exportar');
      setProgress(null);
    }
  };

  const busy = progress !== null;
  return (
    <Dialog title="Exportar traducción" onClose={() => { abort.current?.abort(); onClose(); }} wide busy={busy}
      description="Se conserva la resolución original de cada página y el orden del proyecto."
      actions={<>
        <button className="btn btn-ghost" onClick={() => { abort.current?.abort(); onClose(); }}>{busy ? 'Cancelar' : 'Cerrar'}</button>
        <button className="btn btn-primary" data-autofocus disabled={busy || !selected.length} onClick={run}>
          <Download />Exportar {selected.length} página{selected.length === 1 ? '' : 's'}
        </button>
      </>}>
      <div className="export-formats" role="radiogroup" aria-label="Formato">
        {FORMATS.map((f) => (
          <button key={f.id} role="radio" aria-checked={format === f.id} className={`format-tile ${format === f.id ? 'on' : ''}`}
            onClick={() => setFormat(f.id)} disabled={busy}>
            <f.icon aria-hidden />
            <strong>{f.label}</strong>
            <span className="small muted">{f.hint}</span>
          </button>
        ))}
      </div>
      <div className="form-grid" style={{ marginTop: 18 }}>
        <div className="field">
          <label htmlFor="ex-range">Páginas</label>
          <select id="ex-range" className="select" value={range} onChange={(e) => setRange(e.target.value as typeof range)} disabled={busy}>
            <option value="all">Todas ({pages.length})</option>
            <option value="approved">Solo aprobadas ({pages.filter((p) => p.approved).length})</option>
            {currentPageId && <option value="current">Solo la página actual</option>}
          </select>
        </div>
        {(format === 'pdf' || format === 'zip') && (
          <div className="field">
            <label htmlFor="ex-inner">Imágenes dentro del {format.toUpperCase()}</label>
            <select id="ex-inner" className="select" value={inner} onChange={(e) => setInner(e.target.value as ImageFormat)} disabled={busy}>
              <option value="jpg">JPG (recomendado)</option>
              <option value="png">PNG (sin pérdida, más pesado)</option>
            </select>
          </div>
        )}
        {(format === 'jpg' || format === 'webp' || ((format === 'pdf' || format === 'zip') && inner === 'jpg')) && (
          <div className="field">
            <label htmlFor="ex-q">Calidad: {quality}</label>
            <input id="ex-q" type="range" min={70} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} disabled={busy} />
          </div>
        )}
      </div>
      {notReady > 0 && (
        <p className="hint" style={{ marginTop: 12 }}>
          {notReady} página{notReady > 1 ? 's' : ''} aún no {notReady > 1 ? 'están reconstruidas' : 'está reconstruida'}: se exportará con la imagen original.
        </p>
      )}
      {busy && (
        <div style={{ marginTop: 16 }}>
          <div className="progress"><i style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} /></div>
          <p className="small muted" style={{ marginTop: 6 }}>Componiendo páginas… {Math.round((progress ?? 0) * 100)} %</p>
        </div>
      )}
    </Dialog>
  );
}
