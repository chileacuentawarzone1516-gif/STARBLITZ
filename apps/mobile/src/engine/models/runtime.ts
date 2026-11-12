/**
 * Motor de lenguaje del teléfono: gestiona `llama-server` (llama.cpp) como proceso local (equivalente a `llm/runtime.py`).
 *
 * Quien arranca y detiene el proceso es el plugin nativo (`LlamaHost`); aquí se decide QUÉ arrancar: contexto, hilos,
 * capas en GPU, proyector de imágenes y las opciones opcionales (con reintento sin ellas si la versión empaquetada no
 * las conoce). El servidor escucha solo en 127.0.0.1, se inicia bajo demanda y se detiene solo tras un rato sin uso
 * para devolver la memoria al sistema. La traducción nunca sale del teléfono.
 */
import { currentProfile, effectiveContext, fitFor } from '@starblitz/shared';
import type { DeviceCaps, RuntimeStatus, Settings } from '@starblitz/shared';
import { CancelledError, LLMUnavailableError } from '../core/errors';
import type { DeviceProvider } from '../pipeline/ports';
import type { LlmLease, LlmRuntime } from '../translate/runtime';
import type { LlmLibrary } from './library';

export type StartFailure = 'exited' | 'timeout' | 'cancelled' | 'missing';

export class LlamaStartError extends Error {
  constructor(readonly reason: StartFailure, message: string, readonly log: string[] = []) { super(message); }
}

/** Lo que el plugin nativo ofrece para ejecutar `llama-server` en el teléfono. */
export interface LlamaHost {
  /** ¿Incluye la app un `llama-server` para la arquitectura de este teléfono? */
  available(): Promise<boolean>;
  /** Inicia el servidor (puerto libre en 127.0.0.1) y espera a que responda `/health`. */
  start(opts: { model: string; args: string[]; signal?: AbortSignal }): Promise<{ baseUrl: string; pid: number }>;
  stop(): Promise<void>;
  isRunning(): Promise<boolean>;
  logTail(lines: number): Promise<string[]>;
}

export type FlagLevel = 'full' | 'basic' | 'bare';
export const FLAG_LEVELS: FlagLevel[] = ['full', 'basic', 'bare'];

export interface ArgsInput { ctx: number; threads: number; gpuLayers: number | null; mmproj: string | null; level: FlagLevel }

/** Opciones de `llama-server` (sin modelo, host ni puerto: eso lo pone el plugin). */
export function llamaArgs(i: ArgsInput): string[] {
  const args = ['-c', String(i.ctx), '--parallel', '1', '-t', String(i.threads)];
  if (i.gpuLayers !== null) args.push('-ngl', String(i.gpuLayers));
  if (i.level === 'full' || i.level === 'basic') args.push('--jinja');
  if (i.level === 'full') {
    args.push('--no-webui', '--reasoning-budget', '0');
    if (i.mmproj) args.push('--mmproj', i.mmproj);
  }
  return args;
}

/** Hilos de generación: en los móviles los núcleos de bajo consumo frenan al conjunto, así que no se usan todos. */
export function llamaThreads(caps: Pick<DeviceCaps, 'threads'>): number {
  return Math.max(2, Math.min(6, Math.round((caps.threads || 4) * 0.6)));
}

export interface RuntimeDeps {
  host: LlamaHost;
  library: LlmLibrary;
  settings: () => Settings;
  device: DeviceProvider;
  now?: () => number;
  /** Intervalo del vigilante de inactividad (ms); 0 lo desactiva (pruebas). */
  watchMs?: number;
}

export class NativeLlmRuntime implements LlmRuntime {
  private model: string | null = null;
  private pid: number | null = null;
  private baseUrl = '';
  private started = 0;
  private lastUsed = 0;
  private inflight = 0;
  private flags: string[] = [];
  private lastError = '';
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: RuntimeDeps) {}

  private now() { return (this.d.now ?? Date.now)() / 1000; }

  inUse(): boolean { return this.inflight > 0; }

  async ready(): Promise<boolean> {
    return (await this.d.host.available()) && (await this.d.library.stored()).length > 0;
  }

  async acquire(modelId: string, signal?: AbortSignal): Promise<LlmLease> {
    await this.serialize(() => this.ensure(modelId, signal));
    this.inflight += 1;
    let released = false;
    return {
      baseUrl: this.baseUrl, apiKey: '', contentType: 'text/plain',
      release: () => { if (!released) { released = true; this.inflight -= 1; this.lastUsed = this.now(); } },
    };
  }

  /** Las altas y bajas del servidor se encadenan: nunca hay dos arranques a la vez. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async alive(): Promise<boolean> {
    if (this.model === null) return false;
    if (await this.d.host.isRunning()) return true;
    this.model = this.pid = null; // el sistema lo cerró (poca memoria): se volverá a iniciar
    return false;
  }

  private async ensure(modelId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CancelledError();
    if ((await this.alive()) && this.model === modelId) { this.lastUsed = this.now(); return; }
    await this.stopNow();
    if (!(await this.d.host.available())) {
      throw new LLMUnavailableError('Esta versión de STARBLITZ no incluye el motor de lenguaje para la arquitectura de tu teléfono. Instala la versión arm64 (la habitual en móviles recientes).');
    }
    if (!(await this.d.library.isInstalled(modelId))) throw new LLMUnavailableError('No hay un modelo de traducción instalado. Instálalo en la sección Modelos.');
    await this.start(modelId, signal);
  }

  private async start(modelId: string, signal?: AbortSignal): Promise<void> {
    const { host, library } = this.d;
    const settings = this.d.settings();
    const stored = await library.get(modelId);
    const caps = await this.d.device.caps();
    const profile = currentProfile(caps, settings.processing.profile, true);
    const ctx = effectiveContext(profile, settings.llm.context_window, stored.context_native);
    const verdict = fitFor({ size: stored.size, params_b: stored.params_b, arch: stored.arch }, caps, ctx, true);
    if (verdict.fits === 'no') {
      throw new LLMUnavailableError(`Este modelo no cabe en la memoria del teléfono (${verdict.note}). Elige uno más ligero en Modelos.`);
    }
    const model = await library.modelPath(modelId);
    const mm = settings.llm.use_vision && profile.vision_llm ? await library.mmprojPath(modelId) : null;
    let failure = '';
    for (const level of FLAG_LEVELS) {
      const args = llamaArgs({ ctx, threads: llamaThreads(caps), gpuLayers: 0, mmproj: mm, level });
      try {
        const run = await host.start({ model, args, signal });
        Object.assign(this, { model: modelId, pid: run.pid, baseUrl: run.baseUrl, started: this.now(), lastUsed: this.now(), flags: args.filter((a) => a.startsWith('--')), lastError: '' });
        this.watch();
        return;
      } catch (e) {
        if (signal?.aborted || (e instanceof LlamaStartError && e.reason === 'cancelled')) throw new CancelledError();
        failure = await this.failureReason(e);
        await host.stop().catch(() => undefined);
        if (e instanceof LlamaStartError && (e.reason === 'timeout' || e.reason === 'missing')) break; // no es un problema de opciones
      }
    }
    this.lastError = failure || 'El motor de lenguaje no arrancó.';
    throw new LLMUnavailableError(`El motor de lenguaje no pudo arrancar. ${this.lastError}`);
  }

  private async failureReason(e: unknown): Promise<string> {
    const tail = e instanceof LlamaStartError && e.log.length ? e.log : await this.d.host.logTail(40).catch(() => [] as string[]);
    for (const line of [...tail].reverse()) {
      if (/error|failed|invalid|unknown|cannot|out of memory/i.test(line)) return line.trim().slice(0, 240);
    }
    return (tail.at(-1) ?? (e as Error)?.message ?? '').trim().slice(0, 240);
  }

  private async stopNow(): Promise<void> {
    const had = this.model !== null;
    this.model = this.pid = null;
    this.flags = [];
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (had || (await this.d.host.isRunning().catch(() => false))) await this.d.host.stop().catch(() => undefined);
  }

  async unload(): Promise<RuntimeStatus> {
    await this.serialize(() => this.stopNow());
    return this.status();
  }

  async status(): Promise<RuntimeStatus> {
    const available = await this.d.host.available().catch(() => false);
    const alive = await this.alive();
    return {
      available, running: alive, model: alive ? this.model : null, pid: alive ? this.pid : null,
      uptime_s: alive ? Math.round(this.now() - this.started) : 0, idle_s: alive ? Math.round(this.now() - this.lastUsed) : 0,
      flags: alive ? [...this.flags] : [], error: this.lastError, log_tail: await this.d.host.logTail(12).catch(() => []),
    };
  }

  /** Vigila la inactividad: pasado el tiempo configurado sin peticiones se descarga el modelo de la memoria. */
  private watch(): void {
    if (this.timer || this.d.watchMs === 0) return;
    this.timer = setInterval(() => {
      const limit = this.d.settings().llm.idle_unload_minutes * 60;
      if (this.model !== null && limit > 0 && this.inflight === 0 && this.now() - this.lastUsed > limit) {
        console.info('Descargando el modelo de la memoria por inactividad');
        void this.unload();
      }
    }, this.d.watchMs ?? 15_000);
  }

  dispose(): Promise<void> {
    return this.serialize(() => this.stopNow());
  }
}
