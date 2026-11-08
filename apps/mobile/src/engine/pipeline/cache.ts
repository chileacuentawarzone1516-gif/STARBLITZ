/**
 * Cachés de resultados costosos: lectura OCR de una página y respuestas del modelo de lenguaje.
 *
 * Reglas de seguridad (la calidad no se sacrifica por velocidad):
 *  - La clave incluye TODO lo que condiciona el resultado (imagen, idioma, motor, modelo, mensajes completos con el contexto
 *    de la obra): un cambio de contexto es un fallo de caché, nunca un resultado «parecido».
 *  - Solo se guardan resultados completos y sanos (nada vacío ni rechazado por el modelo): un fallo no se «congela».
 *  - Hacer «forzar» o retraducir un texto a propósito se salta la caché (la persona pide un resultado nuevo).
 *  - Tamaño acotado: se descartan las entradas más antiguas.
 */
import type { BBox, Region } from '@starblitz/shared';
import { sha256Hex } from '../platform/sha256';
import type { DocStorage } from '../store/docs';

const enc = new TextEncoder();
export const hashText = (text: string): string => sha256Hex(enc.encode(text));
export const hashBytes = (data: Uint8Array): string => sha256Hex(data);

interface Index { keys: string[] }

/** Almacén clave → documento con límite de entradas (las más antiguas se descartan). */
export class DocCache {
  private index: string[] | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private storage: DocStorage, private prefix: string, private maxEntries: number) {}

  private key(k: string): string { return `${this.prefix}/${k}`; }

  private async loadIndex(): Promise<string[]> {
    if (!this.index) this.index = (await this.storage.getDoc<Index>(`${this.prefix}/_index`))?.keys ?? [];
    return this.index;
  }

  async get<T>(k: string): Promise<T | undefined> {
    try { return await this.storage.getDoc<T>(this.key(k)); } catch { return undefined; }
  }

  async put(k: string, value: unknown): Promise<void> {
    const run = async () => {
      const idx = await this.loadIndex();
      if (!idx.includes(k)) idx.push(k);
      await this.storage.putDoc(this.key(k), value);
      while (idx.length > this.maxEntries) {
        const old = idx.shift()!;
        await this.storage.deleteDoc(this.key(old)).catch(() => undefined);
        await this.storage.deleteBlob(this.key(old) + '.blob').catch(() => undefined);
      }
      await this.storage.putDoc(`${this.prefix}/_index`, { keys: idx });
    };
    this.chain = this.chain.then(run).catch((e) => console.warn('No se pudo guardar en la caché', e));
    return this.chain;
  }

  async putBlob(k: string, blob: Blob): Promise<void> { await this.storage.putBlob(this.key(k) + '.blob', blob); }
  getBlob(k: string): Promise<Blob | undefined> { return this.storage.getBlob(this.key(k) + '.blob'); }

  async clear(): Promise<void> {
    this.index = [];
    this.chain = this.chain.then(() => this.storage.deleteByPrefix(`${this.prefix}/`)).catch(() => undefined);
    await this.chain;
  }
}

/** Resultado de analizar una página, tal como se guarda en la caché de OCR. */
export interface CachedAnalysis { regions: Region[]; panels: BBox[]; ocrEngine: string }

export interface PipelineCaches { ocr: DocCache; translation: DocCache }

export function createCaches(storage: DocStorage, limits = { ocr: 400, translation: 1500 }): PipelineCaches {
  return { ocr: new DocCache(storage, 'cache/ocr', limits.ocr), translation: new DocCache(storage, 'cache/tr', limits.translation) };
}

/** Clave de la lectura OCR de una página: contenido de la imagen + todo lo que cambia el resultado. */
export function analysisKey(i: { sha1: string; lang: string; direction: string; sfx: string; height: number; engine: string }): string {
  return hashText(JSON.stringify(['analysis-v1', i.sha1, i.lang, i.direction, i.sfx, i.height, i.engine]));
}
