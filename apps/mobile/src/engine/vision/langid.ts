/**
 * Detección automática del idioma original (japonés o inglés) a partir de la propia página.
 * Port de `vision/langid.py`: el detector clasifica cada bloque y se confirma leyendo unas líneas con el OCR.
 */
import { blockArea, type DetectedBlock } from './types';

export interface ScriptCounts { kana: number; han: number; hangul: number; latin: number }

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

export function scriptCounts(text: string): ScriptCounts {
  let kana = 0, han = 0, hangul = 0, latin = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    const code = ch.codePointAt(0)!;
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xff66 && code <= 0xff9f)) kana++;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) han++;
    else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) hangul++;
    else if (LATIN.test(ch)) latin++;
  }
  return { kana, han, hangul, latin };
}

/** (idioma, confianza 0–1) según el detector; `null` si no hay texto suficiente. */
export function guessFromBlocks(blocks: DetectedBlock[]): { lang: 'ja' | 'en' | null; confidence: number } {
  let ja = 0, en = 0, n = 0;
  for (const b of blocks) {
    const weight = Math.sqrt(blockArea(b)) * Math.max(b.confidence, 0.2);
    if (b.langHint === 'ja') ja += weight;
    else if (b.langHint === 'eng') en += weight;
    if (b.vertical) ja += weight * 0.5;
    n++;
  }
  const total = ja + en;
  if (n < 2 || total <= 0) return { lang: null, confidence: 0 };
  return ja >= en ? { lang: 'ja', confidence: ja / total } : { lang: 'en', confidence: en / total };
}

/** Idioma según la escritura del texto reconocido; `null` si no es concluyente. */
export function guessFromText(texts: string[]): 'ja' | 'en' | null {
  let k = 0, h = 0, hg = 0, la = 0;
  for (const t of texts) {
    const c = scriptCounts(t);
    k += c.kana; h += c.han; hg += c.hangul; la += c.latin;
  }
  const letters = k + h + hg + la;
  if (letters < 6) return null;
  if ((k + h) / letters >= 0.5 && k > 0) return 'ja';
  if (la / letters >= 0.7) return 'en';
  return null;
}

export const directionFor = (lang: string): 'rtl' | 'ltr' => (['ja', 'zh', 'zh-hant'].includes(lang) ? 'rtl' : 'ltr');
