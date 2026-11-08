/**
 * Cliente mínimo de Hugging Face (equivalente a `llm/hf.py`): solo catálogo y descarga, nunca la API de inferencia de pago.
 * Antes de instalar se consulta el commit exacto, el tamaño y el SHA‑256 de cada archivo; la descarga se hace desde
 * `resolve/<commit>/<archivo>`, así lo que se instala es lo que se mostró al usuario aunque el repositorio cambie.
 */
import type { HFFile, HFRepoInfo, HFSearchResult } from '../types';
import { estimateMemoryGb, fitModel, licenseInfo } from './catalog';

export const DEFAULT_ENDPOINT = 'https://huggingface.co';
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const PATH_RE = /^[\w][\w .()+@=,-]*(\/[\w][\w .()+@=,-]*)*$/;
const SHARD_RE = /^(?<stem>.+)-(?<idx>\d{5})-of-(?<n>\d{5})\.gguf$/;
const GIB = 1024 ** 3;

export class HFError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export const validateRepo = (repo: string) => {
  if (!REPO_RE.test(repo || '')) throw new HFError('invalid_repo', 'Identificador de repositorio no válido (formato esperado: autor/nombre).');
  return repo;
};
export const validatePath = (path: string) => {
  if (!path || path.split('/').includes('..') || !PATH_RE.test(path)) throw new HFError('invalid_file', 'Nombre de archivo no válido.');
  return path;
};

export interface RemoteFile { path: string; size: number; sha256: string | null }
export interface RemoteModel {
  repo: string; revision: string; license: string; architecture: string; params: number; contextLength: number; gated: boolean;
  files: Record<string, RemoteFile>;
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class HuggingFace {
  constructor(private endpoint = DEFAULT_ENDPOINT, private token = '', private fetcher: Fetcher = (u, i) => fetch(u, i)) {
    this.endpoint = endpoint.replace(/\/+$/, '');
  }

  headers(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async get(url: string, repo = ''): Promise<Response> {
    let res: Response;
    try { res = await this.fetcher(url, { headers: this.headers() }); } catch {
      throw new HFError('hf_unreachable', 'No se pudo conectar con Hugging Face. Comprueba tu conexión a Internet.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new HFError('auth_required', `«${repo}» es un repositorio restringido: acepta su licencia en Hugging Face y añade tu token en Modelos → Avanzado.`);
    }
    if (res.status === 404) throw new HFError('not_found', `No se encontró el repositorio «${repo}».`);
    if (res.status >= 400) throw new HFError('hf_error', `Hugging Face respondió con un error (${res.status}).`);
    return res;
  }

  url(model: Pick<RemoteModel, 'repo' | 'revision'>, path: string): string {
    return `${this.endpoint}/${model.repo}/resolve/${model.revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async fetchModel(repo: string, revision = 'main'): Promise<RemoteModel> {
    validateRepo(repo);
    const info = await (await this.get(`${this.endpoint}/api/models/${repo}${revision !== 'main' ? `?revision=${encodeURIComponent(revision)}` : ''}`, repo)).json();
    const files: Record<string, RemoteFile> = {};
    let url: string | null = `${this.endpoint}/api/models/${repo}/tree/${info.sha || revision}?recursive=true`;
    for (let i = 0; i < 10 && url; i++) { // paginación por cabecera Link
      const res = await this.get(url, repo);
      for (const item of await res.json()) {
        if (item.type !== 'file') continue;
        const lfs = item.lfs ?? {};
        files[item.path] = { path: item.path, size: Number(lfs.size || item.size || 0), sha256: lfs.oid || null };
      }
      url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    }
    const gguf = info.gguf ?? {};
    const tags: string[] = info.tags ?? [];
    const lic = info.cardData?.license || tags.find((t) => t.startsWith('license:'))?.slice(8) || '';
    return { repo, revision: info.sha || revision, license: String(lic || 'desconocida'), architecture: String(gguf.architecture || ''),
      params: Number(gguf.total || 0), contextLength: Number(gguf.context_length || 0), gated: !!info.gated, files };
  }

  async search(query: string, limit = 20): Promise<HFSearchResult[]> {
    const params = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: String(Math.max(1, Math.min(limit, 40))) });
    const q = (query || '').trim().slice(0, 100);
    if (q) params.set('search', q);
    const items = await (await this.get(`${this.endpoint}/api/models?${params}`)).json();
    return (items as Record<string, any>[]).map((item) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const tags: string[] = item.tags ?? [];
      const license = tags.find((t) => t.startsWith('license:'))?.slice(8) || 'desconocida';
      const langs = tags.filter((t) => /^[a-z]{2,3}$/.test(t) && t !== 'gguf');
      if (tags.includes('multilingual')) langs.push('multilingual');
      return { repo: item.id || item.modelId || '', downloads: Number(item.downloads || 0), likes: Number(item.likes || 0), license,
        license_info: licenseInfo(license), gated: !!item.gated, updated: item.lastModified || item.createdAt || '',
        languages: langs.slice(0, 8), task: item.pipeline_tag || '', installed: false };
    }).filter((m) => REPO_RE.test(m.repo));
  }
}

/** El archivo y, si está troceado (`-00001-of-00003.gguf`), todos sus trozos en orden. */
export function shardsOf(model: RemoteModel, path: string): RemoteFile[] {
  const m = SHARD_RE.exec(path);
  const get = (p: string) => {
    const f = model.files[p];
    if (!f) throw new HFError('not_found', `No existe el archivo «${p}» en ${model.repo}.`);
    return f;
  };
  if (!m?.groups) return [get(path)];
  const n = Number(m.groups.n);
  return Array.from({ length: n }, (_, i) => get(`${m.groups!.stem}-${String(i + 1).padStart(5, '0')}-of-${m.groups!.n}.gguf`));
}

export function quantOf(filename: string): string {
  const m = /(?<![A-Za-z0-9])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?![A-Za-z0-9])/i.exec(filename);
  return m ? m[1].toUpperCase() : '';
}

export function modelId(repo: string, filename: string): string {
  const stem = filename.replace(/\.gguf$/i, '');
  const slug = `${repo.split('/').pop()}-${stem}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length >= 3 ? slug.slice(0, 80) : `modelo-${slug}`;
}

/** Ficha de un repositorio para elegir qué archivo instalar, con la compatibilidad de cada cuantización. */
export function describeRepo(remote: RemoteModel, caps: { ram_gb: number; vram_gb: number }, context: number, mobile = false): HFRepoInfo {
  const projectors: { path: string; size: number; quant: string }[] = [];
  const files: HFFile[] = [];
  const paramsB = remote.params ? remote.params / 1e9 : 0;
  for (const [path, f] of Object.entries(remote.files).sort(([a], [b]) => a.localeCompare(b))) {
    const low = path.toLowerCase();
    if (!low.endsWith('.gguf')) continue;
    const name = path.split('/').pop()!;
    if (low.includes('mmproj')) { projectors.push({ path, size: f.size, quant: quantOf(name) }); continue; }
    if (/-\d{5}-of-\d{5}\.gguf$/.test(low) && !/-0*1-of-0*\d+\.gguf$/.test(low)) continue; // solo el primer trozo
    const shards = shardsOf(remote, path);
    const size = shards.reduce((n, s) => n + s.size, 0);
    const params = paramsB || Math.max(size / GIB / 0.6, 0.5);
    const need = estimateMemoryGb(size, params, context, 0, remote.architecture);
    const vram = mobile ? 0 : caps.vram_gb;
    files.push({ path, size, quant: quantOf(name), shards: shards.length, fit: fitModel(need, caps.ram_gb, vram, mobile) });
  }
  files.sort((a, b) => a.size - b.size);
  const suggested = projectors.find((p) => ['F16', 'BF16'].includes(p.quant)) ?? projectors[0] ?? null;
  return { repo: remote.repo, revision: remote.revision, license: licenseInfo(remote.license), gated: remote.gated, arch: remote.architecture,
    params_b: Math.round(paramsB * 100) / 100, context_native: remote.contextLength, files, mmproj: projectors, mmproj_suggested: suggested };
}
