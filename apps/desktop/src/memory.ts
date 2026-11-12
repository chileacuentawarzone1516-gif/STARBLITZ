/** Fusión de la memoria del proyecto (personajes y glosario) al guardar la pestaña «Memoria». */

const keyOf = (e: { source: string }) => e.source.trim().toLowerCase();

/**
 * Lista final al guardar: lo que la persona tiene en la pestaña MÁS lo que la IA añadió en el motor desde que se abrió
 * (`latest` menos `base`), salvo que la persona ya tenga esa entrada. Lo que la persona borró de `base` sigue borrado.
 */
export function mergeMemoryEdits<T extends { source: string }>(edited: T[], base: T[], latest: T[]): T[] {
  const known = new Set([...base, ...edited].map(keyOf));
  const added = latest.filter((e) => e.source.trim() && !known.has(keyOf(e)));
  return [...edited, ...added];
}

/**
 * Estado anterior de una región para DESHACER un cambio del editor. Al cambiar la traducción, el motor y la pantalla pasan
 * la región a «editada»: se guarda también el estado previo para que deshacer lo restaure (antes la región quedaba
 * «editada» para siempre y el procesado y «Retraducir página» se la saltaban).
 */
export function undoSnapshot<R extends object, P extends object>(region: R, patch: P): Partial<R> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(patch);
  if ('translation' in patch && !('status' in patch)) keys.push('status');
  for (const k of keys) out[k] = structuredClone((region as Record<string, unknown>)[k]);
  return out as Partial<R>;
}
