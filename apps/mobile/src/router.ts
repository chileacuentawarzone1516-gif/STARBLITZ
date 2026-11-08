/** Enrutado mínimo por hash (funciona igual servido por el motor o empaquetado). */
import { useSyncExternalStore } from 'react';

export interface Route { path: string; parts: string[] }

function read(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const path = raw.split('?')[0];
  return { path, parts: path.split('/').filter(Boolean) };
}

let current = read();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = read();
  listeners.forEach((l) => l());
});

export function navigate(path: string) {
  if (window.location.hash.replace(/^#/, '') !== path) window.location.hash = path;
}

export function useRoute(): Route {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current);
}
