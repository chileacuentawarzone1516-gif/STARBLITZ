/**
 * Archivos del dispositivo: el único punto por el que el motor toca el sistema de archivos del teléfono.
 *
 * En la app de Android lo implementa el plugin nativo (descargas reanudables en segundo plano y archivos reales,
 * que `llama-server` necesita); en un navegador, el sistema de archivos privado de origen (OPFS); en las pruebas,
 * una carpeta temporal. Todas las rutas son relativas a la carpeta de datos de la app y se validan aquí: ninguna
 * puede salir de ella.
 */
import { ValidationError } from '../core/errors';

export interface FileStat { exists: boolean; size: number; isDir: boolean }
export interface DirEntry { name: string; size: number; isDir: boolean }

export interface DownloadRequest {
  url: string;
  /** Destino relativo; mientras se descarga existe `<destino>.part` y el nombre final solo aparece con el archivo completo. */
  path: string;
  headers?: Record<string, string>;
  /** Tamaño esperado en bytes (0 si no se conoce). */
  expectedSize?: number;
  /** Huella SHA-256 esperada (hexadecimal) o `null`. */
  sha256?: string | null;
}

export interface DownloadHooks {
  onProgress?(done: number, total: number): void;
  /** Cancelar conserva el `.part`: la siguiente descarga continúa donde se quedó. */
  signal?: AbortSignal;
}

export interface DeviceFiles {
  stat(path: string): Promise<FileStat>;
  list(dir: string): Promise<DirEntry[]>;
  /** Contenido completo (modelos de visión de hasta unos cientos de MB). */
  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  /** Borra un archivo o una carpeta entera; no falla si no existe. */
  remove(path: string): Promise<void>;
  /** Espacio libre para datos de la app, en bytes. */
  freeBytes(): Promise<number>;
  sha256(path: string): Promise<string>;
  /** Descarga reanudable con verificación de tamaño y SHA-256. */
  download(req: DownloadRequest, hooks?: DownloadHooks): Promise<void>;
  /** Ruta absoluta en el sistema de archivos del teléfono (la necesita `llama-server`); `null` si no hay. */
  absolutePath(path: string): Promise<string | null>;
}

const SEGMENT = /^[\w][\w .()+@=,-]*$/;

/** Normaliza una ruta relativa y rechaza `..`, rutas absolutas y caracteres raros. */
export function safePath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || path.startsWith('/') || parts.some((p) => p === '..' || !SEGMENT.test(p))) {
    throw new ValidationError('invalid_path', 'Ruta de archivo no válida.');
  }
  return parts.join('/');
}

export const joinPath = (...parts: string[]): string => parts.join('/');
