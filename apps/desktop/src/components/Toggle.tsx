/** Interruptor accesible con etiqueta y ayuda opcional. */
export function Toggle({ id, checked, onChange, label, hint }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string;
}) {
  return (
    <div className="toggle-row">
      <div><label htmlFor={id} className="label">{label}</label>{hint && <p className="hint">{hint}</p>}</div>
      <label className="switch"><input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></label>
    </div>
  );
}
