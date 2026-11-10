/**
 * Instrucciones y esquemas del traductor contextual. Los textos salen de `translate/prompts.py` (única fuente de
 * verdad) mediante `tools/export_translate_fixtures.py`: móvil y PC envían al modelo exactamente lo mismo.
 */
import { normalizeProfile } from '@starblitz/shared';
import raw from './prompts.json';

export const LANG_NAMES = raw.lang_names as Record<string, string>;
export const VARIANTS = raw.variants as unknown as Record<string, [string, string]>;
export const HONORIFICS = raw.honorifics as Record<string, string>;
export const PROFILE_RULES = Object.fromEntries(Object.entries(raw.profiles as unknown as Record<string, [string, string, string]>).map(([id, v]) => [id, v[2]])) as Record<string, string>;
export const KIND_LABELS = raw.kind_labels as Record<string, string>;
export const SUMMARY_NOTE = raw.summary_note;
export const TRANSLATION_SCHEMA = raw.translation_schema as Record<string, unknown>;
export const REVIEW_SCHEMA = raw.review_schema as Record<string, unknown>;
export const REFUSAL_PATTERN = raw.refusal_pattern;
export const ECHO_NOTE = raw.echo_note;
export const REPAIR_HEADER = raw.repair_header;

/** Sustituye `{nombre}` por su valor (sin interpretar caracteres especiales del texto de reemplazo). */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
}

/** Instrucción del perfil de traducción (los proyectos antiguos, sin perfil, usan «natural»). */
export const profileRules = (profile: string | undefined): string => PROFILE_RULES[profile ?? ''] ?? PROFILE_RULES[normalizeProfile(profile)];

export function translatorSystem(variant: string, honorifics: string, profile?: string): string {
  const [variantName, variantRules] = VARIANTS[variant];
  return fill(raw.translator_system, { variant_name: variantName, variant_rules: variantRules, honorifics: HONORIFICS[honorifics], profile_rules: profileRules(profile) });
}

export function reviewerSystem(variant: string, profile?: string): string {
  const [variantName, variantRules] = VARIANTS[variant];
  return fill(raw.reviewer_system, { variant_name: variantName, variant_rules: variantRules, profile_rules: profileRules(profile) });
}
