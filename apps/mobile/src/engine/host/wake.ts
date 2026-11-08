/** Mantiene la pantalla encendida solo mientras hay una tarea trabajando (no en pausa ni en cola), para que Android no suspenda el procesamiento. */
import type { EngineEvent } from '../core/events';

export class WakeController {
  private running = new Set<string>();
  private on = false;

  constructor(private setAwake: (enabled: boolean) => Promise<void> | void) {}

  onEvent(e: EngineEvent): void {
    if (e.type !== 'job') return;
    if (e.job.status === 'running') this.running.add(e.job.id); else this.running.delete(e.job.id);
    this.sync();
  }

  /** Libera la pantalla (al cerrar el motor). */
  release(): void { this.running.clear(); this.sync(); }

  private sync(): void {
    const want = this.running.size > 0;
    if (want === this.on) return;
    this.on = want;
    try {
      void Promise.resolve(this.setAwake(want)).catch(() => undefined);
    } catch { /* la pantalla es una comodidad: un fallo aquí nunca debe detener el procesamiento */ }
  }
}
