/** El teléfono como dispositivo del motor: capacidades para elegir perfil y modelo, y estado en vivo para la guarda. */
import type { DeviceCaps } from '@starblitz/shared';
import type { DeviceInfo, DeviceInfoPort } from '../api/localEngine';
import type { DeviceStatus } from '../device/guard';
import type { NativeDeviceInfo, StarblitzNativePlugin } from './native';

/** Si el sistema no responde se asume un teléfono modesto: es preferible quedarse corto que agotar la memoria. */
const FALLBACK: NativeDeviceInfo = {
  os: 'Android', model: 'Teléfono', cpu: 'arm64', abis: ['arm64-v8a'], cores: 4, ram_mb: 4096, free_bytes: 0, total_bytes: 0, low_ram_device: false, debuggable: false,
};

export class AndroidDevice implements DeviceInfoPort {
  readonly mobile = true;
  private cached: Promise<NativeDeviceInfo> | null = null;

  constructor(private native: StarblitzNativePlugin) {}

  private load(): Promise<NativeDeviceInfo> {
    this.cached ??= this.native.deviceInfo().catch((e) => { this.cached = null; console.warn('No se pudo leer la información del teléfono', e); return FALLBACK; });
    return this.cached;
  }

  async info(): Promise<DeviceInfo> {
    const d = await this.load();
    const free = await this.native.fsFreeBytes().then((r) => r.bytes, () => d.free_bytes);
    return {
      os: d.os, model: d.model, cpu: d.cpu, cores: d.cores, threads: d.cores, ram_mb: d.ram_mb, free_bytes: free, total_bytes: d.total_bytes,
    };
  }

  async caps(): Promise<DeviceCaps> {
    const d = await this.load();
    return { ram_gb: Math.round((d.ram_mb / 1024) * 10) / 10, vram_gb: 0, gpu: '', cpu: d.abis.includes('arm64-v8a') ? 'arm64' : (d.abis[0] ?? 'unknown'), threads: d.cores };
  }

  /** Batería, temperatura, ahorro de energía y memoria libre ahora mismo; `null` si el sistema no lo da. */
  status(): Promise<DeviceStatus | null> {
    return this.native.deviceStatus().catch(() => null);
  }

  freeBytes(): Promise<number> {
    return this.native.fsFreeBytes().then((r) => r.bytes, () => Number.MAX_SAFE_INTEGER);
  }

  keepAwake(enabled: boolean): Promise<void> {
    return this.native.keepAwake({ enabled }).catch(() => undefined);
  }
}
