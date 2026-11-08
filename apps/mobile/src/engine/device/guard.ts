/**
 * Guarda del dispositivo: antes de cada paso pesado mira la batería, la temperatura, la memoria y el espacio libre.
 * Un teléfono que se calienta reduce su velocidad por sí solo y una batería agotada pierde el trabajo en curso, así que
 * es mejor frenar a tiempo: esperar a que se enfríe, o pausar (el progreso queda guardado) y avisar con claridad.
 */
import type { DeviceGuard, GuardVerdict } from '../pipeline/ports';

/** Estado que cambia mientras se trabaja (lo entrega el plugin nativo). */
export interface DeviceStatus {
  battery_pct: number;       // -1 si no se conoce
  charging: boolean;
  battery_temp_c: number;
  /** PowerManager.THERMAL_STATUS_*: 0 normal · 1 leve · 2 moderado · 3 severo · 4 crítico · 5 emergencia · 6 apagado; -1 desconocido. */
  thermal: number;
  power_save: boolean;
  ram_free_mb: number;
  low_memory: boolean;
}

export interface GuardLimits {
  /** Por debajo de este % de batería, sin cargador, se pausa. */
  minBatteryPct: number;
  /** Espacio libre mínimo para seguir guardando páginas (bytes). */
  minFreeBytes: number;
  /** Temperatura de la batería a partir de la cual se espera (°C) y a partir de la cual se pausa. */
  coolAboveC: number;
  pauseAboveC: number;
  /** Segundos que se espera entre comprobaciones cuando hay que enfriar. */
  coolWaitMs: number;
}

export const DEFAULT_LIMITS: GuardLimits = { minBatteryPct: 10, minFreeBytes: 200 * 1024 * 1024, coolAboveC: 42, pauseAboveC: 46, coolWaitMs: 20_000 };

export class DeviceStatusGuard implements DeviceGuard {
  constructor(
    private status: () => Promise<DeviceStatus | null>,
    private freeBytes: () => Promise<number>,
    private limits: GuardLimits = DEFAULT_LIMITS,
    /** Se avisa cuando conviene soltar memoria (por ejemplo, descargar el modelo de lenguaje). */
    private onLowMemory?: () => void,
  ) {}

  async check(): Promise<GuardVerdict> {
    const l = this.limits;
    const s = await this.status();
    if (s) {
      if (!s.charging && s.battery_pct >= 0 && s.battery_pct <= l.minBatteryPct) {
        return { action: 'pause', code: 'battery_low', message: `Batería al ${s.battery_pct} %: pausado para no perder el trabajo. Conecta el cargador y pulsa Reanudar.` };
      }
      if (s.thermal >= 4 || s.battery_temp_c >= l.pauseAboveC) {
        return { action: 'pause', code: 'too_hot', message: 'El teléfono está demasiado caliente: pausado. Déjalo enfriar unos minutos y pulsa Reanudar.' };
      }
      if (s.thermal >= 3 || s.battery_temp_c >= l.coolAboveC) {
        return { action: 'wait', code: 'cooling', waitMs: l.coolWaitMs, message: 'El teléfono está caliente: esperando a que se enfríe para seguir…' };
      }
      if (s.low_memory) {
        this.onLowMemory?.();
        return { action: 'wait', code: 'low_memory', waitMs: 4000, message: 'Poca memoria libre: liberando recursos antes de seguir…' };
      }
    }
    if ((await this.freeBytes()) < l.minFreeBytes) {
      return { action: 'pause', code: 'storage_low', message: 'Queda muy poco espacio en el teléfono: pausado. Libera espacio y pulsa Reanudar.' };
    }
    return { action: 'ok' };
  }
}
