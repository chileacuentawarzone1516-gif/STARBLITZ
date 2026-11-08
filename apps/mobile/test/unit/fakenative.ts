/**
 * Plugin nativo simulado: cumple el mismo contrato que `StarblitzNativePlugin` pero sobre una carpeta temporal y `fetch`.
 * Sirve para probar `NativeFiles`, `NativeLlamaHost`, `AndroidDevice` y el arranque sin un teléfono. NO prueba el código
 * Java (eso lo cubre `NativeIoSelfTest` en la JVM) ni el comportamiento real de Android.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeDeviceInfo, NativeDownloadArgs, NativeListener, NativeProgressEvent, StarblitzNativePlugin } from '../../src/engine/host/native';
import type { DeviceStatus } from '../../src/engine/device/guard';

export class NativeFail extends Error {
  constructor(readonly code: string, message = code, readonly data?: { log?: string[] }) { super(message); }
}

export const PHONE: NativeDeviceInfo = {
  os: 'Android 14', model: 'Pixel Test', cpu: 'arm64-v8a', abis: ['arm64-v8a', 'armeabi-v7a'], cores: 8, ram_mb: 8192,
  free_bytes: 40 * 1024 ** 3, total_bytes: 128 * 1024 ** 3, low_ram_device: false, debuggable: false,
};

export const OK_STATUS: DeviceStatus = { battery_pct: 80, charging: false, battery_temp_c: 30, thermal: 0, power_save: false, ram_free_mb: 3000, low_memory: false };

export class FakeNative implements StarblitzNativePlugin {
  readonly root = mkdtempSync(join(tmpdir(), 'sb-native-'));
  info: NativeDeviceInfo = { ...PHONE };
  status: DeviceStatus | Error = { ...OK_STATUS };
  free = 20 * 1024 ** 3;
  llamaPresent = true;
  llamaState = { running: false, starts: [] as { model: string; args: string[]; timeoutMs?: number }[], stops: 0, log: ['llama ok'] };
  llamaFail: NativeFail | null = null;
  awake: boolean[] = [];
  downloads: NativeDownloadArgs[] = [];
  cancelled: string[] = [];
  /** Bytes que se sirven por URL (en lugar de red real). */
  served = new Map<string, Uint8Array>();
  private listeners = new Set<(e: NativeProgressEvent) => void>();
  private readonly active = new Map<string, AbortController>();

  dispose() { rmSync(this.root, { recursive: true, force: true }); }
  abs(path: string) { return join(this.root, path); }

  private guardPath(path: string): string {
    if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')) throw new NativeFail('invalid_path');
    return this.abs(path);
  }

  async fsStat({ path }: { path: string }) {
    try { const s = await stat(this.guardPath(path)); return { exists: true, isDir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size }; } catch (e) {
      if (e instanceof NativeFail) throw e;
      return { exists: false, isDir: false, size: 0 };
    }
  }
  async fsList({ path }: { path: string }) {
    try {
      const p = this.guardPath(path);
      const entries = [];
      for (const e of await readdir(p, { withFileTypes: true })) entries.push({ name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : (await stat(join(p, e.name))).size });
      return { entries };
    } catch (e) { if (e instanceof NativeFail) throw e; return { entries: [] }; }
  }
  async fsRemove({ path }: { path: string }) { await rm(this.guardPath(path), { recursive: true, force: true }); }
  async fsFreeBytes() { return { bytes: this.free }; }
  async fsSha256({ path }: { path: string }) { return { sha256: createHash('sha256').update(await readFile(this.guardPath(path))).digest('hex') }; }
  async fsWriteText({ path, text }: { path: string; text: string }) { const p = this.guardPath(path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); }
  async fsReadText({ path }: { path: string }) { try { return { text: await readFile(this.guardPath(path), 'utf8') }; } catch (e) { if (e instanceof NativeFail) throw e; return {}; } }
  async fsAbsolutePath({ path }: { path: string }) { return { path: this.guardPath(path) }; }

  saved: { name: string; mime: string; bytes: number }[] = [];
  async fsAppendBase64({ path, data, truncate }: { path: string; data: string; truncate?: boolean }) {
    const p = this.guardPath(path);
    await mkdir(dirname(p), { recursive: true });
    const bytes = Buffer.from(data, 'base64');
    if (truncate) await writeFile(p, bytes); else await appendFile(p, bytes);
    return { size: (await stat(p)).size };
  }
  async saveToDownloads({ path, name, mime }: { path: string; name: string; mime: string }) {
    const s = await stat(this.guardPath(path));
    this.saved.push({ name, mime, bytes: s.size });
    return { location: `Descargas/STARBLITZ/${name}` };
  }

  async download(a: NativeDownloadArgs): Promise<void> {
    this.downloads.push(a);
    const dest = this.guardPath(a.path);
    if (!a.url.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(a.url)) throw new NativeFail('insecure');
    const data = this.served.get(a.url);
    if (!data) throw new NativeFail('not_found');
    const ctl = new AbortController();
    this.active.set(a.id, ctl);
    try {
      const part = `${dest}.part`;
      await mkdir(dirname(dest), { recursive: true });
      await rm(part, { force: true });
      const step = Math.max(1, Math.floor(data.length / 4));
      for (let off = 0; off < data.length; off += step) {
        if (ctl.signal.aborted) throw new NativeFail('cancelled');
        await appendFile(part, data.subarray(off, off + step));
        this.emit({ id: a.id, done: Math.min(data.length, off + step), total: data.length });
        await new Promise((r) => setTimeout(r, 1));
      }
      if ((a.expectedSize && a.expectedSize !== data.length) || (a.sha256 && createHash('sha256').update(data).digest('hex') !== a.sha256)) {
        await rm(part, { force: true });
        throw new NativeFail('integrity');
      }
      await rename(part, dest);
    } finally {
      this.active.delete(a.id);
    }
  }
  async cancelDownload({ id }: { id: string }) { this.cancelled.push(id); this.active.get(id)?.abort(); }

  async llamaAvailable() { return { available: this.llamaPresent }; }
  async llamaStart(a: { model: string; args: string[]; timeoutMs?: number }) {
    this.llamaState.starts.push(a);
    if (this.llamaFail) throw this.llamaFail;
    this.llamaState.running = true;
    return { baseUrl: 'http://127.0.0.1:43210', pid: 4242 };
  }
  async llamaStop() { this.llamaState.stops++; this.llamaState.running = false; }
  async llamaIsRunning() { return { running: this.llamaState.running }; }
  async llamaLog({ lines }: { lines: number }) { return { lines: this.llamaState.log.slice(-lines) }; }

  async deviceInfo() { return this.info; }
  async deviceStatus() { if (this.status instanceof Error) throw this.status; return this.status; }
  async keepAwake({ enabled }: { enabled: boolean }) { this.awake.push(enabled); }

  async addListener(_event: 'downloadProgress', cb: (e: NativeProgressEvent) => void): Promise<NativeListener> {
    this.listeners.add(cb);
    return { remove: async () => { this.listeners.delete(cb); } };
  }
  private emit(e: NativeProgressEvent) { for (const l of this.listeners) l(e); }
}
