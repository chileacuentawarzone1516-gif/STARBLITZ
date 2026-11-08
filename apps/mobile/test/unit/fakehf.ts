/** Hugging Face simulado (equivalente a `engine/tests/fake_hf.py`): API de modelos, árbol con SHA-256 y descarga con Range. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { blob, sha256 } from './nodefiles';

const SHA = 'a'.repeat(40);

export interface FakeRepo {
  info: Record<string, unknown>;
  files: Record<string, Buffer | { declared: number }>;
  token?: string;
}

export const REPOS: Record<string, FakeRepo> = {
  'fake-org/Tiny-Qwen-GGUF': {
    info: { sha: SHA, gated: false, cardData: { license: 'apache-2.0' }, tags: ['gguf', 'license:apache-2.0', 'ja', 'en', 'multilingual'],
      gguf: { total: 4_000_000_000, architecture: 'qwen35', context_length: 262144 } },
    files: { 'Tiny-Q4_K_M.gguf': blob('q4', 300_000), 'Tiny-Q8_0.gguf': blob('q8', 500_000), 'Big-00001-of-00002.gguf': blob('b1', 120_000),
      'Big-00002-of-00002.gguf': blob('b2', 110_000), 'mmproj-F16.gguf': blob('mm', 80_000), 'README.md': Buffer.from('# demo') },
  },
  'fake-org/Gated-GGUF': {
    info: { sha: SHA, gated: 'manual', cardData: { license: 'gemma' }, tags: ['gguf', 'license:gemma'],
      gguf: { total: 2_000_000_000, architecture: 'gemma4', context_length: 131072 } },
    files: { 'Gated-Q4_0.gguf': blob('g', 100_000) }, token: 'good',
  },
  'fake-org/Huge-GGUF': {
    info: { sha: SHA, gated: false, cardData: { license: 'cc-by-nc-4.0' }, tags: ['gguf', 'license:cc-by-nc-4.0'],
      gguf: { total: 400_000_000_000, architecture: 'llama', context_length: 32768 } },
    files: { 'Huge-Q4_K_M.gguf': { declared: 230_000_000_000 } },
  },
};

export interface FakeHf {
  url: string;
  requests: { kind: string; path: string; range: string; auth: string }[];
  failOnce: Set<string>;
  corrupt: Set<string>;
  close(): Promise<void>;
}

export async function startFakeHf(): Promise<FakeHf> {
  const state = { requests: [] as FakeHf['requests'], failOnce: new Set<string>(), corrupt: new Set<string>() };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': raw.length });
    res.end(raw);
  };
  const authorized = (repo: FakeRepo, req: IncomingMessage) => !repo.token || req.headers.authorization === `Bearer ${repo.token}`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const range = String(req.headers.range ?? ''), auth = String(req.headers.authorization ?? '');
    let m: RegExpExecArray | null;
    if (url.pathname === '/api/models') {
      state.requests.push({ kind: 'search', path: url.searchParams.get('search') ?? '', range, auth });
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      return json(res, 200, Object.entries(REPOS).filter(([id]) => id.toLowerCase().includes(q)).map(([id, r], i) => ({
        id, downloads: 1000 - i, likes: i, tags: r.info.tags, gated: r.info.gated, lastModified: '2026-10-01T00:00:00Z', pipeline_tag: 'text-generation',
      })));
    }
    if ((m = /^\/api\/models\/([^/]+\/[^/]+)(?:\/tree\/[^/]+)?$/.exec(url.pathname))) {
      const repo = REPOS[m[1]];
      if (!repo) return json(res, 404, { error: 'not found' });
      if (!authorized(repo, req)) return json(res, 401, { error: 'gated' });
      if (!url.pathname.includes('/tree/')) return json(res, 200, { id: m[1], ...repo.info });
      return json(res, 200, Object.entries(repo.files).map(([path, data]) => {
        if (!Buffer.isBuffer(data)) return { type: 'file', path, size: data.declared, lfs: { oid: 'f'.repeat(64), size: data.declared } };
        return path.endsWith('.gguf') ? { type: 'file', path, size: 134, lfs: { oid: sha256(data), size: data.length } } : { type: 'file', path, size: data.length };
      }));
    }
    if ((m = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname))) {
      const repo = REPOS[m[1]];
      const path = decodeURIComponent(m[2]);
      let data = repo?.files[path];
      if (!repo || !data || !Buffer.isBuffer(data) || !authorized(repo, req)) { res.statusCode = 404; return res.end(); }
      state.requests.push({ kind: 'resolve', path, range, auth });
      if (state.corrupt.has(path)) data = Buffer.alloc(data.length);
      const r = /bytes=(\d+)-/.exec(range);
      const start = r ? Number(r[1]) : 0;
      const body = data.subarray(start);
      const headers: Record<string, string | number> = { 'Accept-Ranges': 'bytes', 'Content-Length': body.length };
      if (r) headers['Content-Range'] = `bytes ${start}-${data.length - 1}/${data.length}`;
      res.writeHead(r ? 206 : 200, headers);
      if (state.failOnce.has(path) && start === 0) {
        state.failOnce.delete(path);
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      return res.end(body);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, { url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
}
