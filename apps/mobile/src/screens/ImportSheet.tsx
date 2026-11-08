import { Plus } from 'lucide-react';
import { LANGUAGES, VARIANTS, type ImportReport } from '@starblitz/shared';
import { useRef, useState } from 'react';
import { JobProgress, Sheet } from '../components/ui';
import { navigate } from '../router';
import { engine, reportError, toast, useApp, waitForJob } from '../state/app';

const SOURCES = ['auto', 'ja', 'en', 'ko', 'zh'] as const;

function summarize(r: ImportReport): string {
  const extra = [r.errors.length && `${r.errors.length} con errores`, r.duplicates.length && `${r.duplicates.length} repetidas omitidas`, r.skipped_limit && `${r.skipped_limit} sobre el límite de ${r.limit}`]
    .filter(Boolean).join(', ');
  return `${r.added.length} páginas importadas${extra ? ` (${extra})` : ''}.`;
}

/** Nuevo proyecto (o añadir páginas a uno existente): ZIP/CBZ, PDF, JPG, PNG o WEBP, hasta el límite de páginas de los ajustes. */
export function ImportSheet({ sheetId = 'import', projectId, onDone }: { sheetId?: string; projectId?: string; onDone?: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [lang, setLang] = useState<(typeof SOURCES)[number]>('auto');
  const [variant, setVariant] = useState('es-419');
  const [auto, setAuto] = useState(true); // por defecto se traduce todo el proyecto al terminar de importar (se puede desmarcar)
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const openSheet = useApp((s) => s.openSheet);
  const job = useApp((s) => (jobId ? s.jobs[jobId] : undefined));

  const pick = (list: FileList | null) => {
    const arr = Array.from(list ?? []);
    setFiles(arr);
    if (arr[0] && !name && !projectId) setName(arr[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 80));
  };

  const run = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      const eng = engine();
      const pid = projectId ?? (await eng.createProject({ name: name.trim() || 'Nuevo capítulo', source_lang: lang, target_variant: variant })).id;
      const queued = await eng.importFiles(pid, files.map((f) => ({ name: f.name, blob: f })));
      setJobId(queued.id);
      useApp.getState().upsertJob(queued);
      const done = await waitForJob(queued.id);
      if (done.status === 'cancelled') { toast('info', 'Importación cancelada.'); if (!projectId) await eng.deleteProject(pid).catch(() => undefined); return; }
      if (done.status !== 'done') throw new Error(done.error || 'No se pudo importar.');
      const report = done.result as ImportReport;
      await useApp.getState().refreshProjects();
      if (!report.added.length) {
        if (!projectId) await eng.deleteProject(pid).catch(() => undefined);
        await useApp.getState().refreshProjects();
        throw new Error(report.errors[0] ? `${report.errors[0].file}: ${report.errors[0].reason}` : 'No se encontraron imágenes.');
      }
      toast(report.errors.length || report.skipped_limit ? 'info' : 'ok', summarize(report));
      openSheet(null);
      setFiles([]); setName(''); setJobId(null);
      onDone?.();
      if (auto) {
        try { useApp.getState().upsertJob(await eng.process(pid)); } catch (e) { reportError(e, 'No se pudo iniciar la traducción'); }
      }
      navigate(`/p/${pid}`);
    } catch (e) { reportError(e); }
    setBusy(false);
    setJobId(null);
  };

  return (
    <Sheet id={sheetId} title={projectId ? 'Añadir páginas' : 'Nuevo proyecto'} onClose={() => { if (!busy) { setFiles([]); setName(''); } }}>
      <input ref={input} type="file" multiple hidden data-testid="import-input" accept=".zip,.cbz,.pdf,.jpg,.jpeg,.png,.webp,application/zip,application/pdf,image/jpeg,image/png,image/webp"
        onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
      {busy ? (
        <div className="m-stack">
          {job ? <JobProgress job={job} /> : <JobProgress job={{ id: '', kind: 'import', title: 'Preparando', project_id: null, status: 'queued', progress: 0, stage: '', message: 'Preparando…', result: null, error: '', created: 0, started: null, finished: null, eta_s: null, pausable: false, detail: {} }} compact />}
          <p className="small muted">Todo se procesa en el teléfono; las imágenes no salen de él.</p>
        </div>
      ) : (
        <div className="m-stack">
          <button className="m-file-pick" onClick={() => input.current?.click()}>
            <Plus />
            <span>{files.length ? `${files.length} archivo${files.length > 1 ? 's' : ''} seleccionado${files.length > 1 ? 's' : ''}` : 'Elegir ZIP, CBZ, PDF o imágenes'}</span>
          </button>
          {!projectId && (
            <>
              <label className="field"><span className="label">Nombre</span>
                <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Nombre del capítulo" /></label>
              <div className="field"><span className="label">Idioma original</span>
                <div className="m-chips" role="radiogroup" aria-label="Idioma original">
                  {SOURCES.map((l) => <button key={l} role="radio" aria-checked={lang === l} className={`m-chip ${lang === l ? 'on' : ''}`} onClick={() => setLang(l)}>{l === 'auto' ? 'Detectar' : LANGUAGES[l]}</button>)}
                </div></div>
              <label className="field"><span className="label">Traducir a</span>
                <select className="select" value={variant} onChange={(e) => setVariant(e.target.value)}>
                  {Object.entries(VARIANTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></label>
              <label className="m-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /><span>Traducir todo el proyecto al terminar de importar</span></label>
            </>
          )}
          <button className="btn btn-primary btn-lg m-block" disabled={!files.length} onClick={run}>{projectId ? 'Añadir' : 'Importar'}</button>
        </div>
      )}
    </Sheet>
  );
}
