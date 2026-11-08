/** `LlamaHost` sobre el plugin nativo: ejecuta `llama-server` (llama.cpp) dentro del teléfono. */
import type { LlamaHost } from '../models/runtime';
import { LlamaStartError } from '../models/runtime';
import type { NativeError, StarblitzNativePlugin } from './native';

const REASONS = ['exited', 'timeout', 'cancelled', 'missing'] as const;

export class NativeLlamaHost implements LlamaHost {
  private availability: Promise<boolean> | null = null;

  constructor(private native: StarblitzNativePlugin, private startTimeoutMs = 240_000) {}

  available(): Promise<boolean> {
    this.availability ??= this.native.llamaAvailable().then((r) => r.available, () => false);
    return this.availability;
  }

  async start(opts: { model: string; args: string[]; signal?: AbortSignal }): Promise<{ baseUrl: string; pid: number }> {
    if (opts.signal?.aborted) throw new LlamaStartError('cancelled', 'Inicio cancelado');
    const onAbort = () => { void this.native.llamaStop().catch(() => undefined); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.native.llamaStart({ model: opts.model, args: opts.args, timeoutMs: this.startTimeoutMs });
    } catch (e) {
      const err = e as NativeError;
      const reason = REASONS.find((r) => r === err.code) ?? 'exited';
      throw new LlamaStartError(reason, err.message ?? 'El motor de lenguaje no arrancó.', err.data?.log ?? []);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async stop(): Promise<void> { await this.native.llamaStop(); }
  async isRunning(): Promise<boolean> { return (await this.native.llamaIsRunning()).running; }
  async logTail(lines: number): Promise<string[]> { return (await this.native.llamaLog({ lines })).lines; }
}
