/**
 * Contrato del motor de lenguaje local. En el teléfono lo implementa el plugin nativo (inicia `llama-server`
 * desde las bibliotecas de la app, carga el modelo y lo descarga por inactividad); en las pruebas, un servidor simulado.
 */
import type { RuntimeStatus } from '@starblitz/shared';

export interface LlmLease {
  baseUrl: string;   // http://127.0.0.1:<puerto>
  apiKey: string;
  /**
   * Tipo de contenido de la petición. `text/plain` (sin clave de API) la hace una «petición simple» de CORS: así la
   * WebView puede hablar con el servidor local sin comprobación previa, que `llama-server` no siempre atiende.
   */
  contentType?: string;
  /** Marca el fin del uso: mientras haya una petición en curso el modelo no se descarga por inactividad. */
  release(): void;
}

export interface LlmRuntime {
  /** ¿Hay motor y al menos un modelo instalado? */
  ready(): Promise<boolean>;
  /** Carga el modelo si hace falta y entrega la dirección del servidor local. */
  acquire(modelId: string, signal?: AbortSignal): Promise<LlmLease>;
  status(): Promise<RuntimeStatus>;
  unload(): Promise<RuntimeStatus>;
  /** ¿Hay alguna petición en curso? (activar o borrar un modelo no debe cortarla). */
  inUse?(): boolean;
}
