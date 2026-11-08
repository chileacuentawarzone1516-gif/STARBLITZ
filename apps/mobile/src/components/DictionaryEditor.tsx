import { Plus, Trash2 } from 'lucide-react';
import type { GlossaryEntry } from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from './ui';

const MAX = 500;

/** Diccionario personal: términos que se aplican en todos los proyectos. Guarda con retraso, sin perder lo escrito. */
export function DictionaryEditor({ entries, onSave }: { entries: GlossaryEntry[]; onSave(entries: GlossaryEntry[]): Promise<void> }) {
  const [rows, setRows] = useState<GlossaryEntry[]>(entries);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(rows);
  latest.current = rows;
  const dirty = useRef(false);
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current) return Promise.resolve();
    dirty.current = false;
    return onSave(latest.current.filter((r) => r.source.trim() && r.target.trim()));
  };
  useEffect(() => () => { void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: GlossaryEntry[], delay = 700) => {
    setRows(next);
    latest.current = next;
    dirty.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, delay);
  };
  const set = (i: number, patch: Partial<GlossaryEntry>) => change(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <div className="m-stack">
      {!rows.length && <EmptyState title="Tu diccionario está vacío">Nombres, técnicas o expresiones que quieres traducir siempre igual, en cualquier proyecto.</EmptyState>}
      {rows.map((r, i) => (
        <div className="m-row-card" key={i}>
          <div className="m-two">
            <label className="field"><span className="label">Original</span><input className="input" value={r.source} maxLength={200} onChange={(e) => set(i, { source: e.target.value })} /></label>
            <label className="field"><span className="label">En español</span><input className="input" value={r.target} maxLength={200} onChange={(e) => set(i, { target: e.target.value })} /></label>
          </div>
          <div className="m-row-actions">
            <label className="field grow"><span className="label">Nota (opcional)</span><input className="input" value={r.note} maxLength={300} onChange={(e) => set(i, { note: e.target.value })} /></label>
            <button className="m-icon-btn" aria-label={`Quitar «${r.source || 'término'}»`} onClick={() => change(rows.filter((_, k) => k !== i), 0)}><Trash2 /></button>
          </div>
        </div>
      ))}
      <button className="btn" disabled={rows.length >= MAX} onClick={() => change([...rows, { source: '', target: '', note: '', locked: true }], 5000)}><Plus />Añadir término</button>
      <p className="small muted">El glosario de cada proyecto tiene prioridad si un mismo término aparece en los dos. {rows.length}/{MAX} términos.</p>
    </div>
  );
}
