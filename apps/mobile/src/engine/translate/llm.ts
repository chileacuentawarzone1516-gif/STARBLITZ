/**
 * Cliente del modelo de lenguaje local (equivalente a `translate/llm.py`).
 *
 * El modelo se ejecuta dentro del propio teléfono con llama.cpp (`llama-server`, API compatible con OpenAI) y la
 * conexión es siempre a 127.0.0.1: no se usa ninguna API de pago ni servidor de terceros. Salida JSON restringida
 * por esquema, imágenes y cancelación a mitad de generación.
 */
import { CancelledError, LLMUnavailableError } from '../core/errors';
import type { LlmRuntime } from './runtime';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: Uint8Array[]; // JPEG
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMClientSettings {
  temperature: number;
  timeout_s: number;
  use_vision: boolean;
}

const THINK_RE = /<think>[\s\S]*?<\/think>/g;
const FENCE_RE = /^```(?:json)?\s*|\s*```$/g;

export function parseJson(raw: string): Record<string, unknown> {
  let text = (raw || '').replace(THINK_RE, '').trim();
  text = text.replace(FENCE_RE, '').trim();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('sin JSON');
    try { data = JSON.parse(text.slice(start, end + 1)); } catch (e) { throw new Error(String(e)); }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('el JSON no es un objeto');
  return data as Record<string, unknown>;
}

export abstract class LLMClient {
  constructor(protected s: LLMClientSettings) {}

  /** Chat con respuesta JSON validada por esquema; si el modelo devuelve algo ilegible se le pide que lo repare una vez. */
  async chatJson(messages: ChatMessage[], schema: object, opts: ChatOptions): Promise<Record<string, unknown>> {
    if (opts.signal?.aborted) throw new CancelledError();
    const temperature = opts.temperature ?? this.s.temperature;
    const raw = await this.chat(messages, schema, { ...opts, temperature });
    try {
      return parseJson(raw);
    } catch {
      console.warn('Respuesta JSON inválida; se reintenta con instrucciones de reparación.');
      if (opts.signal?.aborted) throw new CancelledError();
      const repair: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: Array.from(raw).slice(0, 4000).join('') },
        { role: 'user', content: 'Tu respuesta no era JSON válido según el esquema. Devuelve SOLO el JSON corregido.' },
      ];
      try {
        return parseJson(await this.chat(repair, schema, { ...opts, temperature: 0.1 }));
      } catch (e) {
        if (e instanceof CancelledError || e instanceof LLMUnavailableError) throw e;
        throw new LLMUnavailableError('El modelo no devolvió una respuesta válida. Prueba con otro modelo en la sección Modelos.');
      }
    }
  }

  abstract health(): Promise<{ ok: boolean }>;
  /** Carga el modelo en memoria por adelantado (solo tiene efecto con el servidor integrado). */
  async warmUp(_model: string, _signal?: AbortSignal): Promise<void> { /* sin efecto */ }
  protected abstract chat(messages: ChatMessage[], schema: object, opts: Required<Pick<ChatOptions, 'model' | 'temperature'>> & { signal?: AbortSignal }): Promise<string>;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

type ChatArgs = Required<Pick<ChatOptions, 'model' | 'temperature'>> & { signal?: AbortSignal };

/** Servidor compatible con OpenAI (LM Studio, KoboldCpp…) o el `llama-server` integrado. */
export class OpenAICompatibleClient extends LLMClient {
  constructor(s: LLMClientSettings, protected baseUrl: string, protected apiKey = '') { super(s); }

  protected url(path: string, base = this.baseUrl): string {
    return base.endsWith('/v1') ? `${base}${path}` : `${base}/v1${path}`;
  }

  protected headers(apiKey = this.apiKey, contentType = 'application/json'): Record<string, string> {
    return { 'Content-Type': contentType, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  }

  async health(): Promise<{ ok: boolean }> {
    try {
      const r = await fetch(this.url('/models'), { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      return { ok: r.ok };
    } catch { return { ok: false }; }
  }

  protected payload(messages: ChatMessage[], schema: object, a: ChatArgs): Record<string, unknown> {
    const content = (m: ChatMessage) => {
      if (!m.images?.length || !this.s.use_vision) return m.content;
      return [{ type: 'text', text: m.content },
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64(img)}` } }))];
    };
    return {
      model: a.model, temperature: a.temperature, messages: messages.map((m) => ({ role: m.role, content: content(m) })),
      response_format: { type: 'json_schema', json_schema: { name: 'respuesta', schema, strict: true } },
    };
  }

  protected async chat(messages: ChatMessage[], schema: object, a: ChatArgs): Promise<string> {
    const signal = a.signal ? AbortSignal.any([a.signal, AbortSignal.timeout(this.s.timeout_s * 1000)]) : AbortSignal.timeout(this.s.timeout_s * 1000);
    let res: Response;
    try {
      res = await fetch(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(this.payload(messages, schema, a)), signal });
    } catch (e) {
      throw this.mapFetchError(e, a.signal);
    }
    if (!res.ok) throw new LLMUnavailableError(`El servidor devolvió un error: ${await safeError(res)}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  protected mapFetchError(e: unknown, userSignal?: AbortSignal): Error {
    if (userSignal?.aborted) return new CancelledError();
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') {
      return new LLMUnavailableError('El modelo tardó demasiado en responder. Prueba un modelo más ligero o aumenta el tiempo de espera en Configuración.');
    }
    return new LLMUnavailableError('No se pudo conectar con el servidor de modelos.');
  }
}

/** Cliente del `llama-server` integrado: se inicia bajo demanda y la generación se puede cancelar al instante. */
export class BuiltinClient extends OpenAICompatibleClient {
  lastStats: { tokens: number; seconds: number; tps: number } = { tokens: 0, seconds: 0, tps: 0 };

  constructor(s: LLMClientSettings, private runtime: LlmRuntime) { super(s, ''); }

  override async health(): Promise<{ ok: boolean }> {
    return { ok: await this.runtime.ready() };
  }

  override async warmUp(model: string, signal?: AbortSignal): Promise<void> {
    const lease = await this.runtime.acquire(model, signal);
    lease.release();
  }

  protected override payload(messages: ChatMessage[], schema: object, a: ChatArgs): Record<string, unknown> {
    return {
      ...super.payload(messages, schema, a),
      stream: true, stream_options: { include_usage: true }, cache_prompt: true, top_p: 0.9, repeat_penalty: 1.05, max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false }, // la traducción no necesita razonamiento largo
    };
  }

  protected override async chat(messages: ChatMessage[], schema: object, a: ChatArgs): Promise<string> {
    const lease = await this.runtime.acquire(a.model, a.signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    a.signal?.addEventListener('abort', onAbort);
    const idleMs = this.s.timeout_s * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, idleMs); // tiempo máximo SIN recibir datos
    };
    const parts: string[] = [];
    let tokens = 0;
    const started = performance.now();
    try {
      arm();
      const res = await fetch(this.url('/chat/completions', lease.baseUrl), {
        method: 'POST', headers: this.headers(lease.apiKey, lease.contentType), body: JSON.stringify(this.payload(messages, schema, a)), signal: ctrl.signal,
      });
      if (!res.ok) throw new LLMUnavailableError(`El motor de lenguaje devolvió un error: ${await safeError(res)}`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { buf = ''; await reader.cancel().catch(() => undefined); break; }
          try {
            const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: { completion_tokens?: number } };
            for (const c of chunk.choices ?? []) if (c.delta?.content) parts.push(c.delta.content);
            if (chunk.usage?.completion_tokens) tokens = chunk.usage.completion_tokens;
          } catch { /* línea parcial o no JSON */ }
        }
      }
    } catch (e) {
      if (a.signal?.aborted) throw new CancelledError();
      if (e instanceof LLMUnavailableError) throw e;
      if (timedOut) throw new LLMUnavailableError('El modelo tardó demasiado en responder. Prueba un modelo más ligero o aumenta el tiempo de espera en Configuración.');
      throw new LLMUnavailableError('Se perdió la conexión con el motor de lenguaje integrado.');
    } finally {
      clearTimeout(timer);
      a.signal?.removeEventListener('abort', onAbort);
      ctrl.abort(); // al cerrar la conexión llama.cpp deja de generar
      lease.release();
    }
    const seconds = Math.max((performance.now() - started) / 1000, 1e-6);
    this.lastStats = { tokens, seconds: Math.round(seconds * 100) / 100, tps: tokens ? Math.round((tokens / seconds) * 10) / 10 : 0 };
    return parts.join('');
  }
}

async function safeError(res: Response): Promise<string> {
  try {
    const data = await res.clone().json() as { error?: string | { message?: string } };
    const msg = typeof data.error === 'object' ? data.error?.message : data.error;
    return String(msg || res.statusText).slice(0, 300);
  } catch {
    try { return ((await res.text()) || res.statusText).slice(0, 300); } catch { return res.statusText; }
  }
}

export interface ClientConfig extends LLMClientSettings {
  provider: 'builtin' | 'ollama' | 'openai';
  base_url: string;
  api_key: string;
}

export function createClient(cfg: ClientConfig, runtime?: LlmRuntime): LLMClient {
  if (cfg.provider === 'builtin') {
    if (!runtime) throw new LLMUnavailableError('El motor de lenguaje integrado no está disponible.');
    return new BuiltinClient(cfg, runtime);
  }
  // Ollama también expone la API de OpenAI en /v1.
  return new OpenAICompatibleClient(cfg, cfg.base_url, cfg.api_key);
}
