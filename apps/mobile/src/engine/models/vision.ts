/**
 * Modelos de visión del teléfono (equivalente a `models/registry.py` + `models/manager.py`): detector de texto, Manga OCR
 * y LaMa. Se descargan una vez (Internet solo para eso) y después todo funciona sin conexión. El OCR multilingüe PP-OCR
 * viaja dentro de la app y no se descarga.
 *
 * Carpeta:  models/<id>/<archivo>      Cada archivo se verifica con SHA-256 al descargarlo.
 */
import type { VisionModel } from '@starblitz/shared';
import { AppError, ModelMissingError, NotFoundError } from '../core/errors';
import type { DeviceFiles, DownloadHooks } from '../platform/files';
import type { MangaOcrFiles } from '../vision/ocr/mangaOcr';
import type { VisionAssets } from '../vision/service';
import registry from './vision-registry.json';

export interface VisionFileSpec { rel: string; url: string; sha256: string | null; approx_mb: number }
export interface VisionSpec {
  id: string; label: string; purpose: string; description: string; license: string; homepage: string; required: boolean;
  languages: string[]; files: VisionFileSpec[];
}

export const VISION_REGISTRY = registry as VisionSpec[];
export const specOf = (id: string) => VISION_REGISTRY.find((s) => s.id === id);
const approxMb = (s: VisionSpec) => Math.round(s.files.reduce((n, f) => n + f.approx_mb, 0) * 10) / 10;
const dirOf = (id: string) => `models/${id}`;

export interface VisionInstallControl {
  progress?(fraction: number, message: string): void;
  signal?: AbortSignal;
}

export interface VisionManagerOptions {
  /** Permite redirigir las descargas (réplicas propias, pruebas). */
  mapUrl?: (url: string) => string;
}

export class VisionModelManager {
  private busy = new Set<string>();
  constructor(private files: DeviceFiles, private opts: VisionManagerOptions = {}) {}

  async isInstalled(id: string): Promise<boolean> {
    const spec = specOf(id);
    if (!spec) return false;
    for (const f of spec.files) if (!(await this.files.stat(`${dirOf(id)}/${f.rel}`)).exists) return false;
    return true;
  }

  async status(): Promise<VisionModel[]> {
    const out: VisionModel[] = [];
    for (const s of VISION_REGISTRY) {
      out.push({
        id: s.id, label: s.label, purpose: s.purpose, description: s.description, license: s.license, homepage: s.homepage,
        required: s.required, languages: s.languages, approx_mb: approxMb(s), installed: await this.isInstalled(s.id),
        downloading: this.busy.has(s.id), offline: true, // una vez descargado funciona sin Internet
      });
    }
    return out;
  }

  async install(id: string, ctl: VisionInstallControl = {}): Promise<void> {
    const spec = specOf(id);
    if (!spec) throw new NotFoundError('el modelo');
    if (this.busy.has(id)) throw new AppError('busy', 'Este modelo ya se está descargando.', 409);
    this.busy.add(id);
    try {
      const total = Math.max(spec.files.reduce((n, f) => n + f.approx_mb, 0), 0.01);
      let doneMb = 0;
      const need = spec.files.reduce((n, f) => n + f.approx_mb, 0) * 1024 * 1024 * 1.05 + 32 * 1024 * 1024;
      const free = await this.files.freeBytes();
      if (free < need) {
        throw new AppError('disk_full', `No hay espacio suficiente: se necesitan ${(need / 1024 ** 3).toFixed(1)} GB libres y hay ${(free / 1024 ** 3).toFixed(1)} GB.`, 507);
      }
      for (const f of spec.files) {
        const base = doneMb;
        const hooks: DownloadHooks = {
          signal: ctl.signal,
          onProgress: (done, size) => ctl.progress?.(Math.min(0.999, (base + f.approx_mb * (size ? done / size : 0)) / total), `Descargando ${f.rel}`),
        };
        await this.files.download({ url: this.opts.mapUrl?.(f.url) ?? f.url, path: `${dirOf(id)}/${f.rel}`, sha256: f.sha256 }, hooks);
        doneMb += f.approx_mb;
      }
      ctl.progress?.(1, 'Instalado');
    } finally {
      this.busy.delete(id);
    }
  }

  async remove(id: string): Promise<void> {
    if (!specOf(id)) throw new NotFoundError('el modelo');
    if (this.busy.has(id)) throw new AppError('busy', 'No se puede eliminar un modelo mientras se descarga.', 409);
    await this.files.remove(dirOf(id));
  }

  async read(id: string, rel: string): Promise<Uint8Array> {
    const spec = specOf(id);
    if (!spec) throw new NotFoundError(`el modelo ${id}`);
    if (!(await this.isInstalled(id))) throw new ModelMissingError(spec.id, spec.label);
    return this.files.readBytes(`${dirOf(id)}/${rel}`);
  }

  async readText(id: string, rel: string): Promise<string> {
    return new TextDecoder().decode(await this.read(id, rel));
  }

  async diskBytes(): Promise<number> {
    let n = 0;
    for (const s of VISION_REGISTRY) for (const f of s.files) n += (await this.files.stat(`${dirOf(s.id)}/${f.rel}`)).size;
    return n;
  }
}

/** Entrega al motor de visión los modelos instalados; Manga OCR solo si el perfil del dispositivo lo permite. */
export class DeviceVisionAssets implements VisionAssets {
  private ppocrBytes: Promise<Uint8Array> | null = null;

  constructor(
    private manager: VisionModelManager,
    /** Obtiene el OCR multilingüe incluido en la app. */
    private loadPpocr: () => Promise<Uint8Array>,
    /** ¿Permite el perfil usar Manga OCR (≈460 MB en memoria)? */
    private mangaAllowed: () => Promise<boolean> = async () => true,
  ) {}

  detector(): Promise<Uint8Array> { return this.manager.read('text-detector', 'comictextdetector.onnx'); }

  ppocr(): Promise<Uint8Array> {
    this.ppocrBytes ??= this.loadPpocr().catch((e) => { this.ppocrBytes = null; throw e; });
    return this.ppocrBytes;
  }

  async hasMangaOcr(): Promise<boolean> {
    return (await this.mangaAllowed()) && (await this.manager.isInstalled('manga-ocr'));
  }

  async mangaOcr(): Promise<MangaOcrFiles | null> {
    if (!(await this.hasMangaOcr())) return null;
    const [encoder, decoder, vocab, generationConfig] = await Promise.all([
      this.manager.read('manga-ocr', 'encoder_model.onnx'), this.manager.read('manga-ocr', 'decoder_model.onnx'),
      this.manager.readText('manga-ocr', 'vocab.txt'), this.manager.readText('manga-ocr', 'generation_config.json'),
    ]);
    return { encoder, decoder, vocab, generationConfig };
  }

  async lama(): Promise<Uint8Array | null> {
    return (await this.manager.isInstalled('lama')) ? this.manager.read('lama', 'lama_fp32.onnx') : null;
  }
}
