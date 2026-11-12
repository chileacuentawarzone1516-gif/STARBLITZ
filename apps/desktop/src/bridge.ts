/** Acceso al proceso principal de Electron (o modo navegador para desarrollo y pruebas). */
import type { EngineConnection } from '@starblitz/shared';

export interface EngineInfo { url: string; port: number; token: string; version: string }

export interface DesktopBridge {
  platform: string;
  engineInfo(): Promise<EngineInfo | null>;
  appInfo(): Promise<{ version: string; dataDir: string; platform: string }>;
  openExternal(url: string): Promise<void>;
  openDataDir(sub?: 'logs'): Promise<string>;
  saveFiles(files: { name: string; data: ArrayBuffer }[], kind: string): Promise<{ saved: string[] }>;
  onFlushBeforeClose?(flush: () => Promise<void>): void;
}

export const bridge: DesktopBridge | null = (window as unknown as { starblitz?: DesktopBridge }).starblitz ?? null;

export async function resolveConnection(): Promise<EngineConnection> {
  if (bridge) {
    const info = await bridge.engineInfo();
    if (!info) throw new Error('El motor local no está disponible.');
    return { baseUrl: info.url, token: info.token };
  }
  // Modo navegador: la interfaz la sirve el propio motor; el token llega una vez por la URL.
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || sessionStorage.getItem('sb-token') || '';
  const engine = params.get('engine') || sessionStorage.getItem('sb-engine') || window.location.origin;
  if (params.get('token')) {
    sessionStorage.setItem('sb-token', token);
    sessionStorage.setItem('sb-engine', engine);
    history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
  if (!token) throw new Error('Abre STARBLITZ desde la aplicación de escritorio.');
  return { baseUrl: engine, token };
}

export function openExternal(url: string) {
  if (bridge) bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Guarda archivos exportados: diálogo nativo en escritorio, descarga en navegador. */
export async function saveFiles(files: { name: string; blob: Blob }[], kind: string): Promise<number> {
  if (bridge) {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.blob.arrayBuffer() })));
    const res = await bridge.saveFiles(payload, kind);
    return res.saved.length;
  }
  for (const f of files) {
    const url = URL.createObjectURL(f.blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return files.length;
}
