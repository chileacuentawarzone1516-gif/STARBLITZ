/**
 * Comprobaciones automáticas de cada traducción (port de `translate/quality.py`; constantes y textos desde `prompts.json`).
 *
 * Origen (capítulo real, 2026-11-09): respuestas asignadas al globo equivocado o inventadas (el modelo traducía la página
 * siguiente), «vosotros» con es-419, nombres propios traducidos y mayúsculas al azar. Reglas generales, sin casos concretos:
 * - `misaligned`: «src_start» (eco de las primeras palabras del original) no se parece al comienzo de ESE texto.
 * - `invented`: traducción desproporcionadamente larga para su original.
 * - `variant`: formas de «vosotros» en una traducción a español latinoamericano.
 * - `name`: un nombre propio conocido desaparece de la traducción.
 */
import type { Character, GlossaryEntry } from '@starblitz/shared';
import raw from './prompts.json';

const Q = raw.quality as {
  echo_words: number; echo_window: number; echo_similarity: number; invented_ratio: number; invented_slack: number;
  cjk: string; cjk_weight: number; vosotros_pattern: string; issue_text: Record<string, string>; missing_text: string; blocking: string[];
  dangling: string[]; source_dangling: string[]; last_word_pattern: string; cut_end_pattern: string;
};

export const ISSUE_TEXT = Q.issue_text;
export const MISSING_TEXT = Q.missing_text;
export const BLOCKING = new Set(Q.blocking);

const VOSOTROS = new RegExp(Q.vosotros_pattern, 'iu');
const WORD = new RegExp(`[A-Z0-9]+|[${Q.cjk}]`, 'gu');
const CJK = new RegExp(`^[${Q.cjk}]$`, 'u');

/** Mayúsculas sin acentos; NFC al final para no deshacer las sílabas coreanas (igual que en Python). */
export const fold = (text: string): string => (text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toUpperCase();

export const words = (text: string): string[] => fold(text).match(WORD) ?? [];

/** 1 − distancia de Levenshtein / longitud mayor. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = Array.from(a), B = Array.from(b);
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] !== B[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return 1 - prev[B.length] / Math.max(A.length, B.length);
}

/** ¿Las palabras copiadas por el modelo son el comienzo de ESTE original? `null` si no copió nada. */
export function echoMatches(source: string, echo: string): boolean | null {
  const e = words(echo).slice(0, Q.echo_words);
  const s = words(source).slice(0, Q.echo_window);
  if (!e.length || !s.length) return null;
  const hits = e.filter((w) => s.some((x) => similarity(w, x) >= Q.echo_similarity)).length;
  return hits * 2 >= e.length;
}

/** Letras y cifras (sin signos); cada carácter CJK cuenta como varias letras latinas. */
export const contentLength = (text: string): number => words(text).reduce((n, w) => n + (CJK.test(w) ? Q.cjk_weight : Array.from(w).length), 0);

export const isInvented = (source: string, translation: string): boolean =>
  contentLength(translation) > contentLength(source) * Q.invented_ratio + Q.invented_slack;

export const hasVosotros = (translation: string): boolean => VOSOTROS.test(translation || '');

/** Nombres conocidos (original → forma en español) presentes en el original y ausentes de la traducción. */
export function lostNames(source: string, translation: string, names: [string, string][]): string[] {
  const src = ` ${words(source).join(' ')} `, out = ` ${words(translation).join(' ')} `;
  const lost: string[] = [];
  for (const [original, target] of names) {
    const o = words(original).join(' ');
    if (Array.from(o).length < 3 || !src.includes(` ${o} `)) continue;
    const forms = [o, words(target).join(' ')].filter(Boolean);
    if (!forms.some((f) => out.includes(` ${f} `))) lost.push(original);
  }
  return lost;
}

/** Si el original está rotulado en MAYÚSCULAS, la traducción también. */
export function matchCase(source: string, translation: string): string {
  const letters = Array.from(source).filter((c) => /\p{L}/u.test(c));
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return letters.length >= 3 && upper >= 0.8 * letters.length ? translation.toUpperCase() : translation;
}

const DANGLING = new Set(Q.dangling);
const SOURCE_DANGLING = new Set(Q.source_dangling);
const LAST_WORD = new RegExp(Q.last_word_pattern, 'u');
const CUT_END = new RegExp(Q.cut_end_pattern, 'u');

/** ¿Acaba el texto en una de esas palabras (sin contar signos)? (port de `ends_dangling`). */
export function endsDangling(text: string, words: Set<string> = DANGLING): boolean {
  const m = LAST_WORD.exec(text || '');
  return !!m && words.has(m[1].toLowerCase());
}

/** La traducción acaba en una palabra funcional y el original no está abierto (port de `is_incomplete`). */
export function isIncomplete(source: string, translation: string): boolean {
  if (!endsDangling(translation)) return false;
  const src = (source || '').trim();
  return !(CUT_END.test(src) || endsDangling(src, SOURCE_DANGLING));
}

/** Sin letras cuando el original las tiene, o «¡»/«¿» de apertura de más (port de `is_garbled`). */
export function isGarbled(source: string, translation: string): boolean {
  const t = translation || '';
  if (contentLength(source) >= 2 && contentLength(t) === 0) return true;
  const count = (c: string) => t.split(c).length - 1;
  return count('¡') > count('!') + 1 || count('¿') > count('?') + 1;
}

export function check(source: string, translation: string, echo: string, variant: string, names: [string, string][]): string[] {
  const issues: string[] = [];
  if (echoMatches(source, echo) === false) issues.push('misaligned');
  if (isInvented(source, translation)) issues.push('invented');
  if (isGarbled(source, translation)) issues.push('garbled');
  if (isIncomplete(source, translation)) issues.push('incomplete');
  // Si el original ya contiene esa forma, es texto copiado (rótulo «SPINF.OS»), no una elección de la traducción.
  if (variant === 'es-419' && hasVosotros(translation) && !hasVosotros(source)) issues.push('variant');
  if (lostNames(source, translation, names).length) issues.push('name');
  return issues;
}

export const describe = (issues: string[], lost: string[]): string =>
  issues.map((i) => ISSUE_TEXT[i].replace('{names}', lost.join(', '))).join('; ');

/** Pares (original, en español) de personajes y glosario que parecen nombres propios (empiezan por mayúscula). */
export function knownNames(characters: Pick<Character, 'source' | 'target'>[], glossary: Pick<GlossaryEntry, 'source' | 'target'>[]): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const item of [...characters, ...glossary]) {
    const src = (item.source || '').trim(), tgt = (item.target || '').trim();
    const first = src.charAt(0);
    if (Array.from(src).length < 3 || !(first === first.toUpperCase() && first !== first.toLowerCase()) || seen.has(src.toUpperCase())) continue;
    seen.add(src.toUpperCase());
    out.push([src, tgt || src]);
  }
  return out;
}
