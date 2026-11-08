/** El navegador como dispositivo (desarrollo y pruebas de interfaz): sin plugin nativo, solo lo que el navegador permite saber. */
import type { DeviceCaps } from '@starblitz/shared';
import type { DeviceInfo, DeviceInfoPort } from '../api/localEngine';

export class BrowserDevice implements DeviceInfoPort {
  readonly mobile = true;

  private ramMb(): number {
    const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
    return Math.round(gb * 1024);
  }

  async info(): Promise<DeviceInfo> {
    const est = await navigator.storage?.estimate?.().catch(() => undefined);
    const cores = navigator.hardwareConcurrency || 4;
    return {
      os: 'Navegador', model: 'Navegador', cpu: 'wasm', cores, threads: cores, ram_mb: this.ramMb(),
      free_bytes: Math.max(0, (est?.quota ?? 0) - (est?.usage ?? 0)), total_bytes: est?.quota ?? 0,
    };
  }

  async caps(): Promise<DeviceCaps> {
    return { ram_gb: Math.round((this.ramMb() / 1024) * 10) / 10, vram_gb: 0, gpu: '', cpu: 'wasm', threads: navigator.hardwareConcurrency || 4 };
  }
}
