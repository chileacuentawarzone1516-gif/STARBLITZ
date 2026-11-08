/**
 * Biblioteca local de modelos de traducción (GGUF) del teléfono (equivalente a `llm/library.py`): buscar en Hugging Face,
 * comprobar si el modelo cabe en este dispositivo, descargarlo (reanudable y verificado), listarlo y borrarlo.
 *
 * Carpeta:  llm/<id>/<modelo>.gguf  (+ mmproj opcional)  +  manifest.json
 * Internet se usa solo para consultar el catálogo y descargar; la traducción posterior no necesita conexión.
 */
import {
  CATALOG, HFError, HuggingFace, describeRepo, estimateMemoryGb, fitModel, licenseInfo, modelId, quantOf, shardsOf, validatePath, validateRepo,
} from '@starblitz/shared';
import type { DeviceCaps, Fit, HFRepoInfo, HFSearchResult, InstalledModel } from '@starblitz/shared';
import type { Fetcher, RemoteModel } from '@starblitz/shared';
import { AppError, CancelledError, NotFoundError } from '../core/errors';
import type { DeviceFiles } from '../platform/files';
import type { ModelLibrary } from '../pipeline/ports';

const GIB = 1024 ** 3;
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,79}$/;
const ROOT = 'llm';

/** Lo que se guarda en `manifest.json` (equivale al `InstalledModel` de Python). */
export interface StoredModel {
  id: string; label: string; repo: string; revision: string;
  /** Trozos del GGUF principal en orden (el primero es el que se carga). */
  files: string[];
  mmproj: string | null;
  /** Bytes en disco (modelo + mmproj). */
  size: number;
  quant: string; license: string; arch: string; params_b: number; context_native: number;
  source: 'curated' | 'custom';
  installed_at: number;
}

export interface InstallOptions {
  mmproj?: string | null;
  token?: string;
  caps: DeviceCaps;
  /** Contexto con el que se cargará (para calcular la memoria necesaria). */
  context: number;
  force?: boolean;
  label?: string;
  progress?(fraction: number, message: string): void;
  signal?: AbortSignal;
  /** Pausa: se detiene la transferencia en curso (conserva lo descargado) y se espera a que se reanude. */
  isPaused?(): boolean;
  waitIfPaused?(): Promise<void>;
}

export interface LibraryOptions {
  endpoint?: string;
  fetcher?: Fetcher;
  /** El dispositivo es un teléfono: afecta a la estimación de memoria y de velocidad. */
  mobile?: boolean;
}

const HF_STATUS: Record<string, number> = { auth_required: 403, not_found: 404, invalid_repo: 422, invalid_file: 422, hf_unreachable: 503 };

/** Los errores de Hugging Face llevan mensajes pensados para la persona: se exponen como errores de dominio. */
export function fromHf(e: unknown): unknown {
  return e instanceof HFError ? new AppError(e.code, e.message, HF_STATUS[e.code] ?? 502) : e;
}

const NEUTRAL_FIT: Fit = { fits: 'cpu', speed: 'medium', need_gb: 0, tight: false, note: '' };

export function toInstalled(m: StoredModel, fit: Fit = NEUTRAL_FIT, active = false): InstalledModel {
  return { ...m, vision: !!m.mmproj, license_info: licenseInfo(m.license), fit, active };
}

export class LlmLibrary implements ModelLibrary {
  private busy = new Set<string>();

  constructor(private files: DeviceFiles, private opts: LibraryOptions = {}) {}

  private hf(token = ''): HuggingFace {
    return new HuggingFace(this.opts.endpoint, token, this.opts.fetcher);
  }

  // -- consulta -------------------------------------------------------------------------------
  async stored(): Promise<StoredModel[]> {
    const out: StoredModel[] = [];
    for (const entry of await this.files.list(ROOT)) {
      if (!entry.isDir || !ID_RE.test(entry.name)) continue;
      const raw = await this.files.readText(`${ROOT}/${entry.name}/manifest.json`);
      if (!raw) continue;
      let m: StoredModel;
      try { m = JSON.parse(raw) as StoredModel; } catch { console.warn('Manifiesto ilegible:', entry.name); continue; }
      if (m.id !== entry.name || !Array.isArray(m.files) || !m.files.length) continue;
      let complete = true;
      for (const f of [...m.files, ...(m.mmproj ? [m.mmproj] : [])]) if (!(await this.files.stat(`${ROOT}/${m.id}/${f}`)).exists) { complete = false; break; }
      if (complete) out.push(m);
    }
    return out;
  }

  async installed(): Promise<InstalledModel[]> {
    return (await this.stored()).map((m) => toInstalled(m));
  }

  async get(id: string): Promise<StoredModel> {
    const hit = (await this.stored()).find((m) => m.id === id);
    if (!hit) throw new NotFoundError(`el modelo «${id}»`);
    return hit;
  }

  async isInstalled(id: string): Promise<boolean> { return (await this.stored()).some((m) => m.id === id); }
  installing(): string[] { return [...this.busy].sort(); }

  /** Ruta absoluta del modelo en el teléfono (la recibe `llama-server`). */
  async modelPath(id: string): Promise<string> {
    const m = await this.get(id);
    const p = await this.files.absolutePath(`${ROOT}/${m.id}/${m.files[0]}`);
    if (!p) throw new AppError('no_filesystem', 'Este entorno no tiene acceso a archivos reales: los modelos de traducción solo se pueden ejecutar en la app de Android.', 501);
    return p;
  }

  async mmprojPath(id: string): Promise<string | null> {
    const m = await this.get(id);
    return m.mmproj ? this.files.absolutePath(`${ROOT}/${m.id}/${m.mmproj}`) : null;
  }

  async diskUsage(): Promise<number> { return (await this.stored()).reduce((n, m) => n + m.size, 0); }

  // -- Hugging Face ------------------------------------------------------------------------------
  async search(query: string, token: string, limit = 20): Promise<HFSearchResult[]> {
    const results = await this.hf(token).search(query, limit).catch((e) => { throw fromHf(e); });
    const installed = new Set((await this.stored()).map((m) => m.repo));
    return results.map((r) => ({ ...r, installed: installed.has(r.repo) }));
  }

  /** Ficha de un repositorio con cada cuantización y su compatibilidad con ESTE teléfono. */
  async inspect(repo: string, token: string, caps: DeviceCaps, context: number): Promise<HFRepoInfo> {
    try { validateRepo(repo); } catch (e) { throw fromHf(e); }
    const remote = await this.hf(token).fetchModel(repo).catch((e) => { throw fromHf(e); });
    const info = describeRepo(remote, caps, context, this.opts.mobile ?? true);
    const installed = new Set((await this.stored()).map((m) => `${m.repo}\u0000${m.files[0]}`));
    for (const f of info.files) f.installed = installed.has(`${repo}\u0000${f.path.split('/').pop()}`);
    return info;
  }

  /** ¿Cabe este archivo en el dispositivo? Se consulta antes de descargar nada. */
  check(remote: RemoteModel, path: string, mmproj: string | null, caps: DeviceCaps, context: number): Fit & { size: number; mmproj_size: number; params_b: number } {
    const shards = shardsOf(remote, path);
    const size = shards.reduce((n, f) => n + f.size, 0);
    const mmSize = mmproj ? (remote.files[mmproj]?.size ?? 0) : 0;
    const paramsB = remote.params ? remote.params / 1e9 : Math.max(size / GIB / 0.6, 0.5);
    const need = estimateMemoryGb(size, paramsB, context, 0, remote.architecture);
    const mobile = this.opts.mobile ?? true;
    return { ...fitModel(need, caps.ram_gb, mobile ? 0 : caps.vram_gb, mobile), size, mmproj_size: mmSize, params_b: Math.round(paramsB * 100) / 100 };
  }

  // -- instalación -------------------------------------------------------------------------------
  async install(repo: string, path: string, o: InstallOptions): Promise<StoredModel> {
    const mmproj = o.mmproj || null;
    try { validateRepo(repo); validatePath(path); if (mmproj) validatePath(mmproj); } catch (e) { throw fromHf(e); }
    if (!path.toLowerCase().endsWith('.gguf')) throw new AppError('not_gguf', 'Solo se pueden instalar modelos en formato GGUF.', 422);
    const curated = CATALOG.find((m) => m.repo === repo && m.file === path);
    const id = curated?.id ?? modelId(repo, path.split('/').pop()!);
    if (!ID_RE.test(id)) throw new AppError('invalid_id', 'No se pudo generar un identificador válido para el modelo.', 422);
    if (this.busy.has(id)) throw new AppError('busy', 'Este modelo ya se está descargando.', 409);
    this.busy.add(id);
    try {
      o.progress?.(0, 'Consultando Hugging Face');
      const hf = this.hf(o.token);
      const remote = await hf.fetchModel(repo).catch((e) => { throw fromHf(e); });
      const verdict = this.check(remote, path, mmproj, o.caps, o.context);
      if (verdict.fits === 'no' && !o.force) {
        throw new AppError('incompatible', `Este modelo no es compatible con tu teléfono: ${verdict.note}`, 409);
      }
      const shards = shardsOf(remote, path);
      const todo = [...shards, ...(mmproj ? [remote.files[mmproj]].filter(Boolean) : [])];
      if (mmproj && todo.length !== shards.length + 1) throw new AppError('not_found', `No existe el archivo «${mmproj}» en ${repo}.`, 404);
      const total = todo.reduce((n, f) => n + f.size, 0) || 1;
      const needDisk = total * 1.01 + 64 * 1024 * 1024;
      const free = await this.files.freeBytes();
      if (free < needDisk) {
        throw new AppError('disk_full', `No hay espacio suficiente: se necesitan ${(needDisk / GIB).toFixed(1)} GB libres y hay ${(free / GIB).toFixed(1)} GB.`, 507);
      }
      let doneBefore = 0;
      for (const f of todo) {
        const name = f.path.split('/').pop()!;
        const base = doneBefore;
        await this.downloadFile(hf.url(remote, f.path), `${ROOT}/${id}/${name}`, f.size, f.sha256, hf.headers(), o, (done) => {
          o.progress?.(Math.min(0.995, (base + done) / total), `Descargando ${name}`);
        });
        doneBefore += f.size;
      }
      const paramsB = remote.params ? remote.params / 1e9 : (curated?.params_b ?? 0);
      const model: StoredModel = {
        id, label: o.label || curated?.label || path.split('/').pop()!.replace(/\.gguf$/i, ''), repo, revision: remote.revision,
        files: shards.map((f) => f.path.split('/').pop()!), mmproj: mmproj ? mmproj.split('/').pop()! : null, size: total, quant: quantOf(path),
        license: remote.license, arch: remote.architecture, params_b: Math.round(paramsB * 100) / 100, context_native: remote.contextLength,
        source: curated ? 'curated' : 'custom', installed_at: Date.now() / 1000,
      };
      await this.files.writeText(`${ROOT}/${id}/manifest.json`, JSON.stringify(model, null, 1));
      o.progress?.(1, 'Instalado');
      return model;
    } catch (e) {
      throw fromHf(e);
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * Descarga un archivo; si la persona pausa, corta la transferencia (queda el `.part`) y la retoma al reanudar.
   * Cancelar propaga `CancelledError` y también conserva lo descargado.
   */
  private async downloadFile(url: string, path: string, size: number, sha256: string | null, headers: Record<string, string>, o: InstallOptions, onBytes: (done: number) => void): Promise<void> {
    for (;;) {
      if (o.signal?.aborted) throw new CancelledError();
      await o.waitIfPaused?.();
      const attempt = new AbortController();
      const forward = () => attempt.abort();
      o.signal?.addEventListener('abort', forward, { once: true });
      let pausedHere = false;
      try {
        await this.files.download({ url, path, headers, expectedSize: size, sha256 }, {
          signal: attempt.signal,
          onProgress: (done) => {
            onBytes(done);
            if (o.isPaused?.() && !attempt.signal.aborted) { pausedHere = true; attempt.abort(); }
          },
        });
        return;
      } catch (e) {
        if (pausedHere && !o.signal?.aborted) continue; // se reanudará desde el .part
        throw e;
      } finally {
        o.signal?.removeEventListener('abort', forward);
      }
    }
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new NotFoundError(`el modelo «${id}»`);
    if (this.busy.has(id)) throw new AppError('busy', 'No se puede eliminar un modelo mientras se descarga.', 409);
    if (!(await this.files.stat(`${ROOT}/${id}`)).exists) throw new NotFoundError(`el modelo «${id}»`);
    await this.files.remove(`${ROOT}/${id}`);
  }
}
