import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, DeviceStatusGuard, type DeviceStatus } from '../../src/engine/device/guard';
import type { DeviceGuard, GuardVerdict } from '../../src/engine/pipeline/ports';
import { describeRun } from '../../src/engine/pipeline/runstate';
import { makeEnv, seedProject, startRun, waitJob } from './helpers';

const ok: DeviceStatus = { battery_pct: 80, charging: false, battery_temp_c: 33, thermal: 0, power_save: false, ram_free_mb: 3000, low_memory: false };
const guardWith = (s: Partial<DeviceStatus> | null, free = 5e9, onLow?: () => void) =>
  new DeviceStatusGuard(async () => (s === null ? null : { ...ok, ...s }), async () => free, DEFAULT_LIMITS, onLow);

describe('guarda del dispositivo (unitaria)', () => {
  it('con el teléfono sano deja seguir', async () => {
    expect((await guardWith({}).check()).action).toBe('ok');
  });

  it('pausa con la batería baja si no está cargando, y no si está enchufado', async () => {
    const low = await guardWith({ battery_pct: 9 }).check();
    expect(low).toMatchObject({ action: 'pause', code: 'battery_low' });
    expect(low.message).toContain('9 %');
    expect((await guardWith({ battery_pct: 9, charging: true }).check()).action).toBe('ok');
    expect((await guardWith({ battery_pct: -1 }).check()).action).toBe('ok'); // sin dato no se bloquea
  });

  it('espera si hace calor y pausa si es peligroso', async () => {
    expect(await guardWith({ thermal: 3 }).check()).toMatchObject({ action: 'wait', code: 'cooling', waitMs: DEFAULT_LIMITS.coolWaitMs });
    expect(await guardWith({ battery_temp_c: 43 }).check()).toMatchObject({ action: 'wait', code: 'cooling' });
    expect(await guardWith({ thermal: 4 }).check()).toMatchObject({ action: 'pause', code: 'too_hot' });
    expect(await guardWith({ battery_temp_c: 47 }).check()).toMatchObject({ action: 'pause', code: 'too_hot' });
  });

  it('con poca memoria avisa para soltar recursos y espera', async () => {
    let freed = 0;
    expect(await guardWith({ low_memory: true }, 5e9, () => { freed += 1; }).check()).toMatchObject({ action: 'wait', code: 'low_memory' });
    expect(freed).toBe(1);
  });

  it('pausa si queda poco espacio, incluso sin datos de batería', async () => {
    expect(await guardWith(null, 50 * 1024 * 1024).check()).toMatchObject({ action: 'pause', code: 'storage_low' });
    expect((await guardWith(null, 5e9).check()).action).toBe('ok');
  });
});

/** Guarda programable para probar la integración con el procesador. */
class ScriptedGuard implements DeviceGuard {
  checks = 0;
  constructor(private verdict: (n: number) => GuardVerdict) {}
  async check() { this.checks += 1; return this.verdict(this.checks); }
}

describe('guarda del dispositivo (integración con el procesador)', () => {
  const pages = { a: { texts: ['一'] }, b: { texts: ['二'] }, c: { texts: ['三'] } };

  it('pausa la tarea sola por batería baja, conserva lo hecho y continúa al reanudar sin repetir trabajo', async () => {
    let battery = true;
    const guard = new ScriptedGuard(() => (battery
      ? { action: 'pause', code: 'battery_low', message: 'Batería al 8 %: pausado.' } : { action: 'ok' }));
    const env = makeEnv(pages, {}, guard);
    const project = await seedProject(env, ['a', 'b', 'c']);
    const job = startRun(env, project.id);
    const paused = await waitJob(env, job.id, (s) => s === 'paused');
    expect(paused.message).toContain('Batería');
    const info = await describeRun(env.store, project.id, true);
    expect(info?.status).toBe('paused');           // queda guardado: si la app se cierra aquí, se ofrece reanudar
    expect(env.vision.analyzed.length).toBe(0);   // se frenó antes de gastar batería
    battery = false;
    env.jobs.resume(job.id);
    const done = await waitJob(env, job.id);
    expect(done.status).toBe('done');
    expect(env.vision.analyzed.filter((k) => k === 'a').length).toBe(1);
    expect(env.vision.analyzed.sort()).toEqual(['a', 'b', 'c']);
  });

  it('si hace calor espera y sigue sola cuando baja la temperatura, sin contar la espera en el tiempo estimado', async () => {
    const guard = new ScriptedGuard((n) => (n <= 2 ? { action: 'wait', code: 'cooling', waitMs: 10, message: 'Caliente: esperando…' } : { action: 'ok' }));
    const env = makeEnv(pages, {}, guard);
    const project = await seedProject(env, ['a', 'b']);
    const job = startRun(env, project.id);
    const done = await waitJob(env, job.id);
    expect(done.status).toBe('done');
    expect(guard.checks).toBeGreaterThan(2);
    expect(env.events.some((e) => e.type === 'job' && e.job.message.includes('Caliente'))).toBe(true);
  });

  it('cancelar mientras espera por calor termina la tarea de inmediato', async () => {
    const guard = new ScriptedGuard(() => ({ action: 'wait', code: 'cooling', waitMs: 60_000, message: 'Caliente…' }));
    const env = makeEnv(pages, {}, guard);
    const project = await seedProject(env, ['a']);
    const job = startRun(env, project.id);
    await waitJob(env, job.id, (s) => s === 'running');
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    env.jobs.cancel(job.id);
    const done = await waitJob(env, job.id);
    expect(done.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('un fallo al leer el estado del teléfono no detiene el trabajo', async () => {
    const guard: DeviceGuard = { check: async () => { throw new Error('sensor no disponible'); } };
    const env = makeEnv(pages, {}, guard);
    const project = await seedProject(env, ['a']);
    expect((await waitJob(env, startRun(env, project.id).id)).status).toBe('done');
  });
});
