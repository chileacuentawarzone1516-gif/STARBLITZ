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
import { hashBytes, hashText, type DocCache } from '../pipeline/cache';
import { effectiveLang } from '../core/schema';
import { InvalidJsonError, salvageItems, type ChatMessage, type LLMClient } from './llm';
import {
  ECHO_NOTE, KIND_LABELS, LANG_NAMES, RECOVER, RECOVER_HEADER, RECOVER_NOTE, REFUSAL_PATTERN, REPAIR_HEADER, REVIEW_SCHEMA, SHORTEN,
  SHORTEN_HEADER, SUMMARY_NOTE, TRANSLATION_SCHEMA, reviewerSystem, translatorSystem,
} from './prompts';
import * as quality from './quality';
import { fitChars, regionFits } from './fit';

export const REVIEW_FLAGS = new Set(['ambiguous', 'ocr_suspect', 'wordplay', 'refused', 'variant', 'name']);
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
  /** Textos que necesitaron la llamada de reparación (desalineados, inventados, «vosotros», nombres, sin traducción). */
  repaired?: number;
  /** Respuestas del modelo que no eran JSON válido ni tras su reintento. */
  jsonInvalid?: number;
  /** Textos rescatados de una respuesta rota (completos y con el eco de SU original). */
  salvaged?: number;
  /** Textos recuperados pidiéndolos uno a uno tras una respuesta rota. */
  recovered?: number;
  /** Textos que se quedaron sin traducción por respuestas rotas (conservan el original). */
  jsonLost?: number;
  /** Traducciones sustituidas por una reformulación más corta porque no cabían en su globo. */
  condensed?: number;
}

type JsonStats = { jsonInvalid: number; salvaged: number; recovered: number; condensed: number };

type Item = Record<string, unknown>;

export interface TranslateOptions {
  prevPage: Page | null;
  nextPage: Page | null;
  story: string[];
  imageJpeg: Uint8Array | null;
  signal?: AbortSignal;
}

export interface TranslatorOptions {
  /** Caché de respuestas del modelo (si se omite, no se usa). */
  cache?: DocCache;
  /** Parte de la clave de la caché: proveedor, temperatura, visión… (lo que condiciona la respuesta y no va en los mensajes). */
  salt?: string;
}

/** Una respuesta solo se guarda si está completa y sana: nada vacío ni rechazado por el modelo. */
export function isCacheableResult(kind: 'translate' | 'review', result: Record<string, unknown>, sources: string[]): boolean {
  const items = result.items;
  if (!Array.isArray(items) || !items.length) return false;
  return items.every((it) => {
    if (!isObj(it)) return false;
    const text = str(kind === 'review' ? it.final : it.translation).trim();
    return !!text && !(isRefusal(text) && !sources.some((s) => isRefusal(s)));
  });
}

/** Lo que el procesador necesita de un traductor de páginas (el contextual con JSON o el de texto plano). */
export interface PageTranslator {
  readonly client: LLMClient;
  readonly model: string;
  readonly stats: { llm_calls: number; cache_hits: number };
  /** ¿Usa la imagen de la página? (los traductores de texto plano no: no hace falta prepararla). Por defecto sí. */
  readonly usesImage?: boolean;
  translatePage(project: Project, page: Page, o: TranslateOptions): Promise<PageTranslation>;
}

export class ContextualTranslator implements PageTranslator {
  /** Llamadas reales al modelo y respuestas servidas desde la caché (para medir y para comprobar que no hay llamadas redundantes). */
  readonly stats = { llm_calls: 0, cache_hits: 0 };

  constructor(readonly client: LLMClient, readonly model: string, private s: Settings['translation'], private o: TranslatorOptions = {}) {}

  /** Llama al modelo, o devuelve la respuesta guardada si el MISMO mensaje completo (con todo su contexto) ya se tradujo. */
  private async callJson(kind: 'translate' | 'review', messages: ChatMessage[], schema: object, opts: { model: string; temperature?: number; signal?: AbortSignal; maxTokens?: number }, sources: string[]): Promise<Record<string, unknown>> {
    const cache = this.o.cache;
    let key = '';
    if (cache) {
      key = hashText(JSON.stringify(['tr-v1', kind, this.o.salt ?? '', opts.model, opts.temperature ?? null, opts.maxTokens ?? null,
        messages.map((m) => [m.role, m.content, (m.images ?? []).map((i) => hashBytes(i))])]));
      const hit = await cache.get<Record<string, unknown>>(key);
      if (hit && isCacheableResult(kind, hit, sources)) { this.stats.cache_hits += 1; return structuredClone(hit); }
    }
    this.stats.llm_calls += 1;
    const result = await this.client.chatJson(messages, schema, opts);
    if (cache && isCacheableResult(kind, result, sources)) await cache.put(key, result);
    return result;
  }

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
    user += `\nDevuelve un elemento en «items» por cada número traducible. ${ECHO_NOTE} En «page_summary»: ${SUMMARY_NOTE}`;

    const stats: JsonStats = { jsonInvalid: 0, salvaged: 0, recovered: 0, condensed: 0 };
    let broken = false;
    let result: Record<string, unknown>;
    try {
      result = await this.callJson('translate',
        [{ role: 'system', content: system }, { role: 'user', content: user, images: o.imageJpeg ? [o.imageJpeg] : [] }],
        TRANSLATION_SCHEMA, { model: this.model, signal: o.signal }, targets.map((r) => r.source_text));
    } catch (e) {
      if (!(e instanceof InvalidJsonError)) throw e;
      // Una respuesta ilegible ya no detiene nada: se rescatan los textos completos que sí llegaron y el resto se pide uno a uno.
      console.warn(`Página ${page.index + 1}: respuesta JSON inválida${e.truncated ? ' (cortada por el tope de tokens)' : ''}; se recupera por textos.`);
      broken = true;
      stats.jsonInvalid += 1;
      result = { items: salvageItems(e.raws), new_terms: [], characters: [], page_summary: '' };
    }
    const byN = indexByNumber(result.items);

    const drafts = new Map<string, Item>();
    for (const r of targets) {
      const item = byN.get(numbering.get(r.id)!);
      // De una respuesta rota solo vale un texto con el eco de SU original (la estructura ya no garantiza el orden).
      if (item && (!broken || quality.echoMatches(r.source_text, str(item.src_start)) === true)) drafts.set(r.id, item);
    }
    stats.salvaged = broken ? drafts.size : 0;

    const names = quality.knownNames(project.characters, effectiveGlossary(project, this.s.dictionary ?? []));
    const compact = this.contextBlock(project, page, o.prevPage, null, o.story, true);
    let tried = new Set<string>();
    if (broken) {
      tried = await this.recover(project, page, targets.filter((r) => !drafts.has(r.id)), numbering, drafts, names, system, compact, o.signal, stats);
    }
    const repaired = await this.repair(project, page, targets.filter((r) => !tried.has(r.id)), numbering, drafts, names, system,
      compact, o.signal, stats);

    let reviewed = 0;
    if (this.s.quality === 'max' && drafts.size) {
      reviewed = await this.review(project, page, targets, numbering, drafts,
        this.contextBlock(project, page, o.prevPage, null, o.story, true), o.signal, stats);
    }
    await this.shorten(project, page, targets, numbering, drafts, names, compact, o.signal, stats);

    const updated: Region[] = [];
    for (const r of targets) {
      const item = drafts.get(r.id);
      const region: Region = structuredClone(r);
      if (!item || !str(item.translation).trim()) {
        region.flags = sortedUnion(region.flags, ['untranslated']);
        region.status = 'review';
        region.note = tried.has(r.id)
          ? 'El modelo devolvió una respuesta ilegible y este texto no se pudo recuperar: se conserva el original. Vuelve a traducirlo o escríbelo a mano.'
          : region.note || 'El modelo no devolvió traducción para este texto.';
        updated.push(region);
        continue;
      }
      let text = clean(str(item.final || item.translation));
      const issues = quality.check(r.source_text, text, str(item.src_start), project.target_variant, names);
      const blocking = issues.filter((i) => quality.BLOCKING.has(i));
      if (blocking.length) {
        // Ni tras la reparación es la traducción de ESTE texto: no se usa (el original se conserva en el dibujo).
        region.translation = '';
        region.flags = sortedUnion(region.flags, ['untranslated', ...blocking]);
        region.status = 'review';
        region.note = 'La traducción del modelo no correspondía a este texto (desalineada o inventada); tradúcelo a mano.';
        updated.push(region);
        continue;
      }
      text = quality.matchCase(r.source_text, text);
      if (isRefusal(text) && !isRefusal(r.source_text)) {
        // El modelo contestó con una negativa en lugar de traducir: no se guarda como traducción.
        region.translation = '';
        region.flags = sortedUnion(region.flags, ['refused']);
        region.status = 'review';
        region.note = 'El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo en Modelos o escribe la traducción a mano.';
        updated.push(region);
        continue;
      }
      const flags = new Set([...(Array.isArray(item.flags) ? item.flags : []).filter((f): f is string => typeof f === 'string'), ...issues]);
      const confidence = clamp('confidence' in item ? item.confidence : 0.8);
      region.translation = text;
      region.speaker = cut(str(item.speaker), 80);
      region.emotion = cut(str(item.emotion), 60);
      region.note = cut(str(item.note), 500);
      region.review_note = cut(str(item.issue), 300);
      region.ocr_fix = flags.has('ocr_suspect') ? cut(str(item.source_fix), 400) : '';
      if (item.condensed_from) {
        flags.add('condensed');
        const full = `Versión completa (no cabía en el globo): ${str(item.condensed_from)}`;
        region.note = cut(region.note ? `${region.note} · ${full}` : full, 500);
      }
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
    const jsonLost = targets.filter((r) => tried.has(r.id) && !drafts.has(r.id)).length;
    return {
      updated, summary: cut(str(result.page_summary), 600), newTerms, characters, reviewed, repaired,
      jsonInvalid: stats.jsonInvalid, salvaged: stats.salvaged, recovered: stats.recovered, jsonLost, condensed: stats.condensed,
    };
  }

  // ------------------------------------------------------------------
  /**
   * Reformulación breve de las traducciones que no caben en su globo (port de `_shorten`): una sola llamada por página; la versión
   * corta solo sustituye a la anterior si es de verdad más corta, conserva la mayor parte del contenido, no pierde nombres y no
   * tiene problemas nuevos. La versión completa queda en la nota y se marca «condensed».
   */
  private async shorten(project: Project, page: Page, targets: Region[], numbering: Map<string, number>, drafts: Map<string, Item>,
                        names: [string, string][], userContext: string, signal: AbortSignal | undefined, stats: JsonStats): Promise<void> {
    const longOnes: [Region, string, number][] = [];
    for (const r of targets) {
      const d = drafts.get(r.id);
      if (!d) continue;
      const text = clean(str(d.final || d.translation));
      if (!text || isRefusal(text)) continue;
      const shown = quality.matchCase(r.source_text, text); // se rotula con las mayúsculas del original
      if (regionFits(r, shown, page.height)) continue;
      const target = fitChars(r, shown, page.height);
      // Si cabe menos del mínimo de contenido que se exige, acortarlo sería resumirlo: no se pide (se conserva el original).
      if (target >= [...text].length * SHORTEN.min_keep) longOnes.push([r, text, target]);
    }
    if (!longOnes.length) return;
    const system = reviewerSystem(project.target_variant, project.translation_profile);
    const lines = longOnes.map(([r, text, target]) => `[${numbering.get(r.id)}] (máx. ~${target} caracteres; ahora ${[...text].length})\n  ORIGINAL: ${r.source_text}\n  TRADUCCIÓN: ${text}`);
    const user = `${userContext}\n\n${SHORTEN_HEADER.replace('{page}', String(page.index + 1))}\n${lines.join('\n')}\n\nDevuelve un elemento por línea con la versión final.`;
    let result: Record<string, unknown>;
    try {
      result = await this.callJson('review', [{ role: 'system', content: system }, { role: 'user', content: user }], REVIEW_SCHEMA,
        { model: this.model, temperature: 0.2, signal }, longOnes.map(([r]) => r.source_text));
    } catch (e) { // acortar es una mejora: si falla se conserva la traducción completa
      if (e instanceof CancelledError) throw e;
      if (e instanceof InvalidJsonError) stats.jsonInvalid += 1;
      console.warn(`Fallo al acortar textos de la página ${page.index + 1}:`, e instanceof Error ? e.message : e);
      return;
    }
    const byN = indexByNumber(result.items);
    for (const [r, text] of longOnes) {
      const it = byN.get(numbering.get(r.id)!);
      const short = it ? clean(str(it.final)) : '';
      if (!acceptableShort(r.source_text, text, short, project.target_variant, names)) continue;
      if (!regionFits(r, quality.matchCase(r.source_text, short), page.height)) continue; // más corta pero sigue sin caber
      const d = drafts.get(r.id)!;
      d.final = short;
      d.condensed_from = text;
      stats.condensed += 1;
    }
  }

  // ------------------------------------------------------------------
  /**
   * Tras una respuesta rota, pide cada texto que faltó por separado (port de `_recover`): `RECOVER.attempts` intentos con un tope de
   * tokens bajo; se acepta solo un elemento con SU número, traducción no vacía y sin problemas que impidan usarla. Devuelve los
   * ids intentados: no vuelven a la llamada de reparación (los reintentos están acotados).
   */
  private async recover(project: Project, page: Page, missing: Region[], numbering: Map<string, number>, drafts: Map<string, Item>,
                        names: [string, string][], system: string, userContext: string, signal: AbortSignal | undefined,
                        stats: JsonStats): Promise<Set<string>> {
    const tried = new Set<string>();
    for (const r of missing.slice(0, RECOVER.max_segments)) {
      tried.add(r.id);
      const n = numbering.get(r.id)!;
      const user = `${userContext}\n\n${RECOVER_HEADER.replace('{page}', String(page.index + 1))}\n`
        + `[${n}] (${KIND_LABELS[r.kind] ?? r.kind}, máx. ~${r.max_chars} caracteres) ${r.source_text}\n`
        + `\n${RECOVER_NOTE.replace('{n}', String(n)).replace('{echo}', ECHO_NOTE)}`;
      for (let attempt = 0; attempt < RECOVER.attempts; attempt++) {
        let items: Item[];
        try {
          const res = await this.callJson('translate', [{ role: 'system', content: system }, { role: 'user', content: user }],
            TRANSLATION_SCHEMA, { model: this.model, signal, maxTokens: RECOVER.max_tokens }, [r.source_text]);
          items = (Array.isArray(res.items) ? res.items : []).filter(isObj);
        } catch (e) {
          if (!(e instanceof InvalidJsonError)) throw e;
          stats.jsonInvalid += 1;
          items = salvageItems(e.raws);
        }
        const item = items.find((it) => typeof it.n === 'number' && Number.isInteger(it.n) && it.n === n);
        if (!item || !str(item.translation).trim()) continue;
        const issues = quality.check(r.source_text, clean(str(item.translation)), str(item.src_start), project.target_variant, names);
        if (issues.some((i) => quality.BLOCKING.has(i))) continue;
        drafts.set(r.id, item);
        stats.recovered += 1;
        break;
      }
    }
    return tried;
  }

  // ------------------------------------------------------------------
  /**
   * Una sola llamada para los textos con problemas. La respuesta nueva solo sustituye a la anterior si ya no tiene problemas
   * que impidan usarla. Devuelve cuántos textos se pidieron de nuevo (igual que `_repair` en Python).
   */
  private async repair(project: Project, page: Page, targets: Region[], numbering: Map<string, number>, drafts: Map<string, Item>,
                       names: [string, string][], system: string, userContext: string, signal?: AbortSignal, stats?: JsonStats): Promise<number> {
    const bad: [Region, string][] = [];
    for (const r of targets) {
      const d = drafts.get(r.id);
      if (!d || !str(d.translation).trim()) { bad.push([r, quality.MISSING_TEXT]); continue; }
      const text = clean(str(d.translation));
      const issues = quality.check(r.source_text, text, str(d.src_start), project.target_variant, names);
      if (issues.length) bad.push([r, quality.describe(issues, quality.lostNames(r.source_text, text, names))]);
    }
    if (!bad.length) return 0;
    let user = `${userContext}\n\n${REPAIR_HEADER.replace('{page}', String(page.index + 1))}\n`;
    for (const [r, problem] of bad) {
      user += `[${numbering.get(r.id)}] (${KIND_LABELS[r.kind] ?? r.kind}, máx. ~${r.max_chars} caracteres) ${r.source_text}\n`;
      user += `  Problema: ${problem}\n`;
    }
    user += `\nDevuelve un elemento en «items» por cada número de esta lista. ${ECHO_NOTE} En «page_summary» deja una cadena vacía.`;
    let result: Record<string, unknown>;
    let strict = false;
    try {
      result = await this.callJson('translate', [{ role: 'system', content: system }, { role: 'user', content: user }],
        TRANSLATION_SCHEMA, { model: this.model, signal }, bad.map(([r]) => r.source_text));
    } catch (e) { // la reparación es una mejora: si falla, deciden las comprobaciones finales
      if (e instanceof CancelledError) throw e;
      if (e instanceof InvalidJsonError) { // respuesta rota: se aprovecha lo completo que traiga el eco de SU original
        if (stats) stats.jsonInvalid += 1;
        result = { items: salvageItems(e.raws) };
        strict = true;
      } else {
        console.warn(`Fallo en la reparación de la página ${page.index + 1}:`, e instanceof Error ? e.message : e);
        return bad.length;
      }
    }
    const byN = indexByNumber(result.items);
    for (const [r] of bad) {
      const it = byN.get(numbering.get(r.id)!);
      if (!it || !str(it.translation).trim()) continue;
      if (strict && quality.echoMatches(r.source_text, str(it.src_start)) !== true) continue;
      const again = quality.check(r.source_text, clean(str(it.translation)), str(it.src_start), project.target_variant, names);
      if (!again.some((i) => quality.BLOCKING.has(i))) drafts.set(r.id, it);
    }
    return bad.length;
  }

  // ------------------------------------------------------------------
  private async review(project: Project, page: Page, targets: Region[], numbering: Map<string, number>,
                       drafts: Map<string, Item>, userContext: string, signal?: AbortSignal, stats?: JsonStats): Promise<number> {
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
      result = await this.callJson('review', messages, REVIEW_SCHEMA, { model: this.model, temperature: 0.2, signal }, targets.map((r) => r.source_text));
    } catch (e) { // la corrección es una mejora: si falla se conserva el borrador
      if (e instanceof CancelledError) throw e;
      if (e instanceof InvalidJsonError && stats) stats.jsonInvalid += 1;
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
  // EXACTAMENTE el cuerpo mínimo del maquetador (`sizeBounds`): hasta el 75 % del cuerpo original, entre el 0,5 % y el 0,8 % de la
  // página (antes se tomaba el mayor de los dos y la capacidad salía corta).
  const fixed = Math.max(8.0, pageHeight * 0.0072); // = fit.MIN_FONT_CAP
  const relative = lineSize > 0 ? lineSize * 0.75 : fixed;
  const font = Math.max(8.0, pageHeight * 0.005, Math.min(fixed, relative));
  const fillRatio = inBubble ? 0.62 : 0.8; // los globos elípticos aprovechan menos superficie
  const perLine = Math.max(1.0, (w * 0.9) / (font * 0.55));
  const lines = Math.max(1.0, (h * 0.9) / (font * 1.15));
  return Math.trunc(Math.max(6, Math.min(500, perLine * lines * fillRatio)));
}

// ---------------------------------------------------------------------------

/** ¿La reformulación corta puede sustituir a la traducción? (port de `_acceptable_short`). */
export function acceptableShort(source: string, text: string, short: string, variant: string, names: [string, string][]): boolean {
  if (!short || isRefusal(short) || [...short].length > [...text].length * SHORTEN.max_ratio) return false;
  if (quality.contentLength(short) < quality.contentLength(text) * SHORTEN.min_keep) return false;
  if (quality.endsDangling(short) && !quality.endsDangling(text)) return false; // «Después de usted—» → «Después de—»
  const before = new Set(quality.check(source, text, '', variant, names));
  return quality.check(source, short, '', variant, names).every((i) => before.has(i));
}

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
