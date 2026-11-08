/**
 * ONNX Runtime Web (WebAssembly): ejecuta los modelos de visión dentro del propio dispositivo.
 * Sin red: los archivos .wasm van empaquetados con la app (`ort/`) y los modelos se leen del
 * almacenamiento local.
 */
import * as ort from 'onnxruntime-web/wasm';

export type OrtSession = ort.InferenceSession;
export type OrtTensor = ort.Tensor;
export { ort };

let configured = false;

/**
 * Carpeta `ort/` de la app (la crea `vite.config.ts`). Se calcula respecto al script en ejecución para que sirva igual en
 * la página y en el Worker de visión; la ruta no es un literal para que el empaquetador no la trate como un recurso.
 */
function defaultWasmBase(): string {
  if (import.meta.env?.DEV) return '/ort/';
  const rel = '../ort/';
  return new URL(rel, import.meta.url).href;
}

/** Si el motor de WebAssembly no arranca en este tiempo se informa del error en vez de esperar sin fin. */
const INIT_TIMEOUT_MS = 60_000;

export interface OrtOptions {
  /** URL base (con barra final) de `ort-wasm-simd-threaded.{mjs,wasm}`; por defecto, la carpeta `ort/` de la app. */
  wasmBase?: string;
  /** Hilos de WebAssembly; solo >1 si la página está aislada (SharedArrayBuffer). */
  threads?: number;
}

export function configureOrt(opts: OrtOptions): void {
  if (configured) return;
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  ort.env.wasm.wasmPaths = opts.wasmBase ?? defaultWasmBase();
  ort.env.wasm.initTimeout = INIT_TIMEOUT_MS;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(opts.threads ?? 4, navigator.hardwareConcurrency || 2)) : 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  configured = true;
}

export async function createSession(model: Uint8Array | ArrayBuffer): Promise<OrtSession> {
  const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
  });
}

export async function releaseSession(session: OrtSession | null): Promise<void> {
  try { await session?.release(); } catch { /* ya liberada */ }
}

/**
 * Lee los metadatos (`metadata_props`) de un modelo ONNX sin cargarlo: ONNX Runtime Web no los expone
 * y PP-OCR guarda ahí su diccionario de caracteres. El archivo es un `ModelProto`; solo se recorren
 * los campos de primer nivel saltando el grafo.
 */
export function readOnnxMetadata(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder('utf-8');
  let pos = 0;
  const varint = (): number => {
    let result = 0, shift = 0;
    for (;;) {
      const b = bytes[pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
    }
  };
  const readEntry = (start: number, end: number) => {
    let key = '', value = '';
    let p = pos = start;
    while (p < end) {
      const tag = varint();
      const field = tag >>> 3, wire = tag & 7;
      if (wire !== 2) { skip(wire); p = pos; continue; }
      const len = varint();
      const text = dec.decode(bytes.subarray(pos, pos + len));
      pos += len;
      if (field === 1) key = text; else if (field === 2) value = text;
      p = pos;
    }
    if (key) out[key] = value;
  };
  const skip = (wire: number) => {
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) { const len = varint(); pos += len; } // (`pos += varint()` leería `pos` antes de avanzar)
    else throw new Error('Modelo ONNX con formato no reconocido.');
  };
  while (pos < bytes.length) {
    const tag = varint();
    const field = tag >>> 3, wire = tag & 7;
    if (field === 14 && wire === 2) {
      const len = varint();
      const end = pos + len;
      readEntry(pos, end);
      pos = end;
    } else {
      skip(wire);
    }
  }
  return out;
}
