/**
 * Gobernador de concurrencia: decide, con la RAM del dispositivo y la memoria libre del momento, si se puede analizar la página
 * siguiente (visión: WebAssembly + OCR) MIENTRAS el modelo de lenguaje traduce la actual.
 *
 * Por defecto todo va en serie. El solapamiento solo se permite con mucha RAM, porque ambos procesos compiten por la CPU y por
 * la memoria: en un teléfono de 6–8 GB (como el Redmi Note 8 Pro) el modelo de lenguaje y la visión juntos pueden provocar que
 * Android cierre procesos. Si se activa y luego la memoria libre cae, se vuelve a serie sin interrumpir la tarea.
 * Los umbrales son conservadores y NO se han calibrado con mediciones: la política se decide con datos del dispositivo real.
 */
export interface ConcurrencyInput {
  mobile: boolean;
  ramGb: number;
  /** Memoria libre ahora (MB); `null` si no se conoce. */
  freeMb: number | null;
  /** El dispositivo informó de poca memoria. */
  lowMemory: boolean;
}

export interface ConcurrencyPlan {
  /** Analizar la página siguiente a la vez que se traduce la actual. */
  overlap: boolean;
  reason: string;
}

export const OVERLAP_MIN_RAM_MOBILE_GB = 10.5;  // perfil «high» en móvil
export const OVERLAP_MIN_RAM_DESKTOP_GB = 16;
export const OVERLAP_MIN_FREE_MB = 2500;

export type ConcurrencyPolicy = () => Promise<ConcurrencyPlan>;

export function planConcurrency(i: ConcurrencyInput): ConcurrencyPlan {
  if (i.lowMemory) return { overlap: false, reason: 'poca memoria libre: todo en serie' };
  const min = i.mobile ? OVERLAP_MIN_RAM_MOBILE_GB : OVERLAP_MIN_RAM_DESKTOP_GB;
  if (i.ramGb < min) return { overlap: false, reason: `RAM ${i.ramGb} GB < ${min} GB: todo en serie` };
  if (i.freeMb !== null && i.freeMb < OVERLAP_MIN_FREE_MB) return { overlap: false, reason: `memoria libre ${Math.round(i.freeMb)} MB < ${OVERLAP_MIN_FREE_MB} MB: todo en serie` };
  return { overlap: true, reason: 'RAM suficiente: se analiza la página siguiente mientras se traduce la actual' };
}
