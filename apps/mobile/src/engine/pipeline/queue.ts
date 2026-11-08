/**
 * Cola persistente de trabajos de procesamiento.
 *
 * Los trabajos viven en memoria (`JobManager`): si la app muere, los que estaban EN COLA y aún no habían empezado no dejan
 * rastro (el estado por páginas solo existe para el que se estaba ejecutando). Esta cola guarda cada petición en disco:
 * al arrancar, lo que quedó «en cola» o «en ejecución» pasa a «interrumpido» y se puede retomar sin perder nada.
 * El progreso por página lo conserva `RunState`; aquí se conserva QUÉ había pedido la persona y en qué orden.
 */
import type { ProcessStage, QueueEntry, QueueState } from '@starblitz/shared';
import { newId } from '../core/ids';
import type { DocStorage } from '../store/docs';

const KEY = 'queue/main';
const ACTIVE: QueueState[] = ['queued', 'running', 'interrupted'];
export const MAX_FINISHED_KEPT = 30;

export class ProcessQueue {
  private entries: QueueEntry[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private storage: DocStorage) {}

  /** Lee la cola del disco. Lo que estaba en cola o en ejecución se ha quedado sin proceso: pasa a «interrumpido». */
  async load(): Promise<QueueEntry[]> {
    const raw = await this.storage.getDoc<{ entries?: QueueEntry[] }>(KEY);
    this.entries = (raw?.entries ?? []).filter(valid).map((e) => (e.state === 'queued' || e.state === 'running' ? { ...e, state: 'interrupted' as const, job_id: null } : e));
    await this.persist();
    return this.list();
  }

  list(): QueueEntry[] { return this.entries.map((e) => ({ ...e })); }

  /** Entradas que se pueden retomar, en el orden en que se pidieron. */
  pending(): QueueEntry[] { return this.list().filter((e) => e.state === 'interrupted').sort((a, b) => a.enqueued - b.enqueued); }

  activeFor(projectId: string): QueueEntry | undefined { return this.entries.find((e) => e.project_id === projectId && ACTIVE.includes(e.state)); }

  /** Añade una petición. Si el proyecto ya tiene una activa, se devuelve esa (no se duplica el trabajo). */
  async enqueue(req: { project_id: string; stages: ProcessStage[]; page_ids?: string[] | null; force?: boolean }): Promise<QueueEntry> {
    const existing = this.activeFor(req.project_id);
    if (existing) return { ...existing };
    const e: QueueEntry = {
      id: newId('q'), project_id: req.project_id, stages: [...req.stages], page_ids: req.page_ids ? [...req.page_ids] : null, force: !!req.force,
      state: 'queued', enqueued: Date.now() / 1000, started: null, finished: null, job_id: null, error: '', attempts: 0,
    };
    this.entries.push(e);
    await this.persist();
    return { ...e };
  }

  async mark(id: string, patch: Partial<Pick<QueueEntry, 'state' | 'job_id' | 'error' | 'started' | 'finished' | 'attempts'>>): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
  }

  /** Quita las entradas de proyectos que ya no existen. */
  async dropProjects(exists: (projectId: string) => Promise<boolean>): Promise<void> {
    const keep: QueueEntry[] = [];
    for (const e of this.entries) if (await exists(e.project_id)) keep.push(e);
    if (keep.length !== this.entries.length) { this.entries = keep; await this.persist(); }
  }

  /** Serializa las escrituras (varias marcas seguidas no se pisan) y recorta el historial de terminadas. */
  private persist(): Promise<void> {
    const finished = this.entries.filter((e) => !ACTIVE.includes(e.state)).sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0));
    const drop = new Set(finished.slice(MAX_FINISHED_KEPT).map((e) => e.id));
    if (drop.size) this.entries = this.entries.filter((e) => !drop.has(e.id));
    const snapshot = { entries: this.entries.map((e) => ({ ...e })) };
    this.chain = this.chain.then(() => this.storage.putDoc(KEY, snapshot)).catch((e) => console.error('No se pudo guardar la cola', e));
    return this.chain;
  }
}

function valid(e: unknown): e is QueueEntry {
  const o = e as QueueEntry;
  return !!o && typeof o.id === 'string' && typeof o.project_id === 'string' && Array.isArray(o.stages) && typeof o.state === 'string';
}
