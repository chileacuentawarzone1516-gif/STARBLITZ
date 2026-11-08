/** Punto de entrada del Web Worker de visión (se empaqueta aparte con Vite: `new Worker(new URL(…), { type: 'module' })`). */
import { VisionService } from '../vision/service';
import { VisionWorkerHost } from './visionWorker';
import type { VisionRequest } from './visionProtocol';

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<VisionRequest>) => void) | null };

const host = new VisionWorkerHost({
  post: (reply) => scope.postMessage(reply),
  createService: (assets, flags, config) => new VisionService(assets, { ort: { wasmBase: config.wasmBase, threads: config.threads }, inpaintMode: () => flags().inpaintMode }),
});

scope.onmessage = (e) => host.handle(e.data);
