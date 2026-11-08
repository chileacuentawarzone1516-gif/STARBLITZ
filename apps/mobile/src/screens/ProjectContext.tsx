import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { normalizeProfile, type Character, type GlossaryEntry, type Project } from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import { ProfilePicker } from '../components/ProfilePicker';
import { EmptyState, Segmented, Toggle } from '../components/ui';
import { useBundle } from '../hooks';
import { navigate } from '../router';
import { engine, reportError } from '../state/app';

type Patch = Partial<Project>;
const GENDERS: { id: Character['gender']; label: string }[] = [{ id: '?', label: '¿?' }, { id: 'm', label: 'Él' }, { id: 'f', label: 'Ella' }, { id: 'n', label: 'Neutro' }];

/** Guarda con retraso y en orden: cada campo escribe solo lo que cambió, sin pisar otras ediciones. */
function useAutosave(id: string) {
  const pending = useRef<Patch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = async () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    try { await engine().updateProject(id, patch); } catch (e) { reportError(e, 'No se pudo guardar'); }
  };
  const save = (patch: Patch, delay = 500) => {
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, delay);
  };
  useEffect(() => () => { void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { save, flush };
}

export function ProjectContext({ id }: { id: string }) {
  const { bundle, missing } = useBundle(id);
  const { save, flush } = useAutosave(id);
  const [draft, setDraft] = useState<Project | null>(null);
  useEffect(() => { if (bundle && !draft) setDraft(bundle.project); }, [bundle, draft]);

  if (missing) return <div className="m-screen m-center"><p className="muted">Este proyecto ya no existe.</p><button className="btn" onClick={() => navigate('/')}>Volver</button></div>;
  if (!draft) return <div className="m-screen m-center"><span className="spinner" /></div>;

  const change = (patch: Patch, delay?: number) => { setDraft({ ...draft, ...patch }); save(patch, delay); };
  const setChar = (i: number, c: Partial<Character>) => change({ characters: draft.characters.map((x, k) => (k === i ? { ...x, ...c } : x)) });
  const setGloss = (i: number, g: Partial<GlossaryEntry>) => change({ glossary: draft.glossary.map((x, k) => (k === i ? { ...x, ...g } : x)) });

  return (
    <div className="m-screen">
      <header className="m-topbar">
        <div className="m-topbar-side"><button className="m-icon-btn" aria-label="Volver al proyecto" onClick={() => { void flush(); navigate(`/p/${id}`); }}><ArrowLeft /></button></div>
        <div className="m-topbar-title"><h1>Contexto</h1><span>{draft.name}</span></div>
        <div className="m-topbar-side right" />
      </header>

      <p className="small muted m-pad">Todo esto se envía al modelo en cada traducción para mantener nombres, tono y estilo coherentes. Se guarda solo en tu teléfono.</p>

      <section className="m-card">
        <h2>Proyecto</h2>
        <label className="field"><span className="label">Nombre</span>
          <input className="input" value={draft.name} maxLength={120} onChange={(e) => change({ name: e.target.value }, 900)} onBlur={() => { if (!draft.name.trim()) change({ name: bundle?.project.name ?? 'Proyecto' }, 0); }} /></label>
        <div className="field"><span className="label">Español de destino</span>
          <Segmented label="Variante" value={draft.target_variant} onChange={(v) => change({ target_variant: v }, 0)} options={[{ id: 'es-419', label: 'Latinoamérica' }, { id: 'es-ES', label: 'España' }]} /></div>
        <div className="field"><span className="label">Sentido de lectura</span>
          <Segmented label="Sentido" value={draft.reading_direction} onChange={(v) => change({ reading_direction: v }, 0)} options={[{ id: 'rtl', label: 'Derecha a izquierda' }, { id: 'ltr', label: 'Izquierda a derecha' }]} /></div>
        <Toggle id="hon" checked={draft.honorifics === 'keep'} onChange={(v) => change({ honorifics: v ? 'keep' : 'adapt' }, 0)} label="Conservar honoríficos" hint="-san, -kun, senpai… se dejan tal cual en vez de adaptarlos." />
        <Toggle id="sfx" checked={draft.sfx === 'note'} onChange={(v) => change({ sfx: v ? 'note' : 'keep' }, 0)} label="Anotar los efectos de sonido" hint="Añade una nota con su significado; por defecto se dejan como están." />
      </section>

      <section className="m-card">
        <h2>Perfil de traducción</h2>
        <p className="small muted">Cambia el criterio con el que se traduce este proyecto, no el significado. Se aplica en la próxima traducción; lo que ya aprobaste o editaste no se toca.</p>
        <ProfilePicker value={normalizeProfile(draft.translation_profile)} onChange={(v) => change({ translation_profile: v }, 0)} />
      </section>

      <section className="m-card">
        <h2>Historia y estilo</h2>
        <label className="field"><span className="label">Sinopsis</span>
          <textarea className="textarea" rows={4} maxLength={4000} placeholder="De qué trata, época, ambientación…" value={draft.synopsis} onChange={(e) => change({ synopsis: e.target.value })} /></label>
        <label className="field"><span className="label">Notas de estilo</span>
          <textarea className="textarea" rows={3} maxLength={2000} placeholder="Tono (humor, serio), cómo se tratan entre sí, tecnicismos…" value={draft.style_notes} onChange={(e) => change({ style_notes: e.target.value })} /></label>
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>Personajes</h2>
          <button className="btn btn-sm" onClick={() => change({ characters: [...draft.characters, { source: '', target: '', gender: '?', speech: '', locked: false }] }, 0)}><Plus />Añadir</button></div>
        {!draft.characters.length && <EmptyState title="Sin personajes">Añade los nombres y cómo hablan para que la traducción los trate igual en todas las páginas.</EmptyState>}
        {draft.characters.map((c, i) => (
          <div className="m-row-card" key={i}>
            <div className="m-two">
              <label className="field"><span className="label">Nombre original</span><input className="input" value={c.source} maxLength={120} onChange={(e) => setChar(i, { source: e.target.value })} /></label>
              <label className="field"><span className="label">En español</span><input className="input" value={c.target} maxLength={120} onChange={(e) => setChar(i, { target: e.target.value })} /></label>
            </div>
            <div className="field"><span className="label">Género gramatical</span>
              <Segmented label="Género" value={c.gender} options={GENDERS} onChange={(v) => setChar(i, { gender: v })} /></div>
            <label className="field"><span className="label">Cómo habla</span><input className="input" value={c.speech} maxLength={200} placeholder="Formal, bromista, brusco, usa «ustedes»…" onChange={(e) => setChar(i, { speech: e.target.value })} /></label>
            <div className="m-row-actions">
              <Toggle id={`cl${i}`} checked={c.locked} onChange={(v) => setChar(i, { locked: v })} label="Fijar" hint="El modelo no puede cambiarlo." />
              <button className="m-icon-btn" aria-label="Quitar personaje" onClick={() => change({ characters: draft.characters.filter((_, k) => k !== i) }, 0)}><Trash2 /></button>
            </div>
          </div>
        ))}
      </section>

      <section className="m-card">
        <div className="m-card-head"><h2>Glosario</h2>
          <button className="btn btn-sm" onClick={() => change({ glossary: [...draft.glossary, { source: '', target: '', note: '', locked: true }] }, 0)}><Plus />Añadir</button></div>
        {!draft.glossary.length && <EmptyState title="Sin términos">Lugares, técnicas, organizaciones… lo que siempre debe traducirse igual.</EmptyState>}
        {draft.glossary.map((g, i) => (
          <div className="m-row-card" key={i}>
            <div className="m-two">
              <label className="field"><span className="label">Término</span><input className="input" value={g.source} maxLength={200} onChange={(e) => setGloss(i, { source: e.target.value })} /></label>
              <label className="field"><span className="label">Traducción</span><input className="input" value={g.target} maxLength={200} onChange={(e) => setGloss(i, { target: e.target.value })} /></label>
            </div>
            <label className="field"><span className="label">Nota (opcional)</span><input className="input" value={g.note} maxLength={300} onChange={(e) => setGloss(i, { note: e.target.value })} /></label>
            <div className="m-row-actions">
              <Toggle id={`gl${i}`} checked={g.locked} onChange={(v) => setGloss(i, { locked: v })} label="Obligatorio" hint="Se usa siempre tal cual." />
              <button className="m-icon-btn" aria-label="Quitar término" onClick={() => change({ glossary: draft.glossary.filter((_, k) => k !== i) }, 0)}><Trash2 /></button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
