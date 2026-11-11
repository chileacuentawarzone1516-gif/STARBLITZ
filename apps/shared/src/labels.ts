/** Textos de interfaz compartidos (español). */
import type { FitVerdict, FontRole, LicenseInfo, PageState, PageStatus, RegionKind, RegionStatus, RunStatus, Tier } from './types';

export const LANGUAGES: Record<string, string> = {
  auto: 'Detectar automáticamente', ja: 'Japonés', en: 'Inglés', ko: 'Coreano', zh: 'Chino simplificado', 'zh-hant': 'Chino tradicional',
  fr: 'Francés', it: 'Italiano', pt: 'Portugués', de: 'Alemán',
};

export const VARIANTS: Record<string, string> = {
  'es-419': 'Español latinoamericano (neutro)',
  'es-ES': 'Español de España',
};

export const KIND_LABELS: Record<RegionKind, string> = {
  dialogue: 'Diálogo', thought: 'Pensamiento', narration: 'Narración', sfx: 'Onomatopeya', other: 'Texto en escena',
};

export const STATUS_LABELS: Record<RegionStatus, string> = {
  pending: 'Pendiente', translated: 'Traducido', review: 'Revisar', approved: 'Aprobado', edited: 'Editado',
};

export const PAGE_STATUS_LABELS: Record<PageStatus, string> = {
  imported: 'Importada', analyzed: 'Analizada', translated: 'Traducida', cleaned: 'Lista', error: 'Error',
};

export const FLAG_LABELS: Record<string, string> = {
  idiom: 'Expresión adaptada', wordplay: 'Juego de palabras', sarcasm: 'Sarcasmo o ironía', honorific: 'Honorífico',
  cultural: 'Referencia cultural', ambiguous: 'Ambiguo', ocr_suspect: 'Posible error de OCR',
  too_long: 'Largo para el globo', untranslated: 'Sin traducir', refused: 'El modelo se negó a traducir',
  original_kept: 'Texto original conservado', no_fit: 'No cabe en el globo', ocr_empty: 'El OCR no leyó este texto',
  condensed: 'Reformulada más corta para que quepa (la versión completa está en la nota)',
};

/** Qué hace STARBLITZ con cada página mientras procesa el proyecto. */
export const PAGE_STATE_LABELS: Record<PageState, string> = {
  pending: 'Pendiente', analyzing: 'Detectando diálogos', analyzed: 'Lista para traducir', translating: 'Traduciendo',
  translated: 'Traducida', cleaning: 'Reconstruyendo globos', done: 'Terminada', error: 'Con error',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Procesando', paused: 'En pausa', done: 'Completado', error: 'Se detuvo por un error',
  cancelled: 'Cancelado', interrupted: 'Interrumpido',
};

export const TIER_LABELS: Record<Tier, string> = {
  low: 'Gama baja', mid: 'Gama media', high: 'Gama alta', 'pc-gpu': 'PC con GPU',
};

export const FIT_LABELS: Record<FitVerdict, string> = {
  gpu: 'Cabe en la GPU', hybrid: 'GPU + RAM', cpu: 'Procesador', no: 'No cabe',
};

export const LICENSE_CLASS_LABELS: Record<LicenseInfo['class'], string> = {
  permissive: 'Licencia libre', terms: 'Con condiciones', restricted: 'Uso restringido', unknown: 'Licencia sin verificar',
};

export const FONT_ROLE_LABELS: Record<FontRole, string> = {
  dialogue: 'Diálogo', narration: 'Narración', shout: 'Grito', whisper: 'Susurro', handwritten: 'Manuscrito',
  sfx: 'Onomatopeya',
};

export const STAGE_LABELS: Record<string, string> = {
  prepare: 'Preparando', analyze: 'Análisis y OCR', translate: 'Traducción contextual', clean: 'Reconstrucción',
  done: 'Completado',
};

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

export function formatRelative(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `hace ${Math.floor(diff / 86400)} d`;
  return new Date(epochSeconds * 1000).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m} min ${s.toString().padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${(m % 60).toString().padStart(2, '0')} min`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ACCEPTED_FILES = '.zip,.cbz,.pdf,.jpg,.jpeg,.png,.webp';
