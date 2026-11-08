/** Bus de eventos del motor: lo que la interfaz recibe en vivo (tareas, páginas y ejecuciones). */
import type { Job, PageState, RunInfo, RunStatus } from '@starblitz/shared';

export type EngineEvent =
  | { type: 'job'; job: Job }
  | { type: 'page'; project_id: string; page_id: string; state: PageState; error: string }
  | { type: 'run'; project_id: string; status: RunStatus; counts: RunInfo['counts'] };

export class EventBus {
  private subscribers = new Set<(e: EngineEvent) => void>();

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  publish(e: EngineEvent): void {
    for (const fn of [...this.subscribers]) {
      try { fn(e); } catch { /* un suscriptor defectuoso no debe frenar al motor */ }
    }
  }
}
