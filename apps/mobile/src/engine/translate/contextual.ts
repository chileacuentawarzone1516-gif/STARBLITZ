/**
 * Motor de traducción contextual por páginas (equivalente a `translate/contextual.py`).
 *
 * Cada página se traduce con la ficha de la obra (sinopsis, notas de estilo, personajes y glosario), el resumen
 * acumulado de lo ocurrido, la página anterior ya traducida, la siguiente en versión original y la imagen de la
 * página con los textos numerados. En modo «calidad máxima», un segundo pase de corrección editorial revisa
 * fidelidad y naturalidad línea por línea.
 */
import type { Character, GlossaryEntry, Page, Project, Region, Settings } from '@starblitz/shared';
import { CancelledError } from '../core/errors';
import { effectiveLang } from '../core/schema';
import type { ChatMessage, LLMClient } from './llm';
import {
  KIND_LABELS, LANG_NAMES, REFUSAL_PATTERN, REVIEW_SCHEMA, SUMMARY_NOTE, TRANSLATION_SCHEMA, reviewerSystem, translatorSystem,
} from './prompts';

export const REVIEW_FLAGS = new Set(['ambiguous', 'ocr_suspect', 'wordplay', 'refused']);
export const MAX_AUTO_GLOSSARY = 250;

const QUOTES = /^[「『“"']+|[」』”"']+$/g;
const REFUSAL = new RegExp(REFUSAL_PATTERN, 'i');

/** ¿El texto es una negativa del modelo («no puedo ayudar con eso…») en lugar de una traducción? */
export const isRefusal = (text: string): boolean => REFUSAL.test(text);

export interface PageTranslation {
  updated: Region[];
  summary: string;
  newTerms: GlossaryEntry[];
  characters: Character[];
  reviewed: number;
}

type Item = Record<string, unknown>;

export interface TranslateOptions {
  prevPage: Page | null;
  nextPage: Page | null;
  story: string[];
  imageJpeg: Uint8Array | null;
  signal?: AbortSignal;
}

export class ContextualTranslator {
  constructor(readonly client: LLMClient, readonly model: string, private s: Settings['translation']) {}

  async translatePage(project: Project, page: Page, o: TranslateOptions): Promise<PageTranslation> {
    // Lo que la persona aprobó o editó a mano nunca se vuelve a traducir (se usa solo como contexto).
    const targets = page.regions.filter((r) => r.source_text.trim() && r.status !== 'approved' && r.status !== 'edited');
    if (!targets.length) return { updated: [], summary: page.summary, newTerms: [], characters: [], reviewed: 0 };
    const targetIds = new Set(targets.map((r) => r.id));
    const numbering = new Map(page.regions.map((r, i) => [r.id, i + 1]));

    const system = translatorSystem(project.target_variant, project.honorifics, project.translation_profile);
    let user = this.contextBlock(project, page, o.prevPage, o.nextPage, o.story);
    user += `\n\nPÁGINA ACTUAL (${page.index + 1}/${project.page_ids.length}) — textos en orden de lectura:\n`;
    const fixed = page.regions.filter((r) => !targetIds.has(r.id) && r.translation.trim());
    for (const r of page.regions) {
      if (targetIds.has(r.id)) user += `[${numbering.get(r.id)}] (${KIND_LABELS[r.kind] ?? r.kind}, máx. ~${r.max_chars} caracteres) ${r.source_text}\n`;
    }
    if (fixed.length) {
      user += '\nYa traducidos y aprobados por el usuario en esta página (no los cambies, úsalos como contexto):\n';
      for (const r of fixed) user += `[${numbering.get(r.id)}] ${r.source_text} → ${r.translation}\n`;
    }
    if (o.imageJpeg) {
      user += '\nSe adjunta la imagen de la página: cada texto está marcado con su número en un círculo. '
        + 'Úsala para identificar quién habla, a quién y con qué emoción.\n';
    }
    user += `\nDevuelve un elemento en «items» por cada número traducible. En «page_summary»: ${SUMMARY_NOTE}`;

    const result = await this.client.chatJson(
      [{ role: 'system', content: system }, { role: 'user', content: user, images: o.imageJpeg ? [o.imageJpeg] : [] }],
      TRANSLATION_SCHEMA, { model: this.model, signal: o.signal });
    const byN = indexByNumber(result.items);

    const drafts = new Map<string, Item>();
    for (const r of targets) {
      const item = byN.get(numbering.get(r.id)!);
      if (item) drafts.set(r.id, item);
    }

    let reviewed = 0;
    if (this.s.quality === 'max' && drafts.size) {
      reviewed = await this.review(project, page, targets, numbering, drafts,
        this.contextBlock(project, page, o.prevPage, null, o.story, true), o.signal);
    }

    const updated: Region[] = [];
    for (const r of targets) {
      const item = drafts.get(r.id);
      const region: Region = structuredClone(r);
      if (!item || !str(item.translation).trim()) {
        region.flags = sortedUnion(region.flags, ['untranslated']);
        region.status = 'review';
        region.note = region.note || 'El modelo no devolvió traducción para este texto.';
        updated.push(region);
        continue;
      }
      const text = clean(str(item.final || item.translation));
      if (isRefusal(text) && !isRefusal(r.source_text)) {
        // El modelo contestó con una negativa en lugar de traducir: no se guarda como traducción.
        region.translation = '';
        region.flags = sortedUnion(region.flags, ['refused']);
        region.status = 'review';
        region.note = 'El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo en Modelos o escribe la traducción a mano.';
        updated.push(region);
        continue;
      }
      const flags = new Set((Array.isArray(item.flags) ? item.flags : []).filter((f): f is string => typeof f === 'string'));
      const confidence = clamp('confidence' in item ? item.confidence : 0.8);
      region.translation = text;
      region.speaker = cut(str(item.speaker), 80);
      region.emotion = cut(str(item.emotion), 60);
      region.note = cut(str(item.note), 500);
      region.review_note = cut(str(item.issue), 300);
      region.ocr_fix = flags.has('ocr_suspect') ? cut(str(item.source_fix), 400) : '';
      region.confidence = confidence;
      if (r.max_chars && [...text].length > r.max_chars * 1.35) flags.add('too_long');
      region.flags = [...flags].sort();
      const needsReview = confidence < this.s.review_threshold || [...flags].some((f) => REVIEW_FLAGS.has(f)) || flags.has('too_long');
      region.status = needsReview ? 'review' : 'translated';
      updated.push(region);
    }

    const ownTerms = new Set((this.s.dictionary ?? []).map((d) => d.source.toLowerCase())); // ya están en el diccionario personal: no se vuelven a proponer
    const newTerms: GlossaryEntry[] = (Array.isArray(result.new_terms) ? result.new_terms : [])
      .filter(isObj).map((t) => ({ source: str(t.source).trim(), target: str(t.target).trim(), note: cut(str(t.note), 200), locked: false }))
      .filter((t) => t.source && t.target && !ownTerms.has(t.source.toLowerCase()));
    const characters: Character[] = [];
    for (const c of Array.isArray(result.characters) ? result.characters : []) {
      if (!isObj(c) || !str(c.source).trim()) continue;
      const gender = (['m', 'f', 'n', '?'] as const).find((g) => g === c.gender) ?? '?';
      characters.push({ source: cut(str(c.source).trim(), 80), target: cut(str(c.target).trim(), 80), gender, speech: cut(str(c.speech), 200), locked: false });
    }
    return { updated, summary: cut(str(result.page_summary), 600), newTerms, characters, reviewed };
  }

  // ------------------------------------------------------------------
  private async review(project: Project, page: Page, targets: Region[], numbering: Map<string, number>,
                       drafts: Map<string, Item>, userContext: string, signal?: AbortSignal): Promise<number> {
    const system = reviewerSystem(project.target_variant, project.translation_profile);
    const lines: string[] = [];
    for (const r of targets) {
      const d = drafts.get(r.id);
      if (!d) continue;
      const hint = d.speaker ? ` | hablante: ${str(d.speaker)}` : '';
      const emo = d.emotion ? ` | emoción: ${str(d.emotion)}` : '';
      lines.push(`[${numbering.get(r.id)}] (${KIND_LABELS[r.kind] ?? r.kind}, máx. ~${r.max_chars}${hint}${emo})\n`
        + `  ORIGINAL: ${r.source_text}\n  TRADUCCIÓN: ${str(d.translation)}`);
    }
    const user = `${userContext}\n\nREVISA ESTAS LÍNEAS (página ${page.index + 1}):\n${lines.join('\n')}\n\nDevuelve un elemento por línea con la versión final.`;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    let result: Record<string, unknown>;
    try {
      result = await this.client.chatJson(messages, REVIEW_SCHEMA, { model: this.model, temperature: 0.2, signal });
    } catch (e) { // la corrección es una mejora: si falla se conserva el borrador
      if (e instanceof CancelledError) throw e;
      console.warn(`Fallo en la revisión editorial de la página ${page.index + 1}:`, e instanceof Error ? e.message : e);
      return 0;
    }
    const byN = indexByNumber(result.items);
    let changed = 0;
    for (const r of targets) {
      const d = drafts.get(r.id), rev = byN.get(numbering.get(r.id)!);
      if (!d || !rev || !str(rev.final).trim()) continue;
      const final = clean(str(rev.final));
      if (final !== clean(str(d.translation))) {
        changed += 1;
        d.issue = str(rev.issue);
      }
      d.final = final;
      // La confianza final es la más prudente de las dos opiniones.
      d.confidence = Math.min(clamp('confidence' in d ? d.confidence : 0.8), clamp('confidence' in rev ? rev.confidence : 0.8));
    }
    return changed;
  }

  // ------------------------------------------------------------------
  private contextBlock(project: Project, page: Page, prev: Page | null, next: Page | null, story: string[], compact = false): string {
    const lang = effectiveLang(project);
    const parts = [`OBRA: ${project.name}`, `Idioma original: ${LANG_NAMES[lang] ?? lang}`];
    if (project.synopsis.trim()) parts.push(`Sinopsis: ${project.synopsis.trim()}`);
    if (project.style_notes.trim()) parts.push(`Indicaciones del usuario (obligatorias): ${project.style_notes.trim()}`);
    if (project.characters.length) {
      parts.push('PERSONAJES (original → nombre en español; género; forma de hablar):');
      for (const c of project.characters.slice(0, 60)) {
        const g = ({ m: 'masc.', f: 'fem.', n: 'neutro' } as Record<string, string>)[c.gender] ?? '?';
        parts.push(`- ${c.source} → ${c.target || c.source}; ${g}; ${c.speech || '—'}`);
      }
    }
    const glossary = relevantGlossary(project, page, prev, next, this.s.dictionary ?? []);
    if (glossary.length) {
      parts.push('GLOSARIO (obligatorio):');
      for (const g of glossary) parts.push(`- ${g.source} → ${g.target}` + (g.note ? ` (${g.note})` : ''));
    }
    if (story.length) {
      parts.push('LO OCURRIDO HASTA AHORA:');
      for (const s of story.slice(-12)) parts.push(`- ${s}`);
    }
    if (prev?.regions.length) {
      parts.push(`PÁGINA ANTERIOR (${prev.index + 1}), ya traducida:`);
      for (const r of prev.regions.slice(-10)) {
        if (!r.source_text.trim()) continue;
        const who = r.speaker ? `${r.speaker}: ` : '';
        parts.push(`- ${who}${r.source_text} → ${r.translation || '(sin traducir)'}`);
      }
    }
    if (next?.regions.length && !compact) {
      parts.push(`PÁGINA SIGUIENTE (${next.index + 1}), solo como contexto, NO la traduzcas:`);
      for (const r of next.regions.slice(0, 10)) if (r.source_text.trim()) parts.push(`- ${r.source_text}`);
    }
    return parts.join('\n');
  }
}

/** Glosario del proyecto más el diccionario personal; si un término está en ambos, manda el del proyecto. */
export function effectiveGlossary(project: Pick<Project, 'glossary'>, dictionary: GlossaryEntry[]): GlossaryEntry[] {
  const known = new Set(project.glossary.map((g) => g.source.toLowerCase()));
  return [...project.glossary, ...dictionary.filter((d) => !known.has(d.source.toLowerCase()))];
}

function relevantGlossary(project: Project, page: Page, prev: Page | null, next: Page | null, dictionary: GlossaryEntry[]): GlossaryEntry[] {
  const terms = effectiveGlossary(project, dictionary);
  if (terms.length <= 40) return terms;
  const text = [page, prev, next].filter((p): p is Page => !!p).flatMap((p) => p.regions.map((r) => r.source_text)).join(' ');
  return terms.filter((g) => g.locked || text.includes(g.source)).slice(0, 80);
}

/** Incorpora términos y personajes sugeridos sin pisar lo que el usuario fijó. */
export function mergeMemory(project: Project, result: Pick<PageTranslation, 'newTerms' | 'characters'>): void {
  const knownTerms = new Set(project.glossary.map((g) => g.source.toLowerCase()));
  let auto = project.glossary.filter((g) => !g.locked).length;
  for (const t of result.newTerms) {
    if (!knownTerms.has(t.source.toLowerCase()) && auto < MAX_AUTO_GLOSSARY) {
      project.glossary.push(t);
      knownTerms.add(t.source.toLowerCase());
      auto += 1;
    }
  }
  const bySource = new Map(project.characters.map((c) => [c.source.toLowerCase(), c]));
  for (const c of result.characters) {
    const existing = bySource.get(c.source.toLowerCase());
    if (!existing) {
      if (project.characters.length < 80) {
        project.characters.push(c);
        bySource.set(c.source.toLowerCase(), c);
      }
    } else if (!existing.locked) {
      existing.target = existing.target || c.target;
      existing.gender = existing.gender !== '?' ? existing.gender : c.gender;
      existing.speech = existing.speech || c.speech;
    }
  }
}

/** Caracteres que caben con un cuerpo de letra legible (≈ el del original). */
export function estimateMaxChars(box: [number, number, number, number], lineSize: number, pageHeight: number, inBubble: boolean): number {
  const [x1, y1, x2, y2] = box;
  const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
  const font = Math.max(lineSize * 0.8, pageHeight * 0.013, 11.0);
  const fillRatio = inBubble ? 0.62 : 0.8; // los globos elípticos aprovechan menos superficie
  const perLine = Math.max(1.0, (w * 0.9) / (font * 0.55));
  const lines = Math.max(1.0, (h * 0.9) / (font * 1.15));
  return Math.trunc(Math.max(6, Math.min(500, perLine * lines * fillRatio)));
}

// ---------------------------------------------------------------------------

export function clean(text: string): string {
  let t = text.trim().replace(QUOTES, '');
  t = t.replace(/\.\.\./g, '…').replace(/[ \t]+/g, ' ');
  return t.trim();
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const isObj = (v: unknown): v is Item => !!v && typeof v === 'object' && !Array.isArray(v);
/** Recorta por caracteres (no por unidades UTF-16), como hace Python. */
const cut = (s: string, n: number): string => { const a = Array.from(s); return a.length > n ? a.slice(0, n).join('') : s; };
const sortedUnion = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort();

export function clamp(v: unknown): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'boolean') n = v ? 1 : 0;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else n = NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

function indexByNumber(items: unknown): Map<number, Item> {
  const out = new Map<number, Item>();
  for (const it of Array.isArray(items) ? items : []) {
    if (!isObj(it)) continue;
    const n = 'n' in it ? Math.trunc(Number(it.n)) : -1;
    out.set(Number.isFinite(n) ? n : -1, it);
  }
  return out;
}
