/** Mensajes entre la página y el hilo de visión (Web Worker). Todo es clonable: Blob, objetos planos y números. */
import type { BBox, Region } from '@starblitz/shared';
import type { AnalysisResult, AnalyzeInput, ReadRegionInput } from '../pipeline/ports';
import type { InpaintMode } from '../render/inpaint';

/** Qué modelos opcionales se pueden usar ahora (instalados y permitidos por el perfil del dispositivo). */
export interface VisionFlags {
  detector: boolean;
  manga: boolean;
  lama: boolean;
  inpaintMode: InpaintMode;
}

export interface VisionConfig {
  /** URL (sin barra final) de la carpeta de modelos instalados: `<base>/<modelo>/<archivo>`. */
  modelsBase: string;
  /** URL del OCR multilingüe incluido en la app. */
  ppocrUrl: string;
  /** URL base de los .wasm de ONNX Runtime (por defecto, junto al código). */
  wasmBase?: string;
  /** Hilos de WebAssembly (solo cuenta si la página está aislada). */
  threads?: number;
}

export type VisionCall =
  | { op: 'configure'; config: VisionConfig; flags: VisionFlags }
  | { op: 'analyze'; input: AnalyzeInput }
  | { op: 'detectLanguage'; count: number }
  | { op: 'clean'; original: Blob; mask: Blob | null; regions: Region[] }
  | { op: 'annotate'; original: Blob; boxes: BBox[] }
  | { op: 'readRegion'; input: ReadRegionInput }
  | { op: 'trim' }
  | { op: 'dispose' };

export type VisionRequest =
  | ({ id: number } & VisionCall)
  | { op: 'cancel'; target: number }
  | { op: 'page'; callId: number; index: number; blob: Blob | null; error?: string };

export interface SerializedError { name: string; message: string; code?: string; status?: number; details?: Record<string, unknown> }

export type VisionReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedError }
  | { op: 'needPage'; callId: number; index: number };

export type VisionResult = {
  configure: void; analyze: AnalysisResult; detectLanguage: string; clean: Blob; annotate: Uint8Array; readRegion: Region; trim: void; dispose: void;
};
