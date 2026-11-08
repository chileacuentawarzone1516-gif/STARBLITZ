/**
 * Control térmico adaptativo: reparte el trabajo en «ráfagas con descansos» según la presión térmica REAL que informa el sistema, para
 * sostener la velocidad durante un capítulo entero en vez de correr al máximo unos minutos y que Android reduzca la frecuencia.
 *
 * Qué mira (solo lo que el dispositivo expone; no se inventa ninguna temperatura de CPU):
 *   1. Estado térmico de Android (`PowerManager.getCurrentThermalStatus`, API 29+): NONE, LIGHT, MODERATE, SEVERE, CRITICAL… Es la propia
 *      predicción del sistema de que va a recortar rendimiento, no un umbral nuestro.
 *   2. Margen térmico (`getThermalHeadroom`, API 30+): 1,0 equivale al umbral de limitación SEVERA; se usa el tramo 0,5→1,0 como rampa.
 *   3. Sin API térmica (Android 9): SOLO la temperatura de la batería (único sensor accesible) con una rampa de respaldo.
 *
 * Qué hace: mantiene una fracción de descanso `idle` (0 = a pleno rendimiento). Sube deprisa cuando aumenta la presión y baja despacio
 * cuando se relaja (suavizado exponencial asimétrico). Tras cada trozo de trabajo de `w` ms descansa `w·idle/(1−idle)` ms.
 * Con presión crítica pausa hasta que el sistema se recupera. Todo queda contabilizado para el informe.
 *
 * ⚠ HONESTIDAD: la FORMA del control es la razonable (reaccionar a la señal del SO, subir rápido y bajar lento); los PARÁMETROS
 * (`PacerConfig`) son hipótesis NO CALIBRADAS: se calibran con el protocolo del Redmi (docs/VALIDACION-TERMICA-ANDROID.md) mirando las
 * estadísticas que este módulo registra. Mientras no haya medidas no se afirma que evite el throttling.
 */
import type { DeviceSample } from '../pipeline/ports';

export interface PacerConfig {
  /** Fracción máxima de descanso (0,75 = como mucho 3 de cada 4 ms descansando). */
  maxIdle: number;
  /** Rapidez con que sube el descanso cuando aumenta la presión (0–1, por observación). */
  rise: number;
  /** Rapidez con que baja cuando se relaja (más lenta que `rise`: prudencia). */
  fall: number;
  /** Margen térmico a partir del cual empieza la rampa (0,5) y en el que ya es presión máxima (1,0). */
  headroomStart: number;
  headroomFull: number;
  /** Respaldo SOLO sin API térmica: rampa por temperatura de la batería (°C). */
  batteryRampStartC: number;
  batteryRampFullC: number;
  /** Estado del sistema a partir del cual se PAUSA, y estado en el que se reanuda. */
  pauseAtStatus: number;
  resumeAtStatus: number;
  /** Espera entre comprobaciones durante una pausa y tope de una pausa (ms). */
  pausePollMs: number;
  pauseMaxMs: number;
}

export const DEFAULT_PACER: PacerConfig = {
  maxIdle: 0.75, rise: 0.6, fall: 0.15,
  headroomStart: 0.5, headroomFull: 1.0,
  batteryRampStartC: 38, batteryRampFullC: 45,
  pauseAtStatus: 4, resumeAtStatus: 1,
  pausePollMs: 15_000, pauseMaxMs: 10 * 60_000,
};

/** Presión por estado térmico de Android: 0 = nada · 1 = el sistema ya limita con fuerza (se descansa al máximo). */
const STATUS_PRESSURE = [0, 0.25, 0.5, 0.85, 1, 1, 1];

export interface PacerStats {
  /** Qué fuente de temperatura había: «os» (estado térmico de Android), «battery» (solo batería) o «none». */
  source: 'os' | 'battery' | 'none';
  samples: number;
  /** Muestras con estado térmico ≥ MODERATE (2): indicador de limitación en curso (frecuencia de throttling). */
  throttle_samples: number;
  max_status: number;
  max_headroom: number | null;
  max_battery_temp_c: number | null;
  idle_s: number;
  work_s: number;
  pauses: number;
  paused_s: number;
  idle_final: number;
  idle_max: number;
}

export interface PaceResult { slept_ms: number; paused: boolean; idle: number; reason: string }

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export class ThermalPacer {
  /** Fracción de descanso actual. */
  idle = 0;
  readonly stats: PacerStats = {
    source: 'none', samples: 0, throttle_samples: 0, max_status: -1, max_headroom: null, max_battery_temp_c: null,
    idle_s: 0, work_s: 0, pauses: 0, paused_s: 0, idle_final: 0, idle_max: 0,
  };

  constructor(
    private read: () => Promise<DeviceSample | null>,
    private sleep: Sleep,
    private cfg: PacerConfig = DEFAULT_PACER,
  ) {}

  /** Presión 0–1 a partir de una muestra, con la fuente usada. */
  static pressure(s: DeviceSample, cfg: PacerConfig = DEFAULT_PACER): { p: number; source: PacerStats['source']; reason: string } {
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    const hasStatus = s.thermal >= 0;
    const hasHeadroom = typeof s.thermal_headroom === 'number' && s.thermal_headroom >= 0 && Number.isFinite(s.thermal_headroom);
    if (hasStatus || hasHeadroom) {
      const byStatus = hasStatus ? STATUS_PRESSURE[Math.min(s.thermal, STATUS_PRESSURE.length - 1)] : 0;
      const byHeadroom = hasHeadroom ? clamp01((s.thermal_headroom! - cfg.headroomStart) / (cfg.headroomFull - cfg.headroomStart)) : 0;
      const p = Math.max(byStatus, byHeadroom);
      return { p, source: 'os', reason: `estado ${s.thermal}${hasHeadroom ? `, margen ${s.thermal_headroom!.toFixed(2)}` : ''}` };
    }
    if (s.battery_temp_c > 0) {
      return { p: clamp01((s.battery_temp_c - cfg.batteryRampStartC) / (cfg.batteryRampFullC - cfg.batteryRampStartC)), source: 'battery', reason: `batería ${s.battery_temp_c.toFixed(1)} °C (sin API térmica)` };
    }
    return { p: 0, source: 'none', reason: 'sin datos térmicos' };
  }

  /** Incorpora una muestra: actualiza el descanso objetivo y las estadísticas. */
  observe(s: DeviceSample | null): { pause: boolean; reason: string } {
    if (!s) return { pause: false, reason: 'sin datos térmicos' };
    const cfg = this.cfg, st = this.stats;
    const { p, source, reason } = ThermalPacer.pressure(s, cfg);
    st.source = source === 'os' || st.source === 'os' ? 'os' : source;
    st.samples += 1;
    if (s.thermal >= 2) st.throttle_samples += 1;
    st.max_status = Math.max(st.max_status, s.thermal);
    if (typeof s.thermal_headroom === 'number' && s.thermal_headroom >= 0) st.max_headroom = Math.max(st.max_headroom ?? 0, s.thermal_headroom);
    if (s.battery_temp_c > 0) st.max_battery_temp_c = Math.max(st.max_battery_temp_c ?? 0, s.battery_temp_c);
    const target = cfg.maxIdle * p;
    const a = target > this.idle ? cfg.rise : cfg.fall;
    this.idle = Math.max(0, Math.min(cfg.maxIdle, this.idle + a * (target - this.idle)));
    if (this.idle < 0.005) this.idle = 0;
    st.idle_final = Math.round(this.idle * 1000) / 1000;
    st.idle_max = Math.max(st.idle_max, st.idle_final);
    return { pause: s.thermal >= cfg.pauseAtStatus, reason };
  }

  /** Tras `workMs` de trabajo: observa, y descansa lo que toque (o pausa si el sistema está en estado crítico). */
  async afterWork(workMs: number, signal?: AbortSignal, onWait?: (message: string) => void): Promise<PaceResult> {
    this.stats.work_s += workMs / 1000;
    let sample = await this.read().catch(() => null);
    let { pause, reason } = this.observe(sample);
    let slept = 0;
    if (pause) {
      this.stats.pauses += 1;
      const t0 = Date.now();
      onWait?.(`El teléfono está demasiado caliente (${reason}): descansando hasta que se enfríe…`);
      while (pause && Date.now() - t0 < this.cfg.pauseMaxMs) {
        if (signal?.aborted) break;
        await this.sleep(this.cfg.pausePollMs, signal);
        sample = await this.read().catch(() => null);
        pause = !!sample && sample.thermal > this.cfg.resumeAtStatus;
        if (sample) this.observe(sample);
      }
      slept = Date.now() - t0;
      this.stats.paused_s += slept / 1000;
      return { slept_ms: slept, paused: true, idle: this.idle, reason };
    }
    if (this.idle > 0 && workMs > 0) {
      slept = Math.round((workMs * this.idle) / (1 - this.idle));
      onWait?.(`Descansando ${Math.round(slept / 1000)} s para no sobrecalentar el teléfono (${reason})…`);
      await this.sleep(slept, signal);
      this.stats.idle_s += slept / 1000;
    }
    return { slept_ms: slept, paused: false, idle: this.idle, reason };
  }

  summary(): PacerStats {
    const r = (n: number) => Math.round(n * 10) / 10;
    return { ...this.stats, idle_s: r(this.stats.idle_s), work_s: r(this.stats.work_s), paused_s: r(this.stats.paused_s) };
  }
}
