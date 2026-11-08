/**
 * Contrato con el plugin nativo de Android (`StarblitzNativePlugin.java`) y su registro en Capacitor.
 * Todo lo demás del motor depende de esta interfaz, no de Capacitor: así se sustituye por una simulación en las pruebas.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { DeviceStatus } from '../device/guard';

export interface NativeDeviceInfo {
  os: string; model: string; cpu: string; abis: string[]; cores: number; ram_mb: number; free_bytes: number; total_bytes: number;
  low_ram_device: boolean; debuggable: boolean;
}

export interface NativeDownloadArgs {
  id: string; url: string; path: string; headers?: Record<string, string>; expectedSize?: number; sha256?: string | null;
}

export interface NativeProgressEvent { id: string; done: number; total: number }
export interface NativeListener { remove(): Promise<void> }

/** Error de Capacitor: `code` es estable (cancelled, not_found, integrity…); `data.log` lleva el registro del motor de lenguaje. */
export interface NativeError extends Error { code?: string; data?: { log?: string[] } }

export interface StarblitzNativePlugin {
  fsStat(a: { path: string }): Promise<{ exists: boolean; isDir: boolean; size: number }>;
  fsList(a: { path: string }): Promise<{ entries: { name: string; isDir: boolean; size: number }[] }>;
  fsRemove(a: { path: string }): Promise<void>;
  fsFreeBytes(): Promise<{ bytes: number }>;
  fsSha256(a: { path: string }): Promise<{ sha256: string }>;
  fsWriteText(a: { path: string; text: string }): Promise<void>;
  fsReadText(a: { path: string }): Promise<{ text?: string }>;
  fsAbsolutePath(a: { path: string }): Promise<{ path: string }>;
  /** Añade bytes (base64) al final de un archivo de la carpeta privada; `truncate` lo vacía antes. Para exportar archivos grandes por trozos. */
  fsAppendBase64(a: { path: string; data: string; truncate?: boolean }): Promise<{ size: number }>;
  /** Copia un archivo privado a «Descargas/STARBLITZ» con MediaStore (Android 10+, sin permisos). */
  saveToDownloads(a: { path: string; name: string; mime: string }): Promise<{ location: string }>;
  download(a: NativeDownloadArgs): Promise<void>;
  cancelDownload(a: { id: string }): Promise<void>;
  llamaAvailable(): Promise<{ available: boolean }>;
  llamaStart(a: { model: string; args: string[]; timeoutMs?: number }): Promise<{ baseUrl: string; pid: number }>;
  llamaStop(): Promise<void>;
  llamaIsRunning(): Promise<{ running: boolean }>;
  llamaLog(a: { lines: number }): Promise<{ lines: string[] }>;
  deviceInfo(): Promise<NativeDeviceInfo>;
  deviceStatus(): Promise<DeviceStatus>;
  keepAwake(a: { enabled: boolean }): Promise<void>;
  addListener(event: 'downloadProgress', cb: (e: NativeProgressEvent) => void): Promise<NativeListener>;
}

export const isAndroidApp = (): boolean => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

let plugin: StarblitzNativePlugin | null = null;
export function nativePlugin(): StarblitzNativePlugin {
  plugin ??= registerPlugin<StarblitzNativePlugin>('StarblitzNative');
  return plugin;
}
