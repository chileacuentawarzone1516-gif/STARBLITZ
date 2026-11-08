/**
 * Manga OCR (kha-white) en ONNX: codificador ViT + decodificador BERT de caracteres. Port de
 * `vision/ocr/manga_ocr.py`. Reconoce el bloque completo (varias columnas verticales a la vez) con
 * búsqueda por haz: num_beams=4, no_repeat_ngram_size=3, length_penalty=2.0.
 */
import { scoped, type Cv, type Mat } from '../../runtime/cv';
import { ort, createSession, releaseSession, type OrtSession } from '../../runtime/ort';
import type { DetectedBlock } from '../types';
import { splitLines } from '../text';
import { cropBBox, type OcrEngine, type OcrResult } from './base';

const IMAGE_SIZE = 224;

export interface MangaOcrFiles {
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: string;
  generationConfig: string;
}

/** Decodificador abstracto (en producción, ONNX; en las pruebas, un modelo de juguete). */
export type LogitsFn = (sequences: number[][]) => Promise<Float32Array[]>;

export interface BeamConfig {
  startId: number; eosId: number; maxLength: number; noRepeat: number; lengthPenalty: number; numBeams: number;
}

export class MangaOcrEngine implements OcrEngine {
  readonly id = 'manga-ocr';

  private constructor(private readonly cv: Cv, private readonly encoder: OrtSession, private readonly decoder: OrtSession,
    private readonly vocab: string[], private readonly cfg: BeamConfig & { padId: number }) {}

  static async create(cv: Cv, files: MangaOcrFiles): Promise<MangaOcrEngine> {
    const vocab = splitLines(files.vocab);
    if (vocab.length < 1000) throw new Error('El vocabulario de Manga OCR está incompleto. Vuelve a descargar el modelo.');
    const gen = JSON.parse(files.generationConfig) as Record<string, number>;
    const cfg = {
      startId: Number(gen.decoder_start_token_id ?? 2), eosId: Number(gen.eos_token_id ?? 3), padId: Number(gen.pad_token_id ?? 0),
      maxLength: Math.min(Number(gen.max_length ?? 300), 300), noRepeat: Number(gen.no_repeat_ngram_size ?? 3),
      lengthPenalty: Number(gen.length_penalty ?? 2.0), numBeams: 4,
    };
    const [encoder, decoder] = [await createSession(files.encoder), await createSession(files.decoder)];
    return new MangaOcrEngine(cv, encoder, decoder, vocab, cfg);
  }

  async dispose(): Promise<void> {
    await releaseSession(this.encoder);
    await releaseSession(this.decoder);
  }

  async recognize(img: Mat, block: DetectedBlock): Promise<OcrResult> {
    const cv = this.cv;
    const crop = cropBBox(cv, img, block.bbox, Math.max(2, Math.trunc(block.lineSize * 0.15)));
    try {
      if (!crop.rows || !crop.cols) return { text: '', confidence: 0, engine: this.id };
      const pixels = preprocess(cv, crop);
      const enc = await this.encoder.run({ [this.encoder.inputNames[0]]: new ort.Tensor('float32', pixels, [1, 3, IMAGE_SIZE, IMAGE_SIZE]) });
      const hidden = enc[this.encoder.outputNames[0]];
      const [, steps, dim] = hidden.dims as number[];
      const hiddenData = hidden.data as Float32Array;

      const names = this.decoder.inputNames;
      const idsName = names.includes('input_ids') ? 'input_ids' : names.find((n) => n.includes('ids'))!;
      const hiddenName = names.find((n) => n.includes('hidden'))!;
      const maskName = names.find((n) => n.includes('attention_mask'));
      const logits: LogitsFn = async (seqs) => {
        const b = seqs.length, len = seqs[0].length;
        const ids = new BigInt64Array(b * len);
        seqs.forEach((s, i) => s.forEach((t, j) => { ids[i * len + j] = BigInt(t); }));
        const rep = new Float32Array(b * steps * dim);
        for (let i = 0; i < b; i++) rep.set(hiddenData, i * steps * dim);
        const feeds: Record<string, ort.Tensor> = {
          [idsName]: new ort.Tensor('int64', ids, [b, len]),
          [hiddenName]: new ort.Tensor('float32', rep, [b, steps, dim]),
        };
        if (maskName) feeds[maskName] = new ort.Tensor('int64', new BigInt64Array(b * steps).fill(1n), [b, steps]);
        const out = await this.decoder.run(feeds);
        const t = out[this.decoder.outputNames[0]];
        const [, l, vocab] = t.dims as number[];
        const data = t.data as Float32Array;
        return seqs.map((_, i) => data.slice((i * l + (l - 1)) * vocab, (i * l + l) * vocab));
      };
      const { tokens, score } = await beamSearch(logits, this.cfg);
      const text = postProcess(decodeTokens(tokens, this.vocab, new Set([this.cfg.startId, this.cfg.eosId, this.cfg.padId, 1, 4])));
      return { text, confidence: Math.min(1, Math.max(0, Math.exp(score))), engine: this.id };
    } finally {
      crop.delete();
    }
  }
}

function preprocess(cv: Cv, crop: Mat): Float32Array {
  return scoped((s) => {
    const gray = s.add(new cv.Mat());
    cv.cvtColor(crop, gray, cv.COLOR_BGR2GRAY);
    const small = s.add(new cv.Mat());
    cv.resize(gray, small, new cv.Size(IMAGE_SIZE, IMAGE_SIZE), 0, 0, cv.INTER_LINEAR);
    const out = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);
    const n = IMAGE_SIZE * IMAGE_SIZE;
    for (let i = 0; i < n; i++) {
      const v = (small.data[i] / 255 - 0.5) / 0.5;
      out[i] = v; out[n + i] = v; out[2 * n + i] = v;
    }
    return out;
  });
}

export function bannedTokens(seq: number[], n: number): number[] {
  if (n <= 0 || seq.length < n) return [];
  const prefix = n > 1 ? seq.slice(-(n - 1)) : [];
  const banned: number[] = [];
  for (let i = 0; i <= seq.length - n; i++) {
    let same = true;
    for (let k = 0; k < n - 1; k++) if (seq[i + k] !== prefix[k]) { same = false; break; }
    if (same) banned.push(seq[i + n - 1]);
  }
  return banned;
}

/** Búsqueda por haz con las reglas de generación de Hugging Face (penalización de longitud, n-gramas sin repetir). */
export async function beamSearch(logitsFn: LogitsFn, cfg: BeamConfig): Promise<{ tokens: number[]; score: number }> {
  let beams: { seq: number[]; score: number }[] = [{ seq: [cfg.startId], score: 0 }];
  let finished: { seq: number[]; score: number }[] = [];
  for (let step = 0; step < cfg.maxLength - 1; step++) {
    const rows = await logitsFn(beams.map((b) => b.seq));
    const candidates: { seq: number[]; score: number }[] = [];
    beams.forEach((beam, bi) => {
      const row = rows[bi];
      let max = -Infinity;
      for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
      let sum = 0;
      for (let i = 0; i < row.length; i++) sum += Math.exp(row[i] - max);
      const logZ = Math.log(sum);
      const lp = new Float64Array(row.length);
      for (let i = 0; i < row.length; i++) lp[i] = row[i] - max - logZ;
      for (const t of bannedTokens(beam.seq, cfg.noRepeat)) lp[t] = -Infinity;
      const k = Math.min(row.length - 1, cfg.numBeams * 2);
      const top = Array.from(lp.keys()).sort((a, b) => lp[b] - lp[a]).slice(0, k);
      for (const tok of top) if (Number.isFinite(lp[tok])) candidates.push({ seq: [...beam.seq, tok], score: beam.score + lp[tok] });
    });
    candidates.sort((a, b) => b.score - a.score);
    beams = [];
    for (const c of candidates) {
      if (c.seq[c.seq.length - 1] === cfg.eosId) finished.push({ seq: c.seq, score: c.score / (c.seq.length - 1) ** cfg.lengthPenalty });
      else beams.push(c);
      if (beams.length === cfg.numBeams) break;
    }
    if (!beams.length) break;
    if (finished.length >= cfg.numBeams) {
      const bestFinished = Math.max(...finished.map((f) => f.score));
      if (bestFinished > beams[0].score / beams[0].seq.length ** cfg.lengthPenalty) break;
    }
  }
  if (!finished.length) finished = beams.map((b) => ({ seq: b.seq, score: b.score / b.seq.length ** cfg.lengthPenalty }));
  const best = finished.reduce((a, b) => (b.score > a.score ? b : a));
  // Confianza aproximada: log-probabilidad media por token.
  const avg = (best.score * best.seq.length ** cfg.lengthPenalty) / Math.max(1, best.seq.length - 1);
  return { tokens: best.seq, score: avg };
}

export function decodeTokens(tokens: number[], vocab: string[], special: Set<number>): string {
  let out = '';
  for (const t of tokens) {
    if (special.has(t) || t >= vocab.length) continue;
    const piece = vocab[t];
    out += piece.startsWith('##') ? piece.slice(2) : piece;
  }
  return out;
}

/** Mismo post-procesado que manga-ocr: sin espacios, puntos suspensivos y ancho completo. */
export function postProcess(text: string): string {
  let t = text.replace(/\s+/gu, '');
  t = t.replace(/…/g, '...');
  t = t.replace(/[・.]{2,}/gu, (m) => '.'.repeat(Array.from(m).length));
  return Array.from(t).map((c) => {
    const code = c.codePointAt(0)!;
    return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : c;
  }).join('');
}
