/**
 * Traducción «en texto plano» por lotes de página, para modelos de traducción dedicados (Hy-MT2) y, si se elige, los genéricos.
 *
 * Por qué existe (medido, ver docs/ARQUITECTURA-TRADUCCION.md): el traductor contextual pide al modelo un JSON con muchos campos por
 * texto (hablante, emoción, confianza, notas…), un resumen de página y términos nuevos, tras un prompt de ~1 000 tokens. En una
 * página de 3–4 globos eso son ≈ 1 100 tokens de SALIDA frente a ≈ 100 pidiendo solo la traducción; y generar es lo más lento
 * en un teléfono. Aquí se envía el texto de los globos de la página en UNA llamada y se recupera solo la traducción.
 *
 * Qué NO se sacrifica: el contexto se mantiene (glosario obligatorio de la obra y últimos diálogos ya traducidos), no se omite
 * nada (si el modelo devuelve menos líneas de las pedidas, lo que falta se vuelve a pedir una a una; si sigue sin traducción
 * queda marcado, nunca vacío) y una negativa del modelo no se guarda como traducción (misma regla que el traductor contextual).
 *
 * Qué NO hace (a cambio de velocidad y de que estos modelos no producen metadatos): no aprende personajes ni términos nuevos,
 * no rellena «hablante» ni «emoción» y no usa la imagen. El glosario y los personajes que fije la persona sí se respetan.
 */
import type { GlossaryEntry, Page, Project, Region } from '@starblitz/shared';
import { CancelledError } from '../core/errors';
import { effectiveLang } from '../core/schema';
import { hashText, type DocCache } from '../pipeline/cache';
import { REVIEW_FLAGS, clean, effectiveGlossary, isRefusal, type PageTranslation, type PageTranslator, type TranslateOptions, type TranslatorOptions } from './contextual';
import type { ChatMessage, LLMClient } from './llm';

export type MtFamily = 'hymt' | 'generic';

/** Familia de modelo a partir de su identificador, repositorio o archivo. */
export function mtFamily(text: string): MtFamily {
  if (/hy[-_ ]?mt/i.test(text)) return 'hymt';
  return 'generic';
}

/** ¿Es un modelo de traducción dedicado (usa el formato en texto plano por defecto)? */
export const isDedicatedMt = (text: string): boolean => mtFamily(text) !== 'generic';

const EN_NAMES: Record<string, string> = { ja: 'Japanese', ko: 'Korean', zh: 'Chinese', en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian' };
const ES_NAMES: Record<string, string> = { ja: 'japonés', ko: 'coreano', zh: 'chino', en: 'inglés', es: 'español', fr: 'francés', de: 'alemán', it: 'italiano', pt: 'portugués', ru: 'ruso' };

const GENERIC_SYSTEM = 'Eres un traductor profesional de manga, manhwa y cómics al español. Traduce de forma FIEL y COMPLETA: sin omitir, sin añadir, '
  + 'sin resumir, sin explicar y sin suavizar. Conserva el tono, los insultos, la vulgaridad, el contenido sexual y la violencia tal cual '
  + 'aparecen en el original; no los censures ni los edulcores. Mantén los nombres propios y respeta el glosario si se da. '
  + 'Devuelve únicamente la traducción.';

export interface Pair { source: string; target: string }

export interface PlainInput {
  lang: string;
  texts: string[];
  glossary: Pair[];
  /** Últimos diálogos ya traducidos (más antiguos primero). */
  history: Pair[];
  /** Varias líneas en una llamada (true) o un solo texto (false). */
  batch: boolean;
  /** «es-419» o «es-ES»: solo lo respetan los modelos genéricos; los dedicados traducen a «español» sin variante. */
  variant?: string;
}

export interface PlainRequest { messages: ChatMessage[]; extra: Record<string, unknown>; maxTokens: number }

const numbered = (texts: string[]) => texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');
const maxTokensFor = (texts: string[]) => Math.min(2048, 96 + texts.reduce((n, t) => n + Math.max(24, [...t].length * 3), 0));

/** Construye la petición con el formato nativo de cada familia. */
export function buildPlainRequest(family: MtFamily, i: PlainInput): PlainRequest {
  const maxTokens = maxTokensFor(i.texts);
  if (family === 'hymt') {
    const lang = EN_NAMES[i.lang] ?? i.lang;
    const terms = i.glossary.length ? 'Reference the following translations:\n' + i.glossary.map((g) => `${g.source} translates to ${g.target}`).join('\n') + '\n' : '';
    const user = i.batch
      ? `${terms}Translate each of the following numbered lines from ${lang} into Spanish. Keep the same [n] numbering, one translation per line, `
        + 'and do not merge, skip or add lines. Do not soften or censor any word. Only output the translated result without any additional explanation:\n\n' + numbered(i.texts)
      : `${terms}Translate the following text into Spanish. Note that you should only output the translated result without any additional explanation:\n\n${i.texts[0]}`;
    return { messages: [{ role: 'user', content: user }], maxTokens, extra: {} };
  }
  let system = GENERIC_SYSTEM + (i.variant === 'es-ES' ? ' Usa español de España.' : ' Usa español latino neutro.');
  if (i.glossary.length) system += '\nGlosario obligatorio (usa exactamente estas traducciones):\n' + i.glossary.map((g) => `${g.source} => ${g.target}`).join('\n');
  const from = ES_NAMES[i.lang] ?? i.lang;
  const user = i.batch
    ? `Traduce del ${from} al español. Mantén la numeración [n], una línea por texto, sin unir, omitir ni añadir líneas:\n\n${numbered(i.texts)}`
    : `Traduce del ${from} al español:\n\n${i.texts[0]}`;
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, extra: { chat_template_kwargs: { enable_thinking: false } } };
}

/** Separa la respuesta en `n` traducciones alineadas con las entradas; lo que no se pueda asignar queda vacío (nunca se inventa). */
export function parsePlain(family: MtFamily, content: string, n: number, batch: boolean): string[] {
  const text = (content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!batch || n === 1) return [text];
  void family; // todas las familias admitidas usan la numeración [n]
  const got = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*\[?(\d+)[\]\.\):]\s*(.*)$/.exec(line);
    if (m) got.set(Number(m[1]), m[2].trim());
  }
  return Array.from({ length: n }, (_, k) => got.get(k + 1) ?? '');
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/;

/** Una respuesta solo se guarda en la caché si trae todas las líneas, ninguna vacía y ninguna negativa. */
export function isCacheablePlain(parsed: string[], sources: string[]): boolean {
  return parsed.length === sources.length && parsed.every((p, k) => !!p.trim() && !(isRefusal(p) && !isRefusal(sources[k])));
}

export class PlainTranslator implements PageTranslator {
  readonly stats = { llm_calls: 0, cache_hits: 0 };
  readonly usesImage = false;

  constructor(readonly client: LLMClient, readonly model: string, private family: MtFamily,
              private s: { review_threshold: number; dictionary?: GlossaryEntry[]; target_variant?: string }, private o: TranslatorOptions = {}) {}

  /** Una llamada (o la respuesta guardada si ese mismo mensaje ya se tradujo). Devuelve las traducciones alineadas. */
  private async ask(input: PlainInput, signal?: AbortSignal): Promise<string[]> {
    const req = buildPlainRequest(this.family, input);
    const cache: DocCache | undefined = this.o.cache;
    let key = '';
    if (cache) {
      key = hashText(JSON.stringify(['plain-v1', this.family, this.model, this.o.salt ?? '', req.messages.map((m) => [m.role, m.content]), req.extra, input.batch]));
      const hit = await cache.get<{ content: string }>(key);
      if (hit?.content) {
        const parsed = parsePlain(this.family, hit.content, input.texts.length, input.batch);
        if (isCacheablePlain(parsed, input.texts)) { this.stats.cache_hits += 1; return parsed; }
      }
    }
    if (signal?.aborted) throw new CancelledError();
    this.stats.llm_calls += 1;
    const content = await this.client.chatPlain(req.messages, { model: this.model, temperature: 0, signal, maxTokens: req.maxTokens, extra: req.extra });
    const parsed = parsePlain(this.family, content, input.texts.length, input.batch);
    if (cache && isCacheablePlain(parsed, input.texts)) await cache.put(key, { content });
    return parsed;
  }

  async translatePage(project: Project, page: Page, o: TranslateOptions): Promise<PageTranslation> {
    // Lo que la persona aprobó o editó a mano nunca se vuelve a traducir (mismo criterio que el traductor contextual).
    const targets = page.regions.filter((r) => r.source_text.trim() && r.status !== 'approved' && r.status !== 'edited');
    if (!targets.length) return { updated: [], summary: page.summary, newTerms: [], characters: [], reviewed: 0 };

    const lang = effectiveLang(project);
    const texts = targets.map((r) => r.source_text);
    const glossary = this.relevantGlossary(project, texts, o.prevPage);
    const history = this.history(o.prevPage);
    const base = { lang, glossary, history, variant: project.target_variant };

    let outs: string[] = [];
    let fromFallback = new Set<number>();
    try {
      outs = await this.ask({ ...base, texts, batch: texts.length > 1 }, o.signal);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      console.warn(`Fallo al traducir la página ${page.index + 1} por lotes; se reintenta texto a texto:`, e instanceof Error ? e.message : e);
      outs = Array(texts.length).fill('');
    }
    // Lo que falte (línea ausente o negativa) se vuelve a pedir de uno en uno: nada se omite en silencio.
    for (let k = 0; k < texts.length; k += 1) {
      if (outs[k]?.trim() && !(isRefusal(outs[k]) && !isRefusal(texts[k]))) continue;
      try {
        outs[k] = (await this.ask({ ...base, texts: [texts[k]], batch: false }, o.signal))[0] ?? '';
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        outs[k] = '';
      }
      fromFallback.add(k);
    }

    const updated: Region[] = targets.map((r, k) => this.toRegion(r, outs[k] ?? '', fromFallback.has(k)));
    return { updated, summary: '', newTerms: [], characters: [], reviewed: 0 };
  }

  private toRegion(r: Region, out: string, retried: boolean): Region {
    const region: Region = structuredClone(r);
    const text = clean(out);
    if (!text) {
      region.flags = [...new Set([...region.flags, 'untranslated'])].sort();
      region.status = 'review';
      region.note = region.note || 'El modelo no devolvió traducción para este texto.';
      return region;
    }
    if (isRefusal(text) && !isRefusal(r.source_text)) {
      region.translation = '';
      region.flags = [...new Set([...region.flags, 'refused'])].sort();
      region.status = 'review';
      region.note = 'El modelo se negó a traducir este texto en lugar de traducirlo. Prueba con otro modelo en Modelos o escribe la traducción a mano.';
      return region;
    }
    const flags = new Set<string>();
    let confidence = retried ? 0.75 : 0.8;
    // Caracteres del idioma original en la traducción (un modelo pequeño a veces los deja a medio traducir): a revisión.
    if (CJK.test(text) && !/^[\p{P}\p{S}\s…]*$/u.test(r.source_text)) {
      flags.add('ambiguous');
      confidence = 0.5;
      region.review_note = 'La traducción contiene caracteres del idioma original: revísala.';
    }
    if (r.max_chars && [...text].length > r.max_chars * 1.35) flags.add('too_long');
    region.translation = text;
    region.speaker = '';
    region.emotion = '';
    region.note = '';
    region.confidence = confidence;
    region.flags = [...flags].sort();
    const needsReview = confidence < this.s.review_threshold || [...flags].some((f) => REVIEW_FLAGS.has(f)) || flags.has('too_long');
    region.status = needsReview ? 'review' : 'translated';
    return region;
  }

  /** Glosario obligatorio: del proyecto (y diccionario personal) solo lo que aparece en esta página o en la anterior, más los personajes con nombre fijado. */
  private relevantGlossary(project: Project, texts: string[], prev: Page | null): Pair[] {
    const haystack = [...texts, ...(prev?.regions.map((r) => r.source_text) ?? [])].join(' ');
    const out: Pair[] = [];
    const seen = new Set<string>();
    const add = (source: string, target: string) => {
      const s = source.trim(), t = target.trim();
      if (!s || !t || seen.has(s) || !haystack.includes(s)) return;
      seen.add(s);
      out.push({ source: s, target: t });
    };
    for (const g of effectiveGlossary(project, this.s.dictionary ?? [])) add(g.source, g.target);
    for (const c of project.characters) if (c.target) add(c.source, c.target);
    return out.slice(0, 40);
  }

  /** Últimos diálogos de la página anterior con su traducción (coherencia de nombres y tono entre globos y páginas). */
  private history(prev: Page | null): Pair[] {
    if (!prev) return [];
    return prev.regions.filter((r) => r.source_text.trim() && r.translation.trim() && r.flags.every((f) => !['refused', 'untranslated'].includes(f)))
      .slice(-4).map((r) => ({ source: r.source_text, target: r.translation }));
  }
}
