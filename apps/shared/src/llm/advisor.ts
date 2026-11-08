/** Asesor de modelos del dispositivo (equivalente a `llm/advisor.py`): perfil, recomendación y compatibilidad. */
import type { CatalogModel, DeviceCaps, InstalledModel, ModelAdvice, PerformanceProfile, Tier } from '../types';
import { CATALOG, PROFILES, classify, estimateMemoryGb, fitModel, pickDefault } from './catalog';

export const VISION_RESERVE_GB = 1.2;

export function currentProfile(caps: Pick<DeviceCaps, 'ram_gb' | 'vram_gb'>, override: 'auto' | Tier = 'auto', mobile = false): PerformanceProfile {
  if (override !== 'auto' && PROFILES[override]) return PROFILES[override];
  return PROFILES[classify(caps.ram_gb, caps.vram_gb, mobile)];
}

/** Ventana de contexto con la que se carga el modelo: nunca más de lo que el perfil aguanta ni el modelo admite. */
export function effectiveContext(profile: PerformanceProfile, configured: number, native = 0): number {
  let ctx = Math.min(configured, profile.context);
  if (native) ctx = Math.min(ctx, native);
  return Math.max(2048, ctx);
}

export function fitFor(model: Pick<InstalledModel, 'size' | 'params_b' | 'arch'>, caps: DeviceCaps, context: number, mobile = false) {
  const need = estimateMemoryGb(model.size, model.params_b || 4.0, context, 0, model.arch);
  const vram = caps.vram_gb > 0 ? Math.max(0, caps.vram_gb - VISION_RESERVE_GB) : 0;
  return fitModel(need, caps.ram_gb, vram, mobile);
}

/** Modelo a usar: el elegido si está instalado; si no, el instalado que mejor encaja con el dispositivo. */
export function resolveModel(installed: InstalledModel[], wanted: string, caps: DeviceCaps, override: 'auto' | Tier = 'auto', mobile = false) {
  const hit = installed.find((m) => m.id === wanted);
  if (hit || !installed.length) return hit ?? null;
  const profile = currentProfile(caps, override, mobile);
  const target = pickDefault(profile.id, caps.vram_gb);
  return [...installed].sort((a, b) =>
    Number(a.id !== target) - Number(b.id !== target)
    || Number(fitFor(a, caps, profile.context, mobile).fits === 'no') - Number(fitFor(b, caps, profile.context, mobile).fits === 'no')
    || b.params_b - a.params_b)[0];
}

export function advise(caps: DeviceCaps, installedIds: string[], activeId: string, override: 'auto' | Tier = 'auto', mobile = false): ModelAdvice {
  const profile = currentProfile(caps, override, mobile);
  const recommended = pickDefault(profile.id, caps.vram_gb);
  const vram = caps.vram_gb > 0 ? Math.max(0, caps.vram_gb - VISION_RESERVE_GB) : 0;
  const options: CatalogModel[] = CATALOG.map((m) => {
    // La parte visual solo se carga si el perfil la usa: no cuenta contra la memoria cuando no se va a emplear.
    const need = estimateMemoryGb(m.size, m.params_b, profile.context, profile.vision_llm ? m.mmproj_size : 0, m.arch);
    return { ...m, fit: fitModel(need, caps.ram_gb, vram, mobile), installed: installedIds.includes(m.id), recommended: m.id === recommended, active: m.id === activeId };
  });
  const best = options.find((o) => o.recommended)!;
  const supported = options.some((o) => o.fit.fits !== 'no');
  const device = mobile ? 'este teléfono' : 'este equipo';
  const reason = best.fit.fits !== 'no'
    ? `Con ${Math.round(caps.ram_gb)} GB de RAM${mobile ? '' : ' y sin GPU dedicada'}, ${best.label} ${profile.id === 'low' ? 'es el más ligero que mantiene una calidad aceptable' : 'se ejecuta en el procesador'}.`
    : `${device[0].toUpperCase()}${device.slice(1)} (${Math.round(caps.ram_gb)} GB de RAM) no tiene memoria suficiente para ejecutar un modelo de traducción local de forma fiable.`;
  return { device: caps, profile, profiles: Object.values(PROFILES), recommended, reason, options, supported };
}
