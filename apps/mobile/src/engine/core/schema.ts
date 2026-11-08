/**
 * Valores por defecto y validación del formato de proyecto v1 (equivalente a `projects/schema.py`).
 * Los tipos viven en `@starblitz/shared`: son los mismos que usa el motor del PC y la interfaz de escritorio.
 */
import { normalizeProfile, type Page, type Project, type Region, type TextStyle } from '@starblitz/shared';
import { ValidationError } from './errors';
import { validateId } from './ids';

export const FORMAT_VERSION = 1;
export const AUTO_LANG = 'auto';

export const now = (): number => Math.round(Date.now()) / 1000;

export function defaultStyle(): TextStyle {
  return {
    font: 'dialogue', size: null, align: 'center', color: '#111111', stroke_color: '#ffffff', stroke_width: 0,
    bold: false, italic: false, uppercase: false, line_height: 1.12, letter_spacing: 0, rotation: 0,
  };
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FONTS = ['dialogue', 'narration', 'shout', 'whisper', 'handwritten', 'sfx'];
const ALIGNS = ['center', 'left', 'right'];

function inRange(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ValidationError('invalid_style', `El valor de «${name}» debe estar entre ${min} y ${max}.`);
  }
  return v;
}

/** Combina un estilo parcial con el actual validando rangos, colores y tipografías (igual que pydantic en Python). */
export function mergeStyle(base: TextStyle, patch: Partial<TextStyle>): TextStyle {
  const out: TextStyle = { ...base };
  for (const [key, value] of Object.entries(patch) as [keyof TextStyle, unknown][]) {
    if (value === undefined) continue;
    switch (key) {
      case 'font':
        if (!FONTS.includes(value as string)) throw new ValidationError('invalid_style', 'Tipografía no válida.');
        out.font = value as TextStyle['font']; break;
      case 'align':
        if (!ALIGNS.includes(value as string)) throw new ValidationError('invalid_style', 'Alineación no válida.');
        out.align = value as TextStyle['align']; break;
      case 'size': out.size = value === null ? null : inRange('tamaño', value, 4, 400); break;
      case 'color': case 'stroke_color':
        if (typeof value !== 'string' || !HEX.test(value)) throw new ValidationError('invalid_style', 'Color no válido (usa #rrggbb).');
        out[key] = value.toLowerCase(); break;
      case 'stroke_width': out.stroke_width = inRange('contorno', value, 0, 40); break;
      case 'line_height': out.line_height = inRange('interlineado', value, 0.7, 2.5); break;
      case 'letter_spacing': out.letter_spacing = inRange('espaciado', value, -5, 30); break;
      case 'rotation': out.rotation = inRange('rotación', value, -90, 90); break;
      case 'bold': case 'italic': case 'uppercase': out[key] = !!value; break;
      default: break;
    }
  }
  return out;
}

export interface NewProjectData {
  id: string;
  name: string;
  source_lang: string;
  target_variant: Project['target_variant'];
  reading_direction: Project['reading_direction'];
  direction_auto: boolean;
  honorifics: Project['honorifics'];
  sfx: Project['sfx'];
  translation_profile?: Project['translation_profile'];
  synopsis?: string;
}

export function validateName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text || text.length > 120) throw new ValidationError('invalid_name', 'El nombre debe tener entre 1 y 120 caracteres.');
  return text;
}

export function newProject(d: NewProjectData): Project {
  const synopsis = d.synopsis ?? '';
  if (synopsis.length > 4000) throw new ValidationError('invalid_synopsis', 'La sinopsis es demasiado larga (máximo 4000 caracteres).');
  const t = now();
  return {
    format: FORMAT_VERSION, id: d.id, name: validateName(d.name), created: t, updated: t,
    source_lang: d.source_lang, detected_lang: '', target_variant: d.target_variant,
    reading_direction: d.reading_direction, direction_auto: d.direction_auto, honorifics: d.honorifics, sfx: d.sfx, translation_profile: normalizeProfile(d.translation_profile),
    synopsis, style_notes: '', page_ids: [], characters: [], glossary: [], cover_page_id: null, last_job: null,
  };
}

/** Idioma efectivo del original: el elegido o, en modo automático, el detectado (japonés mientras no se sepa). */
export function effectiveLang(p: Pick<Project, 'source_lang' | 'detected_lang'>): string {
  return p.source_lang !== AUTO_LANG ? p.source_lang : p.detected_lang || 'ja';
}

export function newPage(init: Pick<Page, 'id' | 'index' | 'filename' | 'ext' | 'width' | 'height' | 'sha1' | 'dhash' | 'duplicate_of'>): Page {
  return { ...init, status: 'imported', approved: false, regions: [], panels: [], ocr_engine: '', summary: '', error: '', has_clean: false, updated: now() };
}

export type NewRegion = Pick<Region, 'id' | 'order' | 'kind' | 'bbox' | 'lines' | 'vertical' | 'line_size' | 'bubble' | 'layout_box'
  | 'source_text' | 'ocr_confidence' | 'ocr_engine' | 'max_chars' | 'style' | 'erase' | 'render'>;

/** Región con los valores iniciales de `Region` en Python. */
export function newRegion(init: NewRegion): Region {
  return {
    ocr_fix: '', translation: '', speaker: '', emotion: '', confidence: null, flags: [], note: '', review_note: '', status: 'pending',
    updated: now(), ...init,
  };
}

export function limitText(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

const KINDS: Region['kind'][] = ['dialogue', 'thought', 'narration', 'sfx', 'other'];
const STATUSES: Region['status'][] = ['pending', 'translated', 'review', 'approved', 'edited'];
const isBox = (v: unknown): v is [number, number, number, number] => Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));
/** Un área válida tiene tamaño positivo y coordenadas razonables (las páginas no pasan de unas decenas de miles de píxeles). */
export const toBox = (v: unknown, what: string): [number, number, number, number] => {
  const box = isBox(v) ? (v.map((n) => Math.round(n)) as [number, number, number, number]) : null;
  if (!box || box[2] <= box[0] || box[3] <= box[1] || box.some((n) => Math.abs(n) > 100_000)) {
    throw new ValidationError('invalid_region', `El área «${what}» no es válida.`);
  }
  return box;
};

/** Valida los cambios que llegan desde el editor (equivale a `RegionUpdate` de pydantic en Python). */
export function validateRegionPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    switch (k) {
      case 'kind': if (!KINDS.includes(v as Region['kind'])) throw new ValidationError('invalid_region', 'Tipo de texto no válido.'); out.kind = v; break;
      case 'status': if (!STATUSES.includes(v as Region['status'])) throw new ValidationError('invalid_region', 'Estado no válido.'); out.status = v; break;
      case 'source_text': case 'translation': out[k] = limitText(v, 4000); break;
      case 'speaker': out.speaker = limitText(v, 120); break;
      case 'erase': case 'render': out[k] = !!v; break;
      case 'bbox': case 'layout_box': out[k] = toBox(v, k); break;
      case 'order': if (!Number.isInteger(v) || (v as number) < 0) throw new ValidationError('invalid_region', 'Orden no válido.'); out.order = v; break;
      case 'flags': if (!Array.isArray(v) || v.some((f) => typeof f !== 'string')) throw new ValidationError('invalid_region', 'Marcas no válidas.'); out.flags = (v as string[]).slice(0, 12).map((f) => f.slice(0, 40)); break;
      case 'style': if (typeof v !== 'object') throw new ValidationError('invalid_style', 'Estilo no válido.'); out.style = v; break;
      default: break; // los demás campos los calcula el motor
    }
  }
  return out;
}

/** Región completa recibida del cliente (p. ej. al deshacer un borrado), saneada campo a campo. */
export function sanitizeRegion(raw: Region): Region {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') throw new ValidationError('invalid_region', 'Texto no válido.');
  validateId(raw.id, 'texto');
  const lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 200).map((l) => (Array.isArray(l) ? l.slice(0, 32).map((p) => [Math.round(Number(p[0])), Math.round(Number(p[1]))] as [number, number]) : [])) : [];
  const region = newRegion({
    id: raw.id, order: Number.isInteger(raw.order) ? Math.max(0, raw.order) : 0, kind: KINDS.includes(raw.kind) ? raw.kind : 'other', bbox: toBox(raw.bbox, 'bbox'),
    lines, vertical: !!raw.vertical, line_size: Number.isFinite(raw.line_size) ? raw.line_size : 16, bubble: raw.bubble ?? null,
    layout_box: toBox(raw.layout_box ?? raw.bbox, 'layout_box'), source_text: limitText(raw.source_text, 4000),
    ocr_confidence: Number.isFinite(raw.ocr_confidence) ? raw.ocr_confidence : 0, ocr_engine: limitText(raw.ocr_engine, 40),
    max_chars: Number.isInteger(raw.max_chars) ? Math.max(1, raw.max_chars) : 40, style: mergeStyle(defaultStyle(), raw.style ?? {}),
    erase: raw.erase !== false, render: raw.render !== false,
  });
  region.translation = limitText(raw.translation, 4000);
  region.speaker = limitText(raw.speaker, 120);
  region.emotion = limitText(raw.emotion, 60);
  region.confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null;
  region.flags = Array.isArray(raw.flags) ? raw.flags.filter((f) => typeof f === 'string').slice(0, 12).map((f) => f.slice(0, 40)) : [];
  region.note = limitText(raw.note, 400);
  region.review_note = limitText(raw.review_note, 400);
  region.status = STATUSES.includes(raw.status) ? raw.status : 'pending';
  region.ocr_fix = limitText(raw.ocr_fix, 4000);
  return region;
}

export type { Page, Project, Region };
