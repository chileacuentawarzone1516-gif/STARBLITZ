import { FileWarning, UploadCloud } from 'lucide-react';
import { ACCEPTED_FILES, LANGUAGES, VARIANTS, type ImportReport, type Job } from '@starblitz/shared';
import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { navigate } from '../router';
import { client, reportError, useApp } from '../store';
import { Dialog } from './Dialog';
import { JobProgress } from './Jobs';

const ACCEPT_RE = /\.(zip|cbz|pdf|jpe?g|png|webp)$/i;

interface FlowState {
  files: File[] | null;
  projectId: string | null; // null = proyecto nuevo
  job: Job | null;
  report: ImportReport | null;
  start(files: File[], projectId?: string | null): void;
  set(p: Partial<FlowState>): void;
}

export const useImportFlow = create<FlowState>((set) => ({
  files: null,
  projectId: null,
  job: null,
  report: null,
  start: (files, projectId = null) => {
    const ok = files.filter((f) => ACCEPT_RE.test(f.name));
    if (!ok.length) {
      useApp.getState().toast('error', 'Formato no admitido', 'Usa ZIP, CBZ, PDF, JPG, PNG o WEBP.');
      return;
    }
    set({ files: ok, projectId, job: null, report: null });
  },
  set: (p) => set(p),
}));

function suggestName(files: File[]): string {
  const first = files[0]?.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() ?? '';
  return (files.length === 1 || /^\d+$/.test(first) === false ? first : 'Nuevo capítulo').slice(0, 80) || 'Nuevo capítulo';
}

/** Zona de arrastre reutilizable (también abre el selector de archivos al pulsarla). */
export function DropZone({ onFiles, children, className = '' }: { onFiles: (f: File[]) => void; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFiles(Array.from(e.dataTransfer.files));
  };
  return (
    <div className={`dropzone ${over ? 'over' : ''} ${className}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      {children}
      <span className="dropzone-streaks" aria-hidden />
    </div>
  );
}

export function pickFiles(onFiles: (f: File[]) => void) {
  const el = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: ACCEPTED_FILES });
  el.onchange = () => onFiles(Array.from(el.files ?? []));
  el.click();
}

/** Diálogos del flujo de importación: datos del proyecto → progreso → informe. */
export function ImportFlowHost() {
  const { files, projectId, job, report, set } = useImportFlow();
  const system = useApp((s) => s.system);
  const [name, setName] = useState('');
  const [lang, setLang] = useState('auto');
  const [variant, setVariant] = useState('es-419');
  const [processNow, setProcessNow] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (files) setName(suggestName(files));
  }, [files]);

  const close = () => set({ files: null, job: null, report: null, projectId: null });

  const run = async () => {
    if (!files) return;
    setBusy(true);
    try {
      const c = client();
      let pid = projectId;
      if (!pid) {
        const p = await c.createProject({ name: name.trim() || 'Nuevo capítulo', source_lang: lang, target_variant: variant });
        pid = p.id;
        set({ projectId: pid });
      }
      const started = await c.importFiles(pid, files);
      const finished = await c.waitJob(started.id, (j) => set({ job: j }), 400);
      if (finished.status !== 'done') throw new Error(finished.error || 'La importación no se completó.');
      const rep = finished.result as ImportReport;
      useApp.getState().refreshProjects();
      if (processNow && rep.added.length) {
        try { useApp.getState().upsertJob(await c.process(pid)); } catch (e) { reportError(e, 'No se pudo iniciar el procesamiento'); }
      }
      if (rep.errors.length || rep.duplicates.length || rep.skipped_limit) {
        set({ report: rep, job: null });
      } else {
        useApp.getState().toast('ok', 'Importación completada', `${rep.added.length} páginas añadidas.`);
        close();
      }
      navigate(`/project/${pid}`);
    } catch (e) {
      reportError(e, 'No se pudo importar');
      set({ job: null });
    } finally {
      setBusy(false);
    }
  };

  if (report) {
    return (
      <Dialog title="Resultado de la importación" onClose={close} wide
        description={`${report.added.length} páginas añadidas.`}
        actions={<button className="btn btn-primary" data-autofocus onClick={close}>Entendido</button>}>
        <div className="report">
          {report.skipped_limit > 0 && (
            <p className="report-line warn"><FileWarning />Se omitieron {report.skipped_limit} páginas: el límite por proyecto es de {report.limit}. Puedes ampliarlo en Configuración → Procesamiento.</p>
          )}
          {report.duplicates.map((d, i) => (
            <p key={`d${i}`} className="report-line"><FileWarning />
              <span><strong>{d.file}</strong>: {d.exact ? 'duplicado exacto de una página existente; no se añadió.' : 'muy parecida a otra página; se añadió marcada como posible duplicado.'}</span>
            </p>
          ))}
          {report.errors.map((e, i) => (
            <p key={`e${i}`} className="report-line error"><FileWarning /><span><strong>{e.file}</strong>: {e.reason}.</span></p>
          ))}
        </div>
      </Dialog>
    );
  }

  if (!files) return null;

  if (job || busy) {
    return (
      <Dialog title="Importando archivos" busy onClose={() => undefined}
        description="Descomprimiendo, extrayendo páginas y detectando duplicados.">
        {job ? <JobProgress job={job} /> : <div className="progress indeterminate"><i /></div>}
      </Dialog>
    );
  }

  const total = files.reduce((n, f) => n + f.size, 0);
  return (
    <Dialog title={projectId ? 'Añadir páginas' : 'Nuevo proyecto'} onClose={close}
      description={`${files.length} archivo${files.length > 1 ? 's' : ''} · ${(total / 1048576).toFixed(1)} MB`}
      actions={<>
        <button className="btn btn-ghost" onClick={close}>Cancelar</button>
        <button className="btn btn-primary" data-autofocus onClick={run}><UploadCloud />Importar</button>
      </>}>
      <div className="form-grid">
        {!projectId && (
          <>
            <div className="field span-2">
              <label htmlFor="np-name">Nombre del proyecto</label>
              <input id="np-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="np-lang">Idioma original</label>
              <select id="np-lang" className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
                {Object.entries(system?.languages ?? LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="np-variant">Traducir a</label>
              <select id="np-variant" className="select" value={variant} onChange={(e) => setVariant(e.target.value)}>
                {Object.entries(VARIANTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </>
        )}
        <label className="check span-2">
          <input type="checkbox" checked={processNow} onChange={(e) => setProcessNow(e.target.checked)} />
          <span>Analizar, traducir y reconstruir al terminar la importación</span>
        </label>
        <ul className="file-list span-2">
          {files.slice(0, 6).map((f) => <li key={f.name + f.size}>{f.name}</li>)}
          {files.length > 6 && <li className="muted">y {files.length - 6} más…</li>}
        </ul>
      </div>
    </Dialog>
  );
}
