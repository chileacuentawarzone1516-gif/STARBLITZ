/**
 * Catálogo de modelos de traducción, perfiles de rendimiento y compatibilidad con el dispositivo.
 *
 * Es el equivalente en TypeScript de `engine/starblitz_engine/llm/catalog.py` (la fuente de verdad): los datos se
 * generan con `tools/export_llm_catalog.py` y `test/llm.test.ts` comprueba que ambas implementaciones coinciden.
 * Lo usa el motor de Android, que decide por sí mismo qué modelo le conviene al teléfono.
 */
import raw from './catalog.json';
import type { Fit, LicenseInfo, PerformanceProfile, Tier } from '../types';

const GIB = 1024 ** 3;

export interface CuratedModel {
  id: string; label: string; family: string; params_b: number; active_b: number; repo: string; file: string; size: number;
  mmproj: string | null; mmproj_size: number; quant: string; license: string; context_native: number; tiers: Tier[];
  summary: string; languages: string; tags: string[]; arch: string;
}

export const CATALOG = raw.models as CuratedModel[];
export const PROFILES = raw.profiles as Record<Tier, PerformanceProfile>;
const ARCH_KV_FACTOR = raw.arch_kv_factor as Record<string, number>;

/** Perfil de un dispositivo a partir de su memoria (móvil: RAM total que informa Android; PC: VRAM o RAM). */
export function classify(ramGb: number, vramGb: number, mobile = false): Tier {
  if (mobile) return ramGb >= 10.5 ? 'high' : ramGb >= 6.5 ? 'mid' : 'low';
  if (vramGb >= 5.5) return 'pc-gpu';
  if (ramGb >= 24) return 'high';
  if (ramGb >= 11) return 'mid';
  return 'low';
}

/** Modelo recomendado para un perfil; en PC con mucha VRAM sube de escalón. */
export function pickDefault(tier: Tier, vramGb = 0): string {
  if (tier === 'pc-gpu') {
    if (vramGb >= 18) return 'gemma4-26b-a4b-qat';
    if (vramGb >= 10) return 'gemma4-12b-qat';
  }
  return PROFILES[tier].default_model;
}

/** Memoria necesaria: pesos + caché KV (proporcional a parámetros y contexto) + búferes. */
export function estimateMemoryGb(sizeBytes: number, paramsB: number, context: number, mmprojBytes = 0, arch = ''): number {
  const kv = (context / 1000) * 0.018 * Math.max(paramsB, 0.5) * (ARCH_KV_FACTOR[arch] ?? 1.0);
  return sizeBytes / GIB + kv + mmprojBytes / GIB + 0.6;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** ¿Cabe y con qué velocidad? */
export function fitModel(needGb: number, ramGb: number, vramGb: number, mobile = false): Fit {
  const reserve = mobile ? 2.5 : 4.0; // sistema operativo, interfaz y modelos de visión
  const usableRam = Math.max(0, ramGb - reserve);
  const base = { need_gb: round1(needGb), tight: false };
  if (!mobile && vramGb > 0 && needGb <= vramGb - 0.4) {
    return { ...base, fits: 'gpu', speed: 'fast', tight: needGb > (vramGb - 0.4) * 0.92, note: 'Cabe entero en la memoria de la GPU: velocidad máxima.' };
  }
  if (!mobile && vramGb >= 3 && needGb <= vramGb + usableRam) {
    return { ...base, fits: 'hybrid', speed: 'medium', note: 'Parte del modelo irá a la RAM del sistema: funciona, pero más lento que en GPU.' };
  }
  if (needGb <= usableRam) {
    const slow = needGb > 3.5;
    const where = mobile ? 'el procesador del teléfono' : 'el procesador';
    return { ...base, fits: 'cpu', speed: slow ? 'slow' : 'medium', tight: needGb > usableRam * 0.85,
      note: `Se ejecutará en ${where}` + (slow ? ': cada página tardará varios minutos.' : '.') };
  }
  const have = usableRam + (mobile ? 0 : Math.max(vramGb, 0));
  return { ...base, fits: 'no', speed: 'none', note: `Necesita ~${needGb.toFixed(1)} GB y este dispositivo dispone de ~${have.toFixed(1)} GB utilizables.` };
}

const PERMISSIVE = ['apache-2.0', 'mit', 'bsd-3-clause', 'bsd-2-clause', 'isc', 'unlicense', 'cc0-1.0', 'cc-by-4.0', 'openrail++'];
const WITH_TERMS = ['gemma', 'llama', 'openrail', 'bigscience', 'cc-by-sa', 'mistral', 'other', 'creativeml', 'deepseek', 'qwen'];
const RESTRICTED = ['nc', 'research', 'non-commercial', 'noncommercial'];

export function licenseInfo(licenseId: string): LicenseInfo {
  const lic = (licenseId || '').toLowerCase().trim();
  if (!lic || lic === 'desconocida') {
    return { id: licenseId || 'desconocida', class: 'unknown', note: 'El repositorio no declara su licencia: revisa la ficha del modelo antes de usarlo.' };
  }
  if (RESTRICTED.some((k) => lic.includes(k))) {
    return { id: licenseId, class: 'restricted', note: 'Licencia con restricciones (p. ej. no comercial o solo investigación). Válida para uso personal; no para publicar de forma comercial.' };
  }
  if (PERMISSIVE.includes(lic)) return { id: licenseId, class: 'permissive', note: 'Licencia permisiva: uso libre, también comercial.' };
  if (WITH_TERMS.some((k) => lic.includes(k))) {
    return { id: licenseId, class: 'terms', note: 'Pesos abiertos con condiciones de uso propias del autor: lee los términos en su ficha.' };
  }
  return { id: licenseId, class: 'unknown', note: 'Licencia poco habitual: revisa la ficha del modelo.' };
}

export { GIB };
