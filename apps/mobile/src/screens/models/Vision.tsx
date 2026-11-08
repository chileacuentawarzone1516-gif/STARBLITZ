import { CheckCircle2, Download, Trash2 } from 'lucide-react';
import type { Job, VisionModel } from '@starblitz/shared';
import { useCallback, useEffect, useState } from 'react';
import { JobProgress } from '../../components/ui';
import { confirmAction, engine, isLive, reportError, useApp } from '../../state/app';

/** Detector de texto, OCR y reconstrucción: se descargan una vez (con huella SHA-256) y trabajan sin Internet. */
export function Vision() {
  const [models, setModels] = useState<VisionModel[] | null>(null);
  const jobs = useApp((s) => s.jobs);
  const installs = Object.values(jobs).filter((j) => j.kind === 'model_install');
  const doneCount = installs.filter((j) => j.status === 'done').length;
  const load = useCallback(() => engine().models().then((m) => setModels(m.vision)).catch(reportError), []);
  useEffect(() => { void load(); if (doneCount) void useApp.getState().refreshSystem(); }, [load, doneCount]);
  const active = (id: string): Job | undefined => installs.find((j) => j.title.endsWith(id) && isLive(j));
  if (!models) return <div className="m-center"><span className="spinner" /></div>;
  return (
    <div className="m-stack">
      <p className="muted small">Detectan el texto de cada página, lo leen y reconstruyen el dibujo bajo el texto original. Funcionan sin Internet una vez descargados. El OCR multilingüe PP-OCR ya viene incluido en la app.</p>
      <div className="m-model-list">
        {models.map((m) => {
          const job = active(m.id);
          return (
            <article className="m-model" key={m.id}>
              <header><strong>{m.label}</strong>{m.required && <span className="chip chip-blue">Imprescindible</span>}</header>
              <p className="small muted">{m.description}</p>
              <p className="small faint">{m.approx_mb} MB · Licencia {m.license}</p>
              {job && <JobProgress job={job} compact />}
              <footer>
                {m.installed ? (
                  <>
                    <span className="chip chip-ok"><CheckCircle2 aria-hidden />Instalado</span>
                    <button className="btn btn-ghost btn-sm" aria-label={`Eliminar ${m.label}`} onClick={async () => {
                      if (await confirmAction({ title: `¿Eliminar ${m.label}?`, message: 'Podrás volver a descargarlo cuando quieras.', confirm: 'Eliminar', danger: true })) {
                        try { await engine().removeModel(m.id); await load(); void useApp.getState().refreshSystem(); } catch (e) { reportError(e); }
                      }
                    }}><Trash2 />Eliminar</button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-primary" disabled={!!job} onClick={async () => {
                    if (m.approx_mb >= 100 && !(await confirmAction({ title: `Descargar ${m.approx_mb} MB`, message: 'Usa Wi-Fi si puedes. Si se corta, continuará donde se quedó.', confirm: 'Descargar' }))) return;
                    try { useApp.getState().upsertJob(await engine().installModel(m.id)); } catch (e) { reportError(e); }
                  }}><Download />Descargar</button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
