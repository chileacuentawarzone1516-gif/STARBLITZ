/** Perfiles de traducción. Nombre y descripción salen de `translate/prompts.py` (única fuente) vía `tools/export_translate_fixtures.py`. */
import raw from './translation-profiles.json';
import type { TranslationProfile } from './types';

export interface ProfileInfo { id: TranslationProfile; label: string; description: string }

export const TRANSLATION_PROFILES = raw.profiles as ProfileInfo[];
export const DEFAULT_TRANSLATION_PROFILE = raw.default as TranslationProfile;

/** Perfil válido o el predeterminado (proyectos antiguos o datos manipulados). */
export function normalizeProfile(value: unknown): TranslationProfile {
  return TRANSLATION_PROFILES.some((p) => p.id === value) ? (value as TranslationProfile) : DEFAULT_TRANSLATION_PROFILE;
}
