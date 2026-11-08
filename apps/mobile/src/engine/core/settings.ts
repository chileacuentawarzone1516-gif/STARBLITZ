/** Ajustes persistentes del motor (equivalente a `core/settings.py`). */
import type { DeepPartial, GlossaryEntry, Settings } from '@starblitz/shared';
import { ValidationError } from './errors';

export const defaultSettings = (): Settings => ({
  llm: {
    provider: 'builtin', base_url: 'http://127.0.0.1:11434', model: '', temperature: 0.3, context_window: 12288,
    use_vision: true, timeout_s: 600, idle_unload_minutes: 10, api_key: '', hf_token: '',
  },
  translation: { target_variant: 'es-419', quality: 'auto', honorifics: 'adapt', sfx: 'keep', review_threshold: 0.72, profile: 'natural', dictionary: [] },
  processing: { device: 'auto', max_pages: 50, inpaint: 'auto', profile: 'auto' },
});

const RULES: Record<string, [string, number, number] | string[]> = {
  'llm.temperature': ['temperatura', 0, 1.5], 'llm.context_window': ['ventana de contexto', 2048, 262144],
  'llm.timeout_s': ['tiempo de espera', 30, 3600], 'llm.idle_unload_minutes': ['descarga por inactividad', 0, 240],
  'translation.review_threshold': ['umbral de revisión', 0, 1], 'processing.max_pages': ['páginas por proyecto', 1, 1000],
  'llm.provider': ['builtin', 'ollama', 'openai'], 'translation.target_variant': ['es-419', 'es-ES'],
  'translation.quality': ['auto', 'balanced', 'max'], 'translation.honorifics': ['adapt', 'keep'], 'translation.sfx': ['keep', 'note'], 'translation.profile': ['natural', 'fiel', 'coloquial', 'formal', 'adaptacion'],
  'processing.device': ['auto', 'gpu', 'cpu'], 'processing.inpaint': ['auto', 'lama', 'fast'],
  'processing.profile': ['auto', 'low', 'mid', 'high', 'pc-gpu'],
};

export const MAX_DICTIONARY = 500;

/** Diccionario personal saneado: sin vacíos ni duplicados, con límites de longitud y siempre obligatorio (igual que en Python). */
export function cleanDictionary(raw: unknown): GlossaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: GlossaryEntry[] = [];
  for (const e of raw as Partial<GlossaryEntry>[]) {
    const source = String(e?.source ?? '').trim().slice(0, 200);
    const target = String(e?.target ?? '').trim().slice(0, 200);
    if (!source || !target || seen.has(source.toLowerCase())) continue;
    seen.add(source.toLowerCase());
    out.push({ source, target, note: String(e?.note ?? '').trim().slice(0, 300), locked: true });
  }
  if (out.length > MAX_DICTIONARY) throw new ValidationError('invalid_settings', `El diccionario personal admite como máximo ${MAX_DICTIONARY} términos.`);
  return out;
}

function validate(s: Settings): void {
  for (const [path, rule] of Object.entries(RULES)) {
    const [section, key] = path.split('.') as ['llm' | 'translation' | 'processing', string];
    const value = (s[section] as unknown as Record<string, unknown>)[key];
    if (typeof rule[0] === 'string' && typeof rule[1] === 'number') {
      const [label, min, max] = rule as [string, number, number];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new ValidationError('invalid_settings', `Ajuste no válido (${label}): debe estar entre ${min} y ${max}.`);
      }
    } else if (!(rule as string[]).includes(value as string)) {
      throw new ValidationError('invalid_settings', `Ajuste no válido (${path}).`);
    }
  }
  s.translation.dictionary = cleanDictionary(s.translation.dictionary);
  const url = s.llm.base_url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new ValidationError('invalid_settings', 'La URL debe empezar por http:// o https://');
  s.llm.base_url = url;
}

function deepMerge<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? deepMerge(cur as object, v as object) : v;
  }
  return out as T;
}

/** Ajustes con el token de Hugging Face y la clave de API enmascarados (nunca se devuelven en claro). */
export function publicSettings(s: Settings): Settings {
  return { ...s, llm: { ...s.llm, api_key: s.llm.api_key ? '••••' : '', hf_token: s.llm.hf_token ? '••••' : '' } };
}

export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  const clean = JSON.parse(JSON.stringify(patch)) as DeepPartial<Settings>;
  if (clean.llm) for (const secret of ['api_key', 'hf_token'] as const) if (clean.llm[secret] === '••••') delete clean.llm[secret]; // valor enmascarado reenviado
  const merged = deepMerge(current, clean);
  validate(merged);
  return merged;
}

export function loadSettings(raw: unknown): Settings {
  try {
    const merged = deepMerge(defaultSettings(), (raw && typeof raw === 'object' ? raw : {}) as DeepPartial<Settings>);
    validate(merged);
    return merged;
  } catch {
    return defaultSettings(); // ajustes corruptos o de otra versión: valores por defecto
  }
}
