/**
 * Arranque del motor en el teléfono: une las piezas independientes del motor con el plugin nativo de Android.
 *
 *   Android (APK)   → archivos reales + descargas nativas + llama-server + visión en un Worker + guarda de batería/calor
 *   Navegador (dev) → OPFS + visión en el hilo principal; sin motor de lenguaje local (no hay forma de ejecutar llama.cpp)
 *
 * No depende del PC ni de la red: Internet solo se usa para descargar modelos y consultar Hugging Face.
 */
import { Capacitor } from '@capacitor/core';
import { regionFits, type Settings } from '@starblitz/shared';
import { createCaches } from '../pipeline/cache';
import { LocalEngine } from '../api/localEngine';
import { BrowserImageCodec } from '../importers/codec';
import { openPdf } from '../importers/pdf';
import { LlmLibrary } from '../models/library';
import { NativeLlmRuntime, type LlamaHost } from '../models/runtime';
import { DeviceVisionAssets, VisionModelManager } from '../models/vision';
import type { DeviceFiles } from '../platform/files';
import { OpfsFiles } from '../platform/opfs';
import { DEFAULT_LIMITS, DeviceStatusGuard } from '../device/guard';
import type { VisionPort } from '../pipeline/ports';
import { IdbStorage, type DocStorage } from '../store/docs';
import { VisionService } from '../vision/service';
import { AndroidDevice } from './androidDevice';
import { BrowserDevice } from './browserDevice';
import { computeVisionFlags } from './flags';
import { hfFetcher } from './hfFetch';
import { isAndroidApp, nativePlugin, type StarblitzNativePlugin } from './native';
import { NativeFiles } from './nativeFiles';
import { NativeLlamaHost } from './nativeLlamaHost';
import { browserThumbs } from './thumbs';
import { WakeController } from './wake';
import { WorkerVision } from './workerVision';

export interface DeviceEngineOptions {
  /** Plugin nativo; `null` fuerza el modo navegador. Por defecto, el de la app si se ejecuta en Android. */
  native?: StarblitzNativePlugin | null;
  storage?: DocStorage;
  /** Dónde está el OCR multilingüe empaquetado (por defecto, `models/ppocr-rec.onnx` junto a la página). */
  ppocrUrl?: string;
}

export interface DeviceEngine {
  engine: LocalEngine;
  platform: 'android' | 'browser';
  files: DeviceFiles;
  /** Detiene el procesamiento, el modelo de lenguaje y la visión, y suelta la pantalla. */
  close(): Promise<void>;
}

/** En el navegador no existe `llama-server`: el motor de lenguaje local no está disponible y la interfaz lo explica. */
class UnavailableLlamaHost implements LlamaHost {
  async available() { return false; }
  async start(): Promise<never> { throw new Error('El motor de lenguaje solo está disponible en la app de Android.'); }
  async stop() { /* nada que detener */ }
  async isRunning() { return false; }
  async logTail() { return []; }
}

const defaultPpocrUrl = () => new URL('models/ppocr-rec.onnx', document.baseURI).href;

export async function createDeviceEngine(opts: DeviceEngineOptions = {}): Promise<DeviceEngine> {
  const native = opts.native !== undefined ? opts.native : (isAndroidApp() ? nativePlugin() : null);
  const ppocrUrl = opts.ppocrUrl ?? defaultPpocrUrl();
  const storage = opts.storage ?? new IdbStorage();
  const fetcher = hfFetcher(!!native);

  const files: DeviceFiles = native
    ? new NativeFiles(native, { convertFileSrc: (p) => Capacitor.convertFileSrc(p) })
    : new OpfsFiles('starblitz', fetcher);
  const device = native ? new AndroidDevice(native) : new BrowserDevice();
  const visionModels = new VisionModelManager(files);
  const library = new LlmLibrary(files, { fetcher, mobile: true });

  let engine: LocalEngine | null = null;
  const settings = (): Settings => {
    if (!engine) throw new Error('El motor todavía no está listo.');
    return engine.settingsSnapshot();
  };
  const flags = async () => computeVisionFlags({ models: visionModels, settings: settings(), caps: await device.caps(), mobile: true });

  const runtime = new NativeLlmRuntime({ host: native ? new NativeLlamaHost(native) : new UnavailableLlamaHost(), library, settings, device });

  let vision: VisionPort;
  if (native && typeof Worker !== 'undefined') {
    const modelsBase = Capacitor.convertFileSrc(await files.absolutePath('models').then((p) => p ?? 'models')).replace(/\/$/, '');
    vision = new WorkerVision(
      () => new Worker(new URL('./visionWorker.entry.ts', import.meta.url), { type: 'module' }),
      { modelsBase, ppocrUrl, threads: crossOriginIsolated ? Math.min(4, Math.max(1, (await device.caps()).threads - 2)) : 1 },
      flags,
    );
  } else {
    // Navegador de desarrollo: los modelos se leen del OPFS y la visión corre en la página.
    const assets = new DeviceVisionAssets(visionModels, async () => new Uint8Array(await (await fetch(ppocrUrl)).arrayBuffer()), async () => (await flags()).manga);
    vision = new VisionService(assets, { inpaintMode: () => 'fast' });
  }

  const guard = native && device instanceof AndroidDevice
    ? new DeviceStatusGuard(() => device.status(), () => device.freeBytes(), DEFAULT_LIMITS, () => {
      void runtime.unload().catch(() => undefined);
      void vision.dispose?.().catch(() => undefined);
    })
    : undefined;

  const wake = new WakeController((on) => (device instanceof AndroidDevice ? device.keepAwake(on) : undefined));

  engine = await LocalEngine.create({
    storage, device, vision, visionModels, library, runtime, codec: new BrowserImageCodec(), pdf: openPdf, thumbs: browserThumbs, guard,
    // El original solo se borra si la traducción cabe en su globo (mismo cálculo que el editor y la exportación).
    fits: (region, page) => regionFits(region, page),
    // Reutiliza lecturas OCR y traducciones idénticas (reanudar, reprocesar, repetir un capítulo) sin repetir el trabajo costoso.
    caches: createCaches(storage),
  });
  const listener = engine.listen((e) => wake.onEvent(e));

  return {
    engine, platform: native ? 'android' : 'browser', files,
    async close() {
      engine?.unlisten(listener);
      await engine?.dispose();
      await runtime.unload().catch(() => undefined);
      wake.release();
    },
  };
}
