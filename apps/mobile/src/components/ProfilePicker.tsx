import { TRANSLATION_PROFILES, type TranslationProfile } from '@starblitz/shared';

/** Selector de perfil de traducción: lista de opciones con su descripción (radio accesible). */
export function ProfilePicker({ value, onChange, label = 'Perfil de traducción' }: { value: TranslationProfile; onChange(v: TranslationProfile): void; label?: string }) {
  return (
    <div className="m-profiles" role="radiogroup" aria-label={label}>
      {TRANSLATION_PROFILES.map((p) => (
        <button key={p.id} role="radio" aria-checked={value === p.id} className={`m-profile ${value === p.id ? 'on' : ''}`} onClick={() => onChange(p.id)}>
          <span className="m-profile-dot" aria-hidden />
          <span><strong>{p.label}</strong><span className="small muted">{p.description}</span></span>
        </button>
      ))}
    </div>
  );
}
