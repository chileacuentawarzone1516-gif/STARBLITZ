import { CheckCircle2, Download, Trash2 } from 'lucide-react';
import type { Job, VisionModel } from '@starblitz/shared';
import { useCallback, useEffect, useState } from 'react';
import { confirmAction } from '../../components/Dialog';
import { JobProgress } from '../../components/Jobs';
import { client, isLive, reportError, useApp } from '../../store';

/** Modelos de visión (detector de texto, OCR, reconstrucción): se descargan una vez y trabajan sin Internet. */
export function Vision() {
  const [models, setModels] = useState<VisionModel[] | null>(null);
  const jobs = useApp((s) => s.jobs);
  const installs = Object.values(jobs).filter((j) => j.kind === 'model_install');
  const doneCount = installs.filter((j) => j.status === 'done').length;
  const load = useCallback(() => client().models().then((m) => setModels(m.vision)).catch(reportError), []);
  useEffect(() => { load(); if (doneCount) useApp.getState().refreshSystem(); }, [load, doneCount]);
  const active = (id: string): Job | undefined => installs.find((j) => j.title.endsWith(id) && isLive(j));
  if (!models) return <div className="spinner" />;
  return (
    <section className="settings-section">
      <h2>Visión y OCR</h2>
      <p className="muted">Detectan el texto de cada página, lo leen y reconstruyen el dibujo bajo el texto original. Funcionan sin Internet una vez descargados.</p>
      <div className="model-list">
        {models.map((m) => {
          const job = active(m.id);
          return (
            <div className="model-row" key={m.id}>
              <div className="model-info">
                <strong>{m.label} {m.required && <span className="chip chip-blue">Imprescindible</span>}</strong>
                <span className="small muted">{m.description}</span>
                <span className="small faint">{m.approx_mb} MB · Licencia {m.license}</span>
                {job && <JobProgress job={job} compact />}
              </div>
              <div className="model-actions">
                {m.installed ? (
                  <>
                    <span className="chip chip-ok"><CheckCircle2 aria-hidden />Instalado</span>
                    <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Eliminar ${m.label}`} onClick={async () => {
                      if (await confirmAction({ title: `¿Eliminar ${m.label}?`, message: 'Podrás volver a descargarlo cuando quieras.', confirm: 'Eliminar', danger: true })) {
                        try { await client().removeModel(m.id); load(); } catch (e) { reportError(e); }
                      }
                    }}><Trash2 /></button>
                  </>
                ) : (
                  <button className="btn btn-sm" disabled={!!job} onClick={async () => {
                    try { useApp.getState().upsertJob(await client().installModel(m.id)); } catch (e) { reportError(e); }
                  }}><Download />Descargar</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
