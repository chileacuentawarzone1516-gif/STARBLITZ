/**
 * Control térmico adaptativo (ThermalPacer). Verifica la LÓGICA con señales simuladas; NO demuestra que evite el throttling real:
 * eso se calibra y se mide en el Redmi (docs/VALIDACION-TERMICA-ANDROID.md). Los parámetros por defecto son hipótesis no calibradas.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PACER, ThermalPacer, type PacerConfig } from '../../src/engine/device/pacer';
import type { DeviceSample } from '../../src/engine/pipeline/ports';
import { makeEnv, pagesOf, seedProject, startRun, waitJob } from './helpers';

const sample = (o: Partial<DeviceSample> = {}): DeviceSample => ({
  t: 1, battery_pct: 80, charging: false, battery_temp_c: 33, thermal: 0, thermal_headroom: -1, ram_free_mb: 2000, low_memory: false, ...o,
});

/** Lector que va entregando una secuencia de muestras (la última se repite). */
function reader(seq: Partial<DeviceSample>[]) {
  let i = 0;
  return async () => sample(seq[Math.min(i++, seq.length - 1)]);
}

function pacer(seq: Partial<DeviceSample>[], cfg: Partial<PacerConfig> = {}) {
  const slept: number[] = [];
  const p = new ThermalPacer(reader(seq), async (ms) => { slept.push(ms); }, { ...DEFAULT_PACER, ...cfg });
  return { p, slept };
}

describe('presión térmica a partir de lo que el dispositivo informa', () => {
  it('estado térmico de Android: sube con el estado y no inventa nada si es normal', () => {
    const p = (thermal: number) => ThermalPacer.pressure(sample({ thermal })).p;
    expect(p(0)).toBe(0);
    expect(p(1)).toBeGreaterThan(0);
    expect(p(2)).toBeGreaterThan(p(1));
    expect(p(3)).toBeGreaterThan(p(2));
    expect(p(4)).toBe(1);
    expect(ThermalPacer.pressure(sample({ thermal: 2 })).source).toBe('os');
  });

  it('margen térmico: rampa de 0,5 a 1,0; manda el mayor de estado y margen', () => {
    const h = (v: number, thermal = 0) => ThermalPacer.pressure(sample({ thermal, thermal_headroom: v })).p;
    expect(h(0.4)).toBe(0);
    expect(h(0.75)).toBeCloseTo(0.5, 5);
    expect(h(1.2)).toBe(1);
    expect(h(0.5, 3)).toBeCloseTo(0.85, 5);     // el estado del sistema ya era más alto
    expect(ThermalPacer.pressure(sample({ thermal: -1, thermal_headroom: -1 })).source).toBe('battery');
  });

  it('sin API térmica (Android 9) usa SOLO la batería y lo dice; sin ningún dato, no actúa', () => {
    const cool = ThermalPacer.pressure(sample({ thermal: -1, battery_temp_c: 33 }));
    const hot = ThermalPacer.pressure(sample({ thermal: -1, battery_temp_c: 44 }));
    expect(cool).toMatchObject({ p: 0, source: 'battery' });
    expect(hot.p).toBeGreaterThan(0.8);
    expect(hot.reason).toMatch(/sin API térmica/);
    expect(ThermalPacer.pressure(sample({ thermal: -1, battery_temp_c: 0 }))).toMatchObject({ p: 0, source: 'none' });
  });
});

describe('controlador: sube deprisa, baja despacio, con tope', () => {
  it('con el teléfono frío no descansa nunca', async () => {
    const { p, slept } = pacer([{ thermal: 0 }]);
    for (let i = 0; i < 20; i++) await p.afterWork(10_000);
    expect(p.idle).toBe(0);
    expect(slept).toEqual([]);
    expect(p.summary()).toMatchObject({ idle_s: 0, throttle_samples: 0, max_status: 0, source: 'os' });
  });

  it('al aparecer presión el descanso sube rápido y nunca pasa del máximo', () => {
    const { p } = pacer([{}]);
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) { p.observe(sample({ thermal: 3 })); seen.push(p.idle); }
    expect(seen[0]).toBeGreaterThan(0.2);                                   // reacción en la primera observación
    expect(seen.every((x, i) => i === 0 || x >= seen[i - 1])).toBe(true);   // monótono mientras dura la presión
    expect(Math.max(...seen)).toBeLessThanOrEqual(DEFAULT_PACER.maxIdle);
  });

  it('al relajarse baja más despacio de lo que subió', () => {
    const { p } = pacer([{}]);
    p.observe(sample({ thermal: 3 }));
    const up = p.idle;
    p.observe(sample({ thermal: 0 }));
    const afterOneCool = p.idle;
    expect(afterOneCool).toBeGreaterThan(up * 0.5);                         // no se «olvida» de golpe
    for (let i = 0; i < 60; i++) p.observe(sample({ thermal: 0 }));
    expect(p.idle).toBe(0);                                                  // y acaba recuperando el pleno rendimiento
  });
});

describe('descansos y pausas', () => {
  it('descansa trabajo·idle/(1−idle): el ciclo de trabajo queda en 1−idle', async () => {
    const { p, slept } = pacer([{ thermal: 2 }]);
    for (let i = 0; i < 30; i++) await p.afterWork(10_000);                  // ahora idle ≈ objetivo
    const last = slept[slept.length - 1];
    expect(last / (10_000 + last)).toBeCloseTo(p.idle, 2);
    expect(p.summary().throttle_samples).toBe(30);
    expect(p.summary().idle_s).toBeGreaterThan(0);
  });

  it('en estado crítico pausa y reanuda sola cuando el sistema se recupera', async () => {
    const { p, slept } = pacer([{ thermal: 4 }, { thermal: 4 }, { thermal: 2 }, { thermal: 1 }], { pausePollMs: 5 });
    const msgs: string[] = [];
    const r = await p.afterWork(5_000, undefined, (m) => msgs.push(m));
    expect(r.paused).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(2);                          // esperó varias veces hasta ≤ LIGHT
    expect(p.summary().pauses).toBe(1);
    expect(msgs[0]).toMatch(/caliente/);
  });

  it('una pausa tiene tope: si el sistema no se recupera, la tarea continúa (la guarda general decide)', async () => {
    const { p } = pacer([{ thermal: 5 }], { pausePollMs: 2, pauseMaxMs: 30 });
    const t0 = Date.now();
    const r = await p.afterWork(1_000);
    expect(r.paused).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('una cancelación interrumpe la pausa', async () => {
    const { p } = pacer([{ thermal: 5 }], { pausePollMs: 2, pauseMaxMs: 60_000 });
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await p.afterWork(1_000, ac.signal);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('sin datos (o con el lector roto) no descansa ni falla', async () => {
    const broken = new ThermalPacer(async () => { throw new Error('plugin caído'); }, async () => { throw new Error('no debería dormir'); });
    expect(await broken.afterWork(10_000)).toMatchObject({ slept_ms: 0, paused: false });
    const none = new ThermalPacer(async () => null, async () => { throw new Error('no debería dormir'); });
    expect(await none.afterWork(10_000)).toMatchObject({ slept_ms: 0 });
    expect(none.summary().source).toBe('none');
  });
});

describe('integración con el procesador', () => {
  const BOOK = { p1: { texts: ['おはよう'] }, p2: { texts: ['先輩！'] }, p3: { texts: ['待って'] } };

  it('con presión térmica descansa entre páginas, termina todo y deja las estadísticas en el informe', async () => {
    const slept: number[] = [];
    const p = new ThermalPacer(reader([{ thermal: 2, thermal_headroom: 0.8 }]), async (ms) => { slept.push(ms); });
    const env = makeEnv(BOOK, {}, undefined, undefined, { pacer: p });
    const project = await seedProject(env, ['p1', 'p2', 'p3']);
    const job = await waitJob(env, startRun(env, project.id).id);
    expect(job.status).toBe('done');
    expect((await pagesOf(env, project)).every((g) => g.status === 'cleaned')).toBe(true);   // nada se pierde por descansar
    expect(slept.length).toBe(3);                                                              // un descanso por página
    const t = (await env.store.get(project.id)).last_job as { timings: { chapter: { thermal: { throttle_samples: number; idle_s: number; source: string } | null } } };
    expect(t.timings.chapter.thermal).toMatchObject({ source: 'os', throttle_samples: 3 });
  });

  it('con el teléfono frío no añade ninguna espera; sin pacer (PC) el informe no trae sección térmica', async () => {
    const slept: number[] = [];
    const env = makeEnv(BOOK, {}, undefined, undefined, { pacer: new ThermalPacer(reader([{ thermal: 0 }]), async (ms) => { slept.push(ms); }) });
    const pr = await seedProject(env, ['p1', 'p2', 'p3']);
    await waitJob(env, startRun(env, pr.id).id);
    expect(slept).toEqual([]);

    const env2 = makeEnv(BOOK, {}, undefined, undefined, { pacer: null });
    const pr2 = await seedProject(env2, ['p1']);
    await waitJob(env2, startRun(env2, pr2.id).id);
    const t = (await env2.store.get(pr2.id)).last_job as { timings: { chapter: { thermal: unknown } } };
    expect(t.timings.chapter.thermal).toBeNull();
  });
});
