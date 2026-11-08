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

/** Dónde se fue el tiempo del análisis de una página (ms). Solo medida: no cambia el resultado. */
export interface AnalysisStats {
  /** Decodificar la imagen. */
  decode_ms: number;
  /** Detector de texto completo (inferencia + posproceso de máscara y cajas). */
  detect_ms: number;
  /** Solo la ejecución del modelo ONNX del detector (suma de tramos). */
  detect_infer_ms: number;
  /** Tramos de 1024 px en que se partió la página (1 = una sola pasada; las páginas alargadas usan varios). */
  detect_tiles: number;
  /** Viñetas y orden de lectura. */
  layout_ms: number;
  /** OCR de todos los bloques. */
  ocr_ms: number;
  /** Bloques de texto leídos. */
  blocks: number;
  /** Codificar la máscara a PNG. */
  encode_ms: number;
  total_ms: number;
}

export interface AnalysisResult {
  regions: Region[];
  panels: BBox[];
  ocrEngine: string;
  /** Máscara de texto (PNG): se guarda para limpiar la página y para recortes manuales. */
  mask: Blob;
  /** Tiempos por etapa (si el motor los mide). */
  stats?: AnalysisStats;
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
  /** Identidad del motor de lectura para ese idioma (forma parte de la clave de la caché de OCR). */
  fingerprint?(lang: string): Promise<string>;
  /** Poca memoria: suelta los modelos grandes opcionales sin detener el trabajo. */
  trim?(): Promise<void>;
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
/** Foto del estado del dispositivo en un instante (batería, temperatura, memoria): solo para medir, no cambia el comportamiento. */
export interface DeviceSample {
  /** Segundos desde 1970. */
  t: number;
  battery_pct: number;
  charging: boolean;
  battery_temp_c: number;
  /** PowerManager.THERMAL_STATUS_*: 0 normal … 6 apagado; -1 desconocido. */
  thermal: number;
  /** Margen térmico previsto (API 30+); -1 o ausente si no se informa. */
  thermal_headroom?: number;
  ram_free_mb: number;
  low_memory: boolean;
}

export interface DeviceGuard {
  check(): Promise<GuardVerdict>;
  /** Estado actual para los informes de rendimiento; `null` si el dispositivo no lo informa. */
  sample?(): Promise<DeviceSample | null>;
  /** Memoria libre ahora (MB) y si el sistema avisa de que falta; `null` si no se conoce. */
  memory?(): Promise<{ free_mb: number; low: boolean } | null>;
}
