import { Brain, CheckCircle2, Cpu, FileDown, ScanText, Sparkles, UploadCloud, XCircle } from 'lucide-react';
import { formatBytes, formatRelative, LANGUAGES, TIER_LABELS } from '@starblitz/shared';
import { DropZone, pickFiles, useImportFlow } from '../components/ImportFlow';
import { useLLM } from '../hooks';
import { navigate } from '../router';
import { client, isLive, reportError, useApp } from '../store';
import { startInstall } from './models/install';

/** Qué necesita ESTE dispositivo para traducir sin Internet: según su perfil (OCR japonés, reconstrucción, modelo). */
function Readiness() {
  const system = useApp((s) => s.system);
  const jobs = useApp((s) => s.jobs);
  const { data: llm } = useLLM();
  const downloading = Object.values(jobs).some((j) => (j.kind === 'model_install' || j.kind === 'llm_install') && isLive(j));
  if (!system || !llm) return <div className="readiness panel"><div className="spinner" /></div>;

  const profile = llm.advice.profile;
  const wanted = ['text-detector', ...(profile.ocr_japanese === 'manga-ocr' ? ['manga-ocr'] : []), ...(profile.inpaint === 'lama' ? ['lama'] : [])];
  const vision = system.models.filter((m) => wanted.includes(m.id));
  const missingVision = vision.filter((m) => !m.installed);
  const hasModel = llm.installed_models.length > 0;
  const rec = llm.advice.options.find((o) => o.id === llm.advice.recommended);
  const gpu = system.hardware.best_gpu;

  const items = [
    {
      ok: true,
      label: `${TIER_LABELS[profile.id]} · ${system.accelerator.gpu ? system.accelerator.name : 'procesador'}`,
      detail: gpu ? `${gpu.name} · ${(gpu.vram_mb / 1024).toFixed(0)} GB VRAM` : `${llm.advice.device.ram_gb} GB de RAM`,
    },
    {
      ok: missingVision.length === 0,
      label: missingVision.length === 0 ? 'Detección de texto y OCR instalados' : `Falta: ${missingVision.map((m) => m.label).join(', ')}`,
      detail: missingVision.length === 0 ? 'Globos, cartelas y texto vertical' : `Descarga única de ${missingVision.reduce((n, m) => n + m.approx_mb, 0)} MB`,
    },
    {
      ok: hasModel && llm.runtime_available,
      label: !llm.runtime_available ? 'Falta el servidor de modelos integrado' : hasModel ? 'Modelo de traducción instalado' : 'Falta un modelo de traducción',
      detail: hasModel ? (llm.installed_models.find((m) => m.active)?.label ?? 'Elige uno en Modelos')
        : rec ? `Recomendado: ${rec.label} (${formatBytes(rec.size)})` : llm.advice.reason,
    },
  ];
  const ready = items.every((i) => i.ok);
  const canFetch = missingVision.length > 0 || (!hasModel && !!rec && llm.runtime_available && rec.fit.fits !== 'no');
  const bytes = missingVision.reduce((n, m) => n + m.approx_mb * 1024 * 1024, 0) + (!hasModel && rec ? rec.size + (profile.vision_llm && rec.mmproj ? rec.mmproj_size : 0) : 0);

  const fetchAll = async () => {
    try {
      const c = client();
      for (const m of missingVision) useApp.getState().upsertJob(await c.installModel(m.id));
      if (!hasModel && rec) await startInstall(rec.repo, rec.file, { mmproj: profile.vision_llm ? rec.mmproj : null });
      useApp.getState().toast('info', 'Descargas iniciadas', 'Puedes seguir el progreso en la sección Modelos.');
    } catch (e) { reportError(e, 'No se pudo iniciar la descarga'); }
  };

  return (
    <section className="readiness panel" aria-label="Estado del dispositivo">
      <header>
        <Cpu aria-hidden />
        <h3>{ready ? 'Listo para traducir sin Internet' : 'Completa la configuración'}</h3>
      </header>
      <ul>
        {items.map((i) => (
          <li key={i.label} className={i.ok ? 'ok' : 'missing'}>
            {i.ok ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}
            <div><strong>{i.label}</strong><span className="small muted">{i.detail}</span></div>
          </li>
        ))}
      </ul>
      {canFetch && (
        <button className="btn btn-primary btn-sm" disabled={downloading} onClick={fetchAll}>
          {downloading ? <><span className="spinner" />Descargando…</> : `Descargar lo necesario (${formatBytes(bytes)})`}
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={() => navigate('/models')}>Abrir gestor de modelos</button>
    </section>
  );
}

export function Home() {
  const projects = useApp((s) => s.projects);
  const client = useApp((s) => s.client);
  const start = useImportFlow((s) => s.start);
  const recent = projects.slice(0, 4);

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <h1>Tu manga, en un español que suena a original.</h1>
          <p className="lead">STARBLITZ lee cada página con su contexto: quién habla, cómo lo dice y qué pasó antes. Traduce, borra el texto original y rotula el nuevo, todo en este dispositivo y sin depender de otro.</p>
        </div>
        <DropZone className="hero-drop" onFiles={(f) => start(f)}>
          <UploadCloud className="drop-icon" aria-hidden />
          <p className="drop-title">Arrastra aquí tu capítulo</p>
          <p className="small muted">ZIP, CBZ, PDF, JPG, PNG o WEBP · hasta 50 páginas por proyecto</p>
          <button className="btn btn-primary btn-lg" onClick={() => pickFiles((f) => start(f))}><UploadCloud />Importar archivo</button>
        </DropZone>
      </section>

      <div className="home-grid">
        <section aria-labelledby="recent-h">
          <div className="section-head">
            <h2 id="recent-h">Recientes</h2>
            {projects.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => navigate('/projects')}>Ver todos</button>}
          </div>
          {recent.length === 0 ? (
            <p className="muted">Todavía no hay proyectos. Importa un capítulo para empezar.</p>
          ) : (
            <div className="recent-grid">
              {recent.map((p) => (
                <button key={p.id} className="recent-card" onClick={() => navigate(`/project/${p.id}`)}>
                  <div className="cover">
                    {p.cover_page_id && client && <img src={client.imageUrl(p.id, p.cover_page_id, 'thumb')} alt="" loading="lazy" />}
                  </div>
                  <strong>{p.name}</strong>
                  <span className="small muted">{p.page_count} págs. · {LANGUAGES[p.source_lang] ?? p.source_lang} · {formatRelative(p.updated)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <Readiness />
      </div>

      <section className="capabilities" aria-label="Qué hace STARBLITZ">
        <div><Brain aria-hidden /><strong>Traducción con contexto</strong><span className="muted small">Personajes, glosario, páginas anteriores y la propia escena guían cada frase.</span></div>
        <div><ScanText aria-hidden /><strong>OCR para manga</strong><span className="muted small">Texto vertical, furigana y globos irregulares.</span></div>
        <div><Sparkles aria-hidden /><strong>Reconstrucción limpia</strong><span className="muted small">Borra solo el texto y conserva el dibujo y el contorno de los globos.</span></div>
        <div><FileDown aria-hidden /><strong>PDF, ZIP o imágenes</strong><span className="muted small">Con la resolución y el orden originales.</span></div>
      </section>
    </div>
  );
}
