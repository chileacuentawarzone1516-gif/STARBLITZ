/**
 * Cola de tareas con progreso, pausa, cancelación y eventos (equivalente a `core/jobs.py`).
 * Las tareas pesadas (visión y modelo de lenguaje) se ejecutan de una en una; las descargas e importaciones
 * usan otro carril para no bloquear el procesamiento.
 */
import type { Job } from '@starblitz/shared';
import { AppError, CancelledError } from './errors';
import { newId } from './ids';
import type { EventBus } from './events';

type Lane = 'compute' | 'io';

interface JobRecord extends Job {
  lane: Lane;
  abort: AbortController;
  paused: boolean;
  waiters: (() => void)[];
  fn: ((ctx: JobContext) => Promise<unknown>) | null;
}

export class JobContext {
  private last = 0;
  constructor(private rec: JobRecord, private emit: (j: JobRecord) => void) {}

  get job(): Job { return this.rec; }
  get signal(): AbortSignal { return this.rec.abort.signal; }
  /** La persona pidió pausar: el siguiente punto de control se detendrá. */
  get pauseRequested(): boolean { return this.rec.paused; }

  /** Pausa la tarea desde dentro (batería baja, calor, poco espacio…): queda en pausa hasta que la persona la reanude. */
  pauseSelf(message: string): void {
    this.rec.paused = true;
    this.rec.message = message;
    this.emit(this.rec);
  }

  /** Punto de control: lanza si se canceló y espera mientras la tarea esté en pausa. */
  async check(): Promise<void> {
    const rec = this.rec;
    if (rec.abort.signal.aborted) throw new CancelledError();
    if (rec.paused) {
      rec.status = 'paused';
      this.emit(rec);
      while (rec.paused) {
        if (rec.abort.signal.aborted) throw new CancelledError();
        await new Promise<void>((resolve) => { rec.waiters.push(resolve); });
      }
      if (rec.abort.signal.aborted) throw new CancelledError();
      rec.status = 'running';
      this.emit(rec);
    }
  }

  update(p: { progress?: number; stage?: string; message?: string; force?: boolean; eta_s?: number | null; detail?: Job['detail'] }): void {
    const rec = this.rec;
    if (p.progress !== undefined) rec.progress = Math.max(0, Math.min(1, p.progress));
    if (p.stage !== undefined) rec.stage = p.stage;
    if (p.message !== undefined) rec.message = p.message;
    if (p.eta_s !== undefined && p.eta_s !== null) rec.eta_s = Math.max(0, p.eta_s);
    if (p.detail !== undefined) rec.detail = p.detail;
    const t = Date.now();
    if (p.force || t - this.last > 250) { // limita la frecuencia de eventos
      this.last = t;
      this.emit(rec);
    }
  }
}

export class JobManager {
  private jobs = new Map<string, JobRecord>();
  private order: string[] = [];
  private lanes: Record<Lane, Promise<void>> = { compute: Promise.resolve(), io: Promise.resolve() };

  constructor(private bus: EventBus, private history = 200) {}

  submit(kind: string, title: string, fn: (ctx: JobContext) => Promise<unknown>,
         opts: { projectId?: string | null; lane?: Lane; pausable?: boolean } = {}): Job {
    const rec: JobRecord = {
      id: newId('j'), kind, title, project_id: opts.projectId ?? null, status: 'queued', progress: 0, stage: '', message: '',
      result: null, error: '', created: Date.now() / 1000, started: null, finished: null, eta_s: null,
      pausable: !!opts.pausable, detail: {}, lane: opts.lane ?? 'compute', abort: new AbortController(), paused: false, waiters: [], fn,
    };
    this.jobs.set(rec.id, rec);
    this.order.push(rec.id);
    this.trim();
    this.emit(rec);
    this.lanes[rec.lane] = this.lanes[rec.lane].then(() => this.execute(rec));
    return this.publicJob(rec);
  }

  get(id: string): Job | undefined {
    const rec = this.jobs.get(id);
    return rec && this.publicJob(rec);
  }

  list(projectId?: string): Job[] {
    return [...this.order].reverse().map((id) => this.jobs.get(id)).filter((j): j is JobRecord => !!j)
      .filter((j) => !projectId || j.project_id === projectId).map((j) => this.publicJob(j));
  }

  activeFor(projectId: string): Job | undefined {
    for (const id of [...this.order].reverse()) {
      const j = this.jobs.get(id);
      if (j && j.project_id === projectId && j.lane === 'compute' && ['queued', 'running', 'paused'].includes(j.status)) return this.publicJob(j);
    }
    return undefined;
  }

  activeOfKind(kind: string): Job | undefined {
    for (const id of [...this.order].reverse()) {
      const j = this.jobs.get(id);
      if (j && j.kind === kind && ['queued', 'running', 'paused'].includes(j.status)) return this.publicJob(j);
    }
    return undefined;
  }

  cancel(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec || !['queued', 'running', 'paused'].includes(rec.status)) return false;
    rec.abort.abort();
    rec.paused = false;
    rec.waiters.splice(0).forEach((w) => w());
    if (rec.status === 'queued') {
      rec.status = 'cancelled';
      rec.finished = Date.now() / 1000;
      this.emit(rec);
    }
    return true;
  }

  /** Pide la pausa; surte efecto en el siguiente punto de control (al terminar el paso en curso). */
  pause(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec || !rec.pausable || !['queued', 'running'].includes(rec.status)) return false;
    rec.paused = true;
    if (rec.status === 'running') {
      rec.message = 'Pausando al terminar el paso en curso…';
      this.emit(rec);
    }
    return true;
  }

  resume(id: string): boolean {
    const rec = this.jobs.get(id);
    if (!rec || !rec.pausable || !['queued', 'running', 'paused'].includes(rec.status)) return false;
    rec.paused = false;
    rec.waiters.splice(0).forEach((w) => w());
    return true;
  }

  private async execute(rec: JobRecord): Promise<void> {
    const fn = rec.fn;
    rec.fn = null;
    if (!fn || rec.status !== 'queued') return;
    rec.status = 'running';
    rec.started = Date.now() / 1000;
    const ctx = new JobContext(rec, (j) => this.emit(j));
    ctx.update({ progress: 0, force: true });
    try {
      await ctx.check();
      rec.result = await fn(ctx);
      rec.status = 'done';
      rec.progress = 1;
    } catch (err) {
      if (err instanceof CancelledError) rec.status = 'cancelled';
      else if (err instanceof AppError) {
        rec.status = 'error';
        rec.error = err.message;
        console.warn(`Tarea ${rec.kind} falló: ${err.message}`);
      } else {
        rec.status = 'error';
        rec.error = 'Error interno inesperado. Consulta el registro para más detalles.';
        console.error(`Tarea ${rec.kind} falló`, err);
      }
    }
    rec.finished = Date.now() / 1000;
    this.emit(rec);
  }

  private trim(): void {
    while (this.order.length > this.history) {
      const old = this.jobs.get(this.order[0]);
      if (old && ['queued', 'running', 'paused'].includes(old.status)) break;
      this.jobs.delete(this.order.shift()!);
    }
  }

  private publicJob(rec: JobRecord): Job {
    const { lane: _l, abort: _a, paused: _p, waiters: _w, fn: _f, ...pub } = rec;
    return { ...pub, progress: Math.round(rec.progress * 10000) / 10000, eta_s: rec.eta_s === null ? null : Math.round(rec.eta_s), detail: { ...rec.detail } };
  }

  private emit(rec: JobRecord): void {
    this.bus.publish({ type: 'job', job: this.publicJob(rec) });
  }
}
