import { Download } from 'lucide-react';
import { exportPages, formatBytes, type ExportFormat, type Page, type Project } from '@starblitz/shared';
import { useState } from 'react';
import { pageBitmap } from '../components/images';
import { Progress, Sheet } from '../components/ui';
import { clearExportCache, saveExports } from '../lib/exportFile';
import { reportError, toast, useApp } from '../state/app';

const FORMATS: ExportFormat[] = ['pdf', 'zip', 'jpg', 'png', 'webp'];

export function ExportSheet({ project, pages }: { project: Project; pages: Page[] }) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [progress, setProgress] = useState<number | null>(null);
  const openSheet = useApp((s) => s.openSheet);
  const notCleaned = pages.filter((p) => !p.has_clean && p.regions.some((r) => r.render && r.translation.trim())).length;
  const empty = pages.filter((p) => !p.regions.some((r) => r.translation.trim())).length;

  const run = async () => {
    setProgress(0);
    try {
      const files = await exportPages(pages, {
        format, imageFormat: 'jpg', quality: 0.92, baseName: project.name,
        loadBase: async (p) => (await pageBitmap(project.id, p, 'base'))!,
        onProgress: (d, t) => setProgress(d / t),
      });
      const saved = await saveExports(files, { share: true });
      toast('ok', saved[0]?.location ? `Guardado en ${saved[0].location}` : 'Exportación lista');
      openSheet(null);
      void clearExportCache();
    } catch (e) { reportError(e, 'No se pudo exportar'); }
    setProgress(null);
  };

  return (
    <Sheet id="export" title="Exportar">
      <div className="m-stack">
        <div className="m-chips" role="radiogroup" aria-label="Formato">
          {FORMATS.map((f) => <button key={f} role="radio" aria-checked={format === f} className={`m-chip ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}
        </div>
        <p className="small muted">
          {pages.length} {pages.length === 1 ? 'página' : 'páginas'} a su resolución original
          {format === 'pdf' || format === 'zip' ? ' (JPG de alta calidad dentro)' : ''}. Se guarda en Descargas/STARBLITZ y puedes compartirlo.
        </p>
        {notCleaned > 0 && <p className="small text-warn">{notCleaned} {notCleaned === 1 ? 'página tiene' : 'páginas tienen'} traducción pero el texto original aún no se ha borrado. Procesa el proyecto para reconstruir los globos.</p>}
        {empty > 0 && <p className="small muted">{empty} {empty === 1 ? 'página está' : 'páginas están'} sin traducir y se exportarán con el original.</p>}
        {progress !== null && <Progress value={progress} label="Componiendo páginas" />}
        <button className="btn btn-primary btn-lg m-block" onClick={run} disabled={progress !== null || !pages.length}><Download />Exportar {format.toUpperCase()}</button>
        <p className="small faint">Memoria disponible permitiendo, un capítulo de 50 páginas puede tardar unos minutos; no cierres la app.{pages.length > 0 && ` Tamaño estimado: ${formatBytes(pages.length * 450 * 1024)} (aprox.).`}</p>
      </div>
    </Sheet>
  );
}
