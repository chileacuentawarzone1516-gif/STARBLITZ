/**
 * Puente mínimo y tipado entre la interfaz y el proceso principal.
 * La interfaz nunca recibe acceso a Node ni al sistema de archivos.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('starblitz', {
  platform: process.platform,
  engineInfo: () => ipcRenderer.invoke('engine:info'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  openDataDir: (sub?: 'logs') => ipcRenderer.invoke('shell:openDataDir', sub),
  saveFiles: (files: { name: string; data: ArrayBuffer }[], kind: string) => ipcRenderer.invoke('files:save', files, kind),
});
