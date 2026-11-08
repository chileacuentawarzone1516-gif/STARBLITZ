/**
 * OCR multilingüe PP-OCR (PaddleOCR) con ONNX Runtime Web. Port de `vision/ocr/ppocr.py` y del
 * preprocesado/decodificación CTC de RapidOCR. El modelo PP-OCRv6 «multi» (≈21 MB) cubre japonés,
 * chino, inglés y la mayoría de idiomas latinos; su diccionario viaja en los metadatos del propio ONNX.
 */
import { scoped, type Cv, type Mat } from '../../runtime/cv';
import { ort, readOnnxMetadata, createSession, releaseSession, type OrtSession } from '../../runtime/ort';
import type { DetectedBlock } from '../types';
import { codePoints, splitLines } from '../text';
import { cropBBox, orderedLines, rot90, warpLine, type OcrEngine, type OcrResult } from './base';

const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const BATCH = 6;
const CJK = new Set(['ja', 'zh', 'zh-hant', 'ko']);
const LANG_TYPE: Record<string, string> = { ja: 'japan', zh: 'ch', 'zh-hant': 'chinese_cht', ko: 'korean' };

export class PaddleOcrEngine implements OcrEngine {
  readonly id: string;

  private constructor(private readonly cv: Cv, private readonly session: OrtSession, private readonly chars: string[],
    private readonly lang: string) {
    this.id = `ppocr-${LANG_TYPE[lang] ?? 'en'}`;
  }

  static async create(cv: Cv, modelBytes: Uint8Array, lang: string): Promise<PaddleOcrEngine> {
    const meta = readOnnxMetadata(modelBytes);
    if (!meta.character) throw new Error('El modelo de OCR no incluye su diccionario de caracteres.');
    // RapidOCR añade «blank» al principio y el espacio al final.
    const chars = ['blank', ...splitLines(meta.character), ' '];
    const session = await createSession(modelBytes);
    return new PaddleOcrEngine(cv, session, chars, lang);
  }

  async dispose(): Promise<void> { await releaseSession(this.session); }

  async recognize(img: Mat, block: DetectedBlock): Promise<OcrResult> {
    const cv = this.cv;
    const crops: Mat[] = [];
    try {
      const lines = block.lines.length ? orderedLines(block) : [];
      if (lines.length) {
        for (const poly of lines) {
          const crop = warpLine(cv, img, poly);
          if (crop.rows >= crop.cols * 1.5) { crops.push(rot90(cv, crop)); crop.delete(); } // columnas verticales
          else crops.push(crop);
        }
      } else {
        const crop = cropBBox(cv, img, block.bbox, 2);
        if (!crop.rows) { crop.delete(); return { text: '', confidence: 0, engine: this.id }; }
        if (block.vertical) { crops.push(rot90(cv, crop)); crop.delete(); } else crops.push(crop);
      }
      const out = await this.recognizeCrops(crops);
      const pairs = out.map((o) => ({ t: o.text.trim(), s: o.score })).filter((p) => p.t);
      if (!pairs.length) return { text: '', confidence: 0, engine: this.id };
      const text = joinLines(pairs.map((p) => p.t), CJK.has(this.lang));
      const weights = pairs.map((p) => codePoints(p.t));
      const total = weights.reduce((a, b) => a + b, 0);
      const conf = pairs.reduce((a, p, i) => a + p.s * weights[i], 0) / total;
      return { text, confidence: conf, engine: this.id };
    } finally {
      for (const c of crops) c.delete();
    }
  }

  /** Reconoce una lista de recortes (BGR). Se agrupan por proporción para limitar el relleno. */
  async recognizeCrops(crops: Mat[]): Promise<{ text: string; score: number }[]> {
    const results: { text: string; score: number }[] = crops.map(() => ({ text: '', score: 0 }));
    const order = crops.map((_, i) => i).sort((a, b) => crops[a].cols / crops[a].rows - crops[b].cols / crops[b].rows);
    for (let beg = 0; beg < order.length; beg += BATCH) {
      const ids = order.slice(beg, beg + BATCH);
      let maxRatio = REC_MIN_WIDTH / REC_HEIGHT;
      for (const i of ids) maxRatio = Math.max(maxRatio, crops[i].cols / crops[i].rows);
      const width = Math.trunc(REC_HEIGHT * maxRatio);
      const plane = REC_HEIGHT * width;
      const tensor = new Float32Array(ids.length * 3 * plane);
      ids.forEach((ci, b) => this.fill(tensor, b * 3 * plane, crops[ci], width));
      const out = await this.session.run({
        [this.session.inputNames[0]]: new ort.Tensor('float32', tensor, [ids.length, 3, REC_HEIGHT, width]),
      });
      const preds = out[this.session.outputNames[0]];
      const [batch, steps, classes] = preds.dims as number[];
      const data = preds.data as Float32Array;
      for (let b = 0; b < batch; b++) results[ids[b]] = this.ctcDecode(data, b * steps * classes, steps, classes);
    }
    return results;
  }

  private fill(tensor: Float32Array, offset: number, crop: Mat, width: number): void {
    const cv = this.cv;
    const ratio = crop.cols / crop.rows;
    const resizedW = Math.ceil(REC_HEIGHT * ratio) > width ? width : Math.ceil(REC_HEIGHT * ratio);
    scoped((s) => {
      const resized = s.add(new cv.Mat());
      cv.resize(crop, resized, new cv.Size(resizedW, REC_HEIGHT), 0, 0, cv.INTER_LINEAR);
      const d = resized.data;
      const plane = REC_HEIGHT * width;
      for (let y = 0; y < REC_HEIGHT; y++) {
        for (let x = 0; x < resizedW; x++) {
          const i = (y * resizedW + x) * 3, o = offset + y * width + x;
          tensor[o] = (d[i] / 255 - 0.5) / 0.5;
          tensor[o + plane] = (d[i + 1] / 255 - 0.5) / 0.5;
          tensor[o + 2 * plane] = (d[i + 2] / 255 - 0.5) / 0.5;
        }
      }
    });
  }

  /** CTC: argmax por instante, sin repetidos consecutivos ni «blank». */
  private ctcDecode(data: Float32Array, offset: number, steps: number, classes: number): { text: string; score: number } {
    let text = '', sum = 0, n = 0, prev = -1;
    for (let t = 0; t < steps; t++) {
      const base = offset + t * classes;
      let best = 0, bestV = data[base];
      for (let c = 1; c < classes; c++) if (data[base + c] > bestV) { bestV = data[base + c]; best = c; }
      if (best !== prev && best !== 0) { text += this.chars[best] ?? ''; sum += bestV; n++; }
      prev = best;
    }
    return { text, score: n ? Math.round((sum / n) * 1e5) / 1e5 : 0 };
  }
}

function joinLines(lines: string[], cjk: boolean): string {
  if (cjk) return lines.join('');
  let out = '';
  for (const t of lines) {
    if (out.endsWith('-') && out.length > 1 && /\p{L}/u.test(out[out.length - 2]) && /^\p{Ll}/u.test(t)) out = out.slice(0, -1) + t; // palabra partida
    else out = out ? `${out} ${t}` : t;
  }
  return out.replace(/\s+/g, ' ').trim();
}
