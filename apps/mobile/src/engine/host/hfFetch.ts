/**
 * `fetch` para consultar el catálogo de Hugging Face (solo metadatos: la descarga de los modelos la hace el plugin nativo).
 * Primero se usa `fetch` normal; si la WebView lo impide (CORS, red), se repite la consulta por el cliente HTTP nativo de
 * Capacitor, que no está sujeto a CORS. Nada de esto toca los archivos de las personas.
 */
import { CapacitorHttp } from '@capacitor/core';
import type { Fetcher } from '../platform/transfer';

export function hfFetcher(native: boolean, base: Fetcher = (u, i) => fetch(u, i)): Fetcher {
  return async (url, init) => {
    try {
      return await base(url, init);
    } catch (e) {
      if (!native || (init?.signal as AbortSignal | undefined)?.aborted) throw e;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
      const res = await CapacitorHttp.get({ url, headers, responseType: 'text', connectTimeout: 15_000, readTimeout: 30_000 });
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const noBody = res.status === 204 || res.status === 205 || res.status === 304;
      return new Response(noBody ? null : body, { status: res.status, headers: res.headers });
    }
  };
}
