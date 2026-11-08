/**
 * Contratos entre la orquestación (que no sabe nada de imágenes) y las piezas que dependen del dispositivo:
 * visión (OpenCV + ONNX Runtime), biblioteca de modelos de lenguaje y datos del hardware.
 * Así el flujo completo se prueba en Node con piezas simuladas y la visión real se prueba aparte, en Chromium.
 */
import type { BBox, DeviceCaps, Direction, InstalledModel, Region } from '@starblitz/shared';

export interface AnalyzeInput {
  original: Blob;
  lang: string;
  direction: Direction;
  sfx: 'keep' | 'note';
  pageHeight: number;
}

export interface AnalysisResult {
  regions: Region[];
  panels: BBox[];
  ocrEngine: string;
  /** Máscara de texto (PNG): se guarda para limpiar la página y para recortes manuales. */
  mask: Blob;
}

export interface ReadRegionInput {
  original: Blob;
  mask: Blob | null;
  bbox: BBox;
  lang: string;
  sfx: 'keep' | 'note';
  pageHeight: number;
  regionId: string | null;
  order: number;
}

export interface VisionPort {
  /** Detecta los textos de una página, los lee (OCR) y construye sus regiones. */
  analyze(input: AnalyzeInput, signal?: AbortSignal): Promise<AnalysisResult>;
  /** Deduce el idioma de la obra mirando las primeras páginas con texto. */
  detectLanguage(pages: (() => Promise<Blob>)[], signal?: AbortSignal): Promise<string>;
  /** Borra el texto original y reconstruye el fondo; devuelve un PNG. */
  clean(original: Blob, mask: Blob | null, regions: Region[], signal?: AbortSignal): Promise<Blob>;
  /** Página reducida con cada texto numerado en un círculo, para el modelo con visión (JPEG). */
  annotate(original: Blob, boxes: BBox[]): Promise<Uint8Array>;
  /** Vuelve a leer un área (corrige o crea una región dibujada por la persona). */
  readRegion(input: ReadRegionInput): Promise<Region>;
  /** Los ajustes de procesamiento cambiaron. */
  refresh?(): void;
  /** Libera los motores cargados (memoria). */
  dispose?(): Promise<void>;
}

export interface DeviceProvider {
  caps(): Promise<DeviceCaps>;
  readonly mobile: boolean;
}

export interface ModelLibrary {
  installed(): Promise<InstalledModel[]>;
}

/** Veredicto de la guarda del dispositivo antes de cada paso pesado. */
export interface GuardVerdict {
  /** ok: seguir · wait: esperar y volver a mirar (calor, poca memoria) · pause: pausar la tarea hasta que la persona reanude. */
  action: 'ok' | 'wait' | 'pause';
  code?: 'battery_low' | 'too_hot' | 'cooling' | 'storage_low' | 'low_memory';
  message?: string;
  /** Con `wait`: cuánto esperar antes de volver a mirar (ms). */
  waitMs?: number;
}

/** Vigila la batería, la temperatura, la memoria y el espacio durante el procesamiento. */
export interface DeviceGuard {
  check(): Promise<GuardVerdict>;
}
