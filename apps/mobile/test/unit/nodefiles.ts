/** `DeviceFiles` sobre una carpeta temporal (pruebas) y un servidor HTTP con `Range`, fallos y contenido corrupto. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { safePath, type DeviceFiles, type DirEntry, type DownloadHooks, type DownloadRequest, type FileStat } from '../../src/engine/platform/files';
import { resumableDownload, type PartStore, type PartWriter, type TransferOptions } from '../../src/engine/platform/transfer';

export class NodeFiles implements DeviceFiles, PartStore {
  readonly root = mkdtempSync(join(tmpdir(), 'sb-files-'));
  free = 50 * 1024 ** 3;
  downloads: DownloadRequest[] = [];
  constructor(private transfer: TransferOptions = { backoffMs: 5 }) {}

  private p(path: string) { return join(this.root, safePath(path)); }
  dispose() { rmSync(this.root, { recursive: true, force: true }); }

  async stat(path: string): Promise<FileStat> {
    try { const s = await stat(this.p(path)); return { exists: true, size: s.isDirectory() ? 0 : s.size, isDir: s.isDirectory() }; } catch { return { exists: false, size: 0, isDir: false }; }
  }
  async list(dir: string): Promise<DirEntry[]> {
    try {
      const out: DirEntry[] = [];
      for (const e of await readdir(this.p(dir), { withFileTypes: true })) {
        out.push({ name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : (await stat(join(this.p(dir), e.name))).size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  }
  async readBytes(path: string) { return new Uint8Array(await readFile(this.p(path))); }
  async readText(path: string) { try { return await readFile(this.p(path), 'utf8'); } catch { return undefined; } }
  async writeText(path: string, text: string) { await mkdir(dirname(this.p(path)), { recursive: true }); await writeFile(this.p(path), text); }
  async remove(path: string) { await rm(this.p(path), { recursive: true, force: true }); }
  async freeBytes() { return this.free; }
  async absolutePath(path: string) { return this.p(path); }
  async sha256(path: string) {
    const h = createHash('sha256');
    for await (const c of createReadStream(this.p(path))) h.update(c as Buffer);
    return h.digest('hex');
  }
  download(req: DownloadRequest, hooks?: DownloadHooks) {
    this.downloads.push(req);
    return resumableDownload(this, req, hooks, this.transfer);
  }

  // PartStore
  async size(path: string) { return (await this.stat(path)).size; }
  async open(path: string, append: boolean): Promise<PartWriter> {
    await mkdir(dirname(this.p(path)), { recursive: true });
    const ws = createWriteStream(this.p(path), { flags: append ? 'a' : 'w' });
    return {
      write: (chunk) => new Promise((res, rej) => ws.write(chunk, (e) => (e ? rej(e) : res()))),
      close: () => new Promise((res) => ws.end(() => res())),
    };
  }
  async rename(from: string, to: string) { await mkdir(dirname(this.p(to)), { recursive: true }); await rename(this.p(from), this.p(to)); }
}

export interface ServedFile { data: Uint8Array | Buffer; sha256?: string }
export interface HttpFixture {
  url: string;
  files: Map<string, ServedFile>;
  requests: { path: string; range: string; auth: string }[];
  failOnce: Set<string>;
  corrupt: Set<string>;
  needsToken: Map<string, string>;
  ignoreRange: Set<string>;
  close(): Promise<void>;
}

/** Servidor HTTP mínimo que sirve `files` con `Range`; `failOnce` corta la primera descarga a la mitad. */
export async function serveFiles(files: Record<string, Uint8Array | Buffer>): Promise<HttpFixture> {
  const map = new Map<string, ServedFile>(Object.entries(files).map(([k, v]) => [k, { data: v }]));
  const fx = { files: map, requests: [] as HttpFixture['requests'], failOnce: new Set<string>(), corrupt: new Set<string>(), needsToken: new Map<string, string>(), ignoreRange: new Set<string>() };
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);
    const range = String(req.headers.range ?? '');
    const auth = String(req.headers.authorization ?? '');
    fx.requests.push({ path, range, auth });
    const file = map.get(path);
    const need = fx.needsToken.get(path);
    if (!file) { res.statusCode = 404; return res.end(); }
    if (need && auth !== `Bearer ${need}`) { res.statusCode = 401; return res.end(); }
    let data = Buffer.from(file.data);
    if (fx.corrupt.has(path)) data = Buffer.alloc(data.length);
    const m = fx.ignoreRange.has(path) ? null : /bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    if (start >= data.length && m) { res.statusCode = 416; return res.end(); }
    const body = data.subarray(start);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(body.length));
    if (m) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${data.length - 1}/${data.length}`); }
    if (fx.failOnce.has(path) && start === 0) {
      fx.failOnce.delete(path);
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fx, { url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}

/** Contenido determinista de `size` bytes. */
export function blob(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let block = createHash('sha256').update(seed).digest();
  for (let i = 0; i < size; i += 32) { block = createHash('sha256').update(block).digest(); block.copy(out, i, 0, Math.min(32, size - i)); }
  return out;
}

export const sha256 = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
