import { ArrowLeft, BookOpen, CheckCircle2, Copy, Download, ImagePlus, Lock, LockOpen, PenTool, Play, Plus, Trash2 } from 'lucide-react';
import {
  LANGUAGES, PAGE_STATE_LABELS, PAGE_STATUS_LABELS, TRANSLATION_PROFILES, VARIANTS, normalizeProfile, type Character, type GlossaryEntry, type Job, type Page, type PageState,
  type ProjectBundle, type RunInfo, type TranslationProfile, plural,
} from '@starblitz/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmAction, Dialog } from '../components/Dialog';
import { ExportDialog } from '../components/ExportDialog';
import { DropZone, pickFiles, useImportFlow } from '../components/ImportFlow';
import { RunPanel } from '../components/RunPanel';
import { TranslatedThumb } from '../components/TranslatedThumb';
import { navigate } from '../router';
import { mergeMemoryEdits } from '../memory';
import { client, isLive, reportError, useActiveJob, useApp } from '../store';

type Tab = 'pages' | 'memory' | 'settings';

export function useProjectBundle(id: string | undefined) {
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!id) return;
    try {
      const b = await client().project(id);
      setBundle(b);
      useApp.getState().setRun(id, b.run);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => { setBundle(null); load(); }, [load]);
  return { bundle, setBundle, reload: load, error };
}

export function ProjectView({ id }: { id: string }) {
  const { bundle, setBundle, reload, error } = useProjectBundle(id);
  const [tab, setTab] = useState<Tab>('pages');
  const [exporting, setExporting] = useState(false);
  const [finished, setFinished] = useState<Job | null>(null);
  const [processMenu, setProcessMenu] = useState(false);
  const job = useActiveJob(id);
  const jobs = useApp((s) => s.jobs);
  const run = useApp((s) => s.runs[id]);
  const ticks = useApp((s) => s.pageTicks[id] ?? 0);
  const startImport = useImportFlow((s) => s.start);
  // Las tareas ya terminadas al abrir la vista no deben disparar avisos de «completado».
  const mountedAt = useRef(Date.now());
  const seenDone = useRef<Set<string> | null>(null);
  if (seenDone.current === null) {
    seenDone.current = new Set(Object.values(jobs).filter((j) => !isLive(j)).map((j) => j.id));
  }

  // Cada vez que el motor avisa de que una página cambió, se refresca la cuadrícula (agrupando avisos cercanos).
  useEffect(() => {
    if (!ticks) return;
    const t = setTimeout(() => { reload(); }, 900);
    return () => clearTimeout(t);
  }, [ticks, reload]);

  // Recarga cuando termina una tarea de este proyecto (sin sondeos innecesarios).
  useEffect(() => {
    for (const j of Object.values(jobs)) {
      if (j.project_id !== id || seenDone.current!.has(j.id)) continue;
      if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
        seenDone.current!.add(j.id);
        reload();
        useApp.getState().refreshProjects();
        if (j.kind === 'process' && j.status === 'done' && (j.finished ?? 0) * 1000 > mountedAt.current) setFinished(j);
        if (j.status === 'error') useApp.getState().toast('error', 'El procesamiento se detuvo', j.error);
      }
    }
  }, [jobs, id, reload]);

  if (error) return <div className="page"><p className="muted">{error}</p><button className="btn" onClick={() => navigate('/projects')}>Volver a proyectos</button></div>;
  if (!bundle) return <div className="page center"><div className="spinner" /></div>;
  const { project, pages, summary } = bundle;

  const process = async (stages?: ('analyze' | 'translate' | 'clean')[], force = false) => {
    setProcessMenu(false);
    try {
      const j = await client().process(id, { stages, force });
      useApp.getState().upsertJob(j);
    } catch (e) { reportError(e, 'No se pudo iniciar el procesamiento'); }
  };

  return (
    <div className="page project-page">
      <div className="page-head">
        <div className="head-title">
          <button className="btn btn-ghost btn-icon" aria-label="Volver a proyectos" onClick={() => navigate('/projects')}><ArrowLeft /></button>
          <div>
            <h1>{project.name}</h1>
            <p className="muted small">
              {project.source_lang === 'auto'
                ? (project.detected_lang ? `${LANGUAGES[project.detected_lang] ?? project.detected_lang} (detectado)` : 'Idioma automático')
                : LANGUAGES[project.source_lang] ?? project.source_lang} → {VARIANTS[project.target_variant]} · {plural(pages.length, 'página', 'páginas')} · {summary.translated}/{summary.regions} textos traducidos
              {summary.review > 0 && <> · <span className="text-review">{summary.review} por revisar</span></>}
            </p>
          </div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => pickFiles((f) => startImport(f, id))} disabled={!!job}><ImagePlus />Añadir páginas</button>
          <div className="menu-wrap">
            <button className="btn btn-primary" disabled={!!job || !pages.length} onClick={() => setProcessMenu((v) => !v)} aria-expanded={processMenu}>
              <Play />Procesar
            </button>
            {processMenu && (
              <div className="menu menu-right" role="menu" onMouseLeave={() => setProcessMenu(false)}>
                <button role="menuitem" onClick={() => process()}>Todo el proyecto, automático (analizar, traducir y reconstruir)</button>
                <button role="menuitem" onClick={() => process(['translate'])}>Solo traducir (respeta lo editado)</button>
                <button role="menuitem" onClick={() => process(['clean'])}>Solo reconstruir imágenes</button>
                <button role="menuitem" onClick={() => process(['analyze', 'translate', 'clean'], true)}>Rehacer desde cero</button>
              </div>
            )}
          </div>
          <button className="btn" disabled={!pages.length} onClick={() => navigate(`/editor/${id}`)}><PenTool />Editor</button>
          <button className="btn" disabled={!pages.length} onClick={() => setExporting(true)}><Download />Exportar</button>
        </div>
      </div>

      <RunPanel project={project} job={job} run={run} />

      <div className="tabs" role="tablist">
        {([['pages', 'Páginas'], ['memory', 'Personajes y glosario'], ['settings', 'Ajustes del proyecto']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'pages' && <PagesTab bundle={bundle} run={run} busy={!!job} onChange={reload} setBundle={setBundle} onFiles={(f) => startImport(f, id)} />}
      {tab === 'memory' && <MemoryTab bundle={bundle} onSaved={reload} />}
      {tab === 'settings' && <SettingsTab bundle={bundle} onSaved={reload} />}

      {exporting && <ExportDialog project={project} pages={pages} onClose={() => setExporting(false)} />}
      {finished && (
        <Dialog title="Traducción completada" onClose={() => setFinished(null)}
          description={doneSummary(finished, summary.review)}
          actions={<>
            <button className="btn" onClick={() => { setFinished(null); navigate(`/editor/${id}`); }}><BookOpen />Revisar en el editor</button>
            <button className="btn btn-primary" data-autofocus onClick={() => { setFinished(null); setExporting(true); }}><Download />Exportar resultado</button>
          </>}>
          <div className="done-mark"><CheckCircle2 aria-hidden /></div>
        </Dialog>
      )}
    </div>
  );
}

function doneSummary(job: Job, review: number): string {
  const r = (job.result ?? {}) as { pages?: number; seconds?: number; translation?: { model?: string; edited_by_reviewer?: number } };
  const n = r.pages ?? 0;
  const parts = [`${n} ${n === 1 ? 'página procesada' : 'páginas procesadas'}`];
  if (r.translation?.model) parts.push(`modelo ${r.translation.model}`);
  if (r.translation?.edited_by_reviewer) parts.push(`${r.translation.edited_by_reviewer} frases pulidas por la revisión editorial`);
  const pending = review === 1 ? ' Hay 1 texto marcado para revisar.' : review ? ` Hay ${review} textos marcados para revisar.` : ' No hay textos pendientes de revisión.';
  return `${parts.join(', ')}.${pending}`;
}

const ACTIVE_STATES: PageState[] = ['analyzing', 'translating', 'cleaning'];

function PagesTab({ bundle, run, busy, onChange, setBundle, onFiles }: {
  bundle: ProjectBundle; run: RunInfo | null | undefined; busy: boolean; onChange: () => void; setBundle: (b: ProjectBundle) => void;
  onFiles: (f: File[]) => void;
}) {
  const api = useApp((s) => s.client);
  const { project, pages } = bundle;
  const [drag, setDrag] = useState<string | null>(null);
  const [view, setView] = useState<'original' | 'translated'>('original');
  const anyCleaned = pages.some((p) => p.status === 'cleaned');
  const showTranslated = anyCleaned && view === 'translated';

  const reorder = async (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = pages.map((p) => p.id);
    const from = ids.indexOf(fromId);
    ids.splice(from, 1);
    ids.splice(ids.indexOf(toId) + (from <= ids.indexOf(toId) ? 1 : 0), 0, fromId);
    const byId = new Map(pages.map((p) => [p.id, p]));
    setBundle({ ...bundle, pages: ids.map((pid, i) => ({ ...byId.get(pid)!, index: i })) });
    try { await client().reorderPages(project.id, ids); } catch (e) { reportError(e); }
    onChange();
  };

  const remove = async (p: Page) => {
    const ok = await confirmAction({ title: `¿Eliminar la página ${p.index + 1}?`, message: `«${p.filename}» y su traducción se eliminarán del proyecto.`, confirm: 'Eliminar página', danger: true });
    if (!ok) return;
    try { await client().deletePage(project.id, p.id); onChange(); } catch (e) { reportError(e); }
  };

  if (!pages.length) {
    return (
      <DropZone className="empty-drop" onFiles={onFiles}>
        <ImagePlus className="drop-icon" aria-hidden />
        <p className="drop-title">Este proyecto no tiene páginas</p>
        <button className="btn btn-primary" onClick={() => pickFiles(onFiles)}><Plus />Añadir páginas</button>
      </DropZone>
    );
  }

  return (
    <DropZone className="pages-drop" onFiles={onFiles}>
      <div className="grid-toolbar">
        <p className="small muted">{busy ? 'Las páginas se actualizan solas a medida que terminan.' : 'Arrastra las miniaturas para reordenar. Suelta archivos aquí para añadir más páginas.'}</p>
        {anyCleaned && (
          <div className="segmented" role="group" aria-label="Qué mostrar en las miniaturas">
            <button className={view === 'original' ? 'on' : ''} aria-pressed={view === 'original'} onClick={() => setView('original')}>Original</button>
            <button className={view === 'translated' ? 'on' : ''} aria-pressed={view === 'translated'} onClick={() => setView('translated')}>Traducida</button>
          </div>
        )}
      </div>
      <div className="page-grid">
        {pages.map((p) => {
          const review = p.regions.filter((r) => r.status === 'review').length;
          const state = busy ? run?.pages[p.id]?.state : undefined;
          const working = !!state && ACTIVE_STATES.includes(state);
          const translated = showTranslated && p.status === 'cleaned';
          return (
            <figure key={p.id} className={`page-thumb ${drag === p.id ? 'dragging' : ''}`} draggable={!busy}
              onDragStart={(e) => { setDrag(p.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id); }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (drag) { e.preventDefault(); e.stopPropagation(); } }}
              onDrop={(e) => { if (drag) { e.preventDefault(); e.stopPropagation(); reorder(drag, p.id); setDrag(null); } }}>
              <button className={`thumb-img ${working ? 'working' : ''}`} onClick={() => navigate(`/editor/${project.id}/${p.id}`)} disabled={working}
                title={working ? 'Se está procesando esta página' : undefined} aria-label={`${working ? 'Procesando' : 'Editar'} página ${p.index + 1}`}>
                {translated ? <TranslatedThumb projectId={project.id} page={p} />
                  : api && <img src={api.imageUrl(project.id, p.id, 'thumb', p.updated)} alt="" loading="lazy" draggable={false} />}
                <span className="thumb-index mono">{p.index + 1}</span>
                {working && <span className="thumb-scan" aria-hidden />}
                {p.approved && <span className="thumb-approved" title="Página aprobada"><CheckCircle2 /></span>}
              </button>
              <figcaption>
                {state
                  ? <span className={`chip ${stateChip(state)}`} aria-live="polite">{PAGE_STATE_LABELS[state]}</span>
                  : <span className={`chip ${p.status === 'error' ? 'chip-danger' : p.status === 'cleaned' ? 'chip-ok' : ''}`}>{PAGE_STATUS_LABELS[p.status]}</span>}
                {review > 0 && <span className="chip chip-review">{review} revisar</span>}
                {p.duplicate_of && <span className="chip chip-warn" title="Muy parecida a otra página"><Copy />Duplicado</span>}
                <button className="btn btn-ghost btn-icon btn-sm push" aria-label={`Eliminar página ${p.index + 1}`} disabled={busy} onClick={() => remove(p)}><Trash2 /></button>
              </figcaption>
              {(state === 'error' ? run?.pages[p.id]?.error : p.error) && <p className="small text-danger">{state === 'error' ? run?.pages[p.id]?.error : p.error}</p>}
            </figure>
          );
        })}
      </div>
    </DropZone>
  );
}

const stateChip = (s: PageState) => (s === 'done' ? 'chip-ok' : s === 'error' ? 'chip-danger' : s === 'pending' ? '' : 'chip-blue');

function MemoryTab({ bundle, onSaved }: { bundle: ProjectBundle; onSaved: () => void }) {
  const [chars, setChars] = useState<Character[]>(bundle.project.characters);
  const [terms, setTerms] = useState<GlossaryEntry[]>(bundle.project.glossary);
  const [dirty, setDirty] = useState(false);
  // Lo que había al empezar a editar: sirve para distinguir lo que la IA añadió después de lo que el usuario borró.
  const base = useRef({ chars: bundle.project.characters, terms: bundle.project.glossary });
  useEffect(() => {
    if (dirty) return; // sin cambios propios, la pestaña sigue al proyecto (la IA añade términos mientras procesa)
    setChars(bundle.project.characters); setTerms(bundle.project.glossary);
    base.current = { chars: bundle.project.characters, terms: bundle.project.glossary };
  }, [bundle.project.characters, bundle.project.glossary, dirty]);
  const save = async () => {
    try {
      // Antes se enviaba la lista de la pestaña tal cual y SUSTITUÍA a la del motor: se perdían los personajes y
      // términos que la IA había añadido durante el procesado desde que se abrió la pestaña.
      const latest = (await client().project(bundle.project.id)).project;
      await client().updateProject(bundle.project.id, {
        characters: mergeMemoryEdits(chars.filter((c) => c.source.trim()), base.current.chars, latest.characters),
        glossary: mergeMemoryEdits(terms.filter((t) => t.source.trim() && t.target.trim()), base.current.terms, latest.glossary),
      });
      setDirty(false);
      useApp.getState().toast('ok', 'Memoria del proyecto guardada', 'Se aplicará en las próximas traducciones.');
      onSaved();
    } catch (e) { reportError(e); }
  };
  const editChar = (i: number, patch: Partial<Character>) => { setChars(chars.map((c, j) => (j === i ? { ...c, ...patch, locked: patch.locked ?? true } : c))); setDirty(true); };
  const editTerm = (i: number, patch: Partial<GlossaryEntry>) => { setTerms(terms.map((t, j) => (j === i ? { ...t, ...patch, locked: patch.locked ?? true } : t))); setDirty(true); };

  return (
    <div className="memory">
      <p className="muted">La IA propone personajes y términos al traducir. Lo que edites aquí queda fijado (candado cerrado) y siempre se respeta.</p>
      <section>
        <div className="section-head">
          <h3>Personajes</h3>
          <button className="btn btn-sm" onClick={() => { setChars([...chars, { source: '', target: '', gender: '?', speech: '', locked: true }]); setDirty(true); }}><Plus />Añadir</button>
        </div>
        <div className="table" role="table" aria-label="Personajes">
          <div className="tr th" role="row"><span>Original</span><span>En español</span><span>Género</span><span>Forma de hablar</span><span /></div>
          {chars.length === 0 && <p className="muted small" style={{ padding: 12 }}>Sin personajes todavía.</p>}
          {chars.map((c, i) => (
            <div className="tr" role="row" key={i}>
              <input className="input" aria-label="Nombre original" value={c.source} onChange={(e) => editChar(i, { source: e.target.value })} />
              <input className="input" aria-label="Nombre en español" value={c.target} onChange={(e) => editChar(i, { target: e.target.value })} />
              <select className="select" aria-label="Género" value={c.gender} onChange={(e) => editChar(i, { gender: e.target.value as Character['gender'] })}>
                <option value="?">—</option><option value="f">Femenino</option><option value="m">Masculino</option><option value="n">Neutro</option>
              </select>
              <input className="input" aria-label="Forma de hablar" placeholder="p. ej. formal, usa «usted», tartamudea" value={c.speech} onChange={(e) => editChar(i, { speech: e.target.value })} />
              <span className="row-actions">
                <button className="btn btn-ghost btn-icon btn-sm" title={c.locked ? 'Fijado por ti' : 'Propuesto por la IA'} aria-label="Fijar" onClick={() => editChar(i, { locked: !c.locked })}>{c.locked ? <Lock /> : <LockOpen />}</button>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Eliminar" onClick={() => { setChars(chars.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 /></button>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="section-head">
          <h3>Glosario</h3>
          <button className="btn btn-sm" onClick={() => { setTerms([...terms, { source: '', target: '', note: '', locked: true }]); setDirty(true); }}><Plus />Añadir</button>
        </div>
        <div className="table table-3" role="table" aria-label="Glosario">
          <div className="tr th" role="row"><span>Término original</span><span>Traducción obligatoria</span><span>Nota</span><span /></div>
          {terms.length === 0 && <p className="muted small" style={{ padding: 12 }}>Sin términos todavía.</p>}
          {terms.map((t, i) => (
            <div className="tr" role="row" key={i}>
              <input className="input" aria-label="Término original" value={t.source} onChange={(e) => editTerm(i, { source: e.target.value })} />
              <input className="input" aria-label="Traducción" value={t.target} onChange={(e) => editTerm(i, { target: e.target.value })} />
              <input className="input" aria-label="Nota" value={t.note} onChange={(e) => editTerm(i, { note: e.target.value })} />
              <span className="row-actions">
                <button className="btn btn-ghost btn-icon btn-sm" title={t.locked ? 'Fijado por ti' : 'Propuesto por la IA'} aria-label="Fijar" onClick={() => editTerm(i, { locked: !t.locked })}>{t.locked ? <Lock /> : <LockOpen />}</button>
                <button className="btn btn-ghost btn-icon btn-sm" aria-label="Eliminar" onClick={() => { setTerms(terms.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 /></button>
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className="sticky-save"><button className="btn btn-primary" disabled={!dirty} onClick={save}>Guardar cambios</button></div>
    </div>
  );
}

function SettingsTab({ bundle, onSaved }: { bundle: ProjectBundle; onSaved: () => void }) {
  const p = bundle.project;
  const [form, setForm] = useState<{
    name: string; source_lang: string; target_variant: typeof p.target_variant; reading_direction: 'auto' | 'rtl' | 'ltr';
    honorifics: typeof p.honorifics; sfx: typeof p.sfx; translation_profile: TranslationProfile; synopsis: string; style_notes: string;
  }>({
    name: p.name, source_lang: p.source_lang, target_variant: p.target_variant, reading_direction: p.direction_auto ? 'auto' : p.reading_direction,
    honorifics: p.honorifics, sfx: p.sfx, translation_profile: normalizeProfile(p.translation_profile), synopsis: p.synopsis, style_notes: p.style_notes,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });
  const save = async () => {
    try {
      // «Automático» no se envía: el motor sigue deduciendo el sentido de lectura del idioma detectado.
      const { reading_direction, ...rest } = form;
      await client().updateProject(p.id, reading_direction === 'auto' ? rest : { ...rest, reading_direction });
      useApp.getState().toast('ok', 'Ajustes del proyecto guardados');
      useApp.getState().refreshProjects();
      onSaved();
    } catch (e) { reportError(e); }
  };
  return (
    <div className="form-grid project-settings">
      <div className="field span-2"><label htmlFor="ps-name">Nombre</label>
        <input id="ps-name" className="input" maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="field"><label htmlFor="ps-lang">Idioma original</label>
        <select id="ps-lang" className="select" value={form.source_lang} onChange={(e) => set('source_lang', e.target.value)}>
          {Object.entries(LANGUAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <span className="hint">«Detectar automáticamente» reconoce japonés o inglés al procesar. Cambiarlo requiere volver a analizar las páginas.</span></div>
      <div className="field"><label htmlFor="ps-var">Variante de español</label>
        <select id="ps-var" className="select" value={form.target_variant} onChange={(e) => set('target_variant', e.target.value as typeof form.target_variant)}>
          {Object.entries(VARIANTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div className="field"><label htmlFor="ps-dir">Sentido de lectura</label>
        <select id="ps-dir" className="select" value={form.reading_direction} onChange={(e) => set('reading_direction', e.target.value as 'auto' | 'rtl' | 'ltr')}>
          {p.direction_auto && <option value="auto">Automático (según el idioma detectado)</option>}
          <option value="rtl">De derecha a izquierda (manga)</option><option value="ltr">De izquierda a derecha (cómic, manhwa)</option></select></div>
      <div className="field"><label htmlFor="ps-hon">Honoríficos japoneses</label>
        <select id="ps-hon" className="select" value={form.honorifics} onChange={(e) => set('honorifics', e.target.value as 'adapt' | 'keep')}>
          <option value="adapt">Adaptar al trato en español</option><option value="keep">Conservar (-san, -kun, senpai…)</option></select></div>
      <div className="field"><label htmlFor="ps-sfx">Onomatopeyas dibujadas</label>
        <select id="ps-sfx" className="select" value={form.sfx} onChange={(e) => set('sfx', e.target.value as 'keep' | 'note')}>
          <option value="keep">Conservar el dibujo original</option><option value="note">Conservar y añadir la traducción encima</option></select></div>
      <div className="field span-2"><label htmlFor="ps-prof">Perfil de traducción</label>
        <select id="ps-prof" className="select" value={form.translation_profile} onChange={(e) => set('translation_profile', e.target.value as TranslationProfile)}>
          {TRANSLATION_PROFILES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
        <span className="hint">{TRANSLATION_PROFILES.find((x) => x.id === form.translation_profile)?.description} Se aplica en la próxima traducción; lo aprobado o editado a mano no se toca.</span></div>
      <div className="field span-2"><label htmlFor="ps-syn">Sinopsis o contexto de la obra</label>
        <textarea id="ps-syn" className="textarea" rows={4} maxLength={4000} value={form.synopsis} onChange={(e) => set('synopsis', e.target.value)}
          placeholder="Quiénes son los protagonistas, su relación, el tono de la obra… Mejora mucho la traducción." /></div>
      <div className="field span-2"><label htmlFor="ps-style">Indicaciones de estilo</label>
        <textarea id="ps-style" className="textarea" rows={3} maxLength={2000} value={form.style_notes} onChange={(e) => set('style_notes', e.target.value)}
          placeholder="p. ej. «Kenji habla de usted a su jefe», «evitar groserías», «mantener los nombres de técnicas en japonés»" /></div>
      <div className="span-2"><button className="btn btn-primary" onClick={save}>Guardar ajustes</button></div>
    </div>
  );
}
