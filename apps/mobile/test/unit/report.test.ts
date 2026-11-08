/**
 * Informe de rendimiento exportable: contenido, cálculo del resumen, honestidad ante datos ausentes y ausencia de secretos.
 */
import { describe, expect, it } from 'vitest';
import { reportFileName } from '../../src/lib/exportFile';
import type { DeviceSample } from '../../src/engine/pipeline/ports';
import { REPORT_SCHEMA, buildReport, summarize } from '../../src/engine/pipeline/report';
import { makeEnv, seedProject, startRun, waitJob, type FakePage } from './helpers';

const BOOK: Record<string, FakePage> = { p1: { texts: ['おはよう', '待って'] }, p2: { texts: ['先輩！'] }, p3: { texts: ['ありがとう'] } };
const KEYS = Object.keys(BOOK);

/** Dispositivo que se va calentando y gastando batería a cada muestra. */
function warmingGuard() {
  let n = 0;
  return {
    async check() { return { action: 'ok' as const }; },
    async memory() { return { free_mb: 2000, low: false }; },
    async sample(): Promise<DeviceSample> {
      n += 1;
      return { t: 1000 + n, battery_pct: 90 - n, charging: false, battery_temp_c: 30 + n, thermal: n > 4 ? 1 : 0, ram_free_mb: 2400 - n * 100, low_memory: false };
    },
  };
}

async function processAll(env: ReturnType<typeof makeEnv>, pid: string) {
  const job = await waitJob(env, startRun(env, pid).id);
  expect(job.status).toBe('done');
  return (await env.store.get(pid)).last_job as Record<string, unknown>;
}

describe('muestras del dispositivo durante la tarea', () => {
  it('guarda batería, temperatura y memoria libre al empezar, tras cada página y al terminar', async () => {
    const env = makeEnv(BOOK, {}, warmingGuard());
    const p = await seedProject(env, KEYS);
    const lastJob = await processAll(env, p.id);
    const t = lastJob.timings as { pages: { device?: DeviceSample | null }[]; chapter: { device_start: DeviceSample | null; device_end: DeviceSample | null } };
    expect(t.chapter.device_start).not.toBeNull();
    expect(t.chapter.device_end).not.toBeNull();
    expect(t.pages.every((pg) => !!pg.device)).toBe(true);
    // batería y memoria libre decrecen, temperatura sube: se guardó en orden cronológico
    expect(t.chapter.device_end!.battery_temp_c).toBeGreaterThan(t.chapter.device_start!.battery_temp_c);
    expect(t.chapter.device_end!.t).toBeGreaterThan(t.chapter.device_start!.t);
  });

  it('un dispositivo que no informa (o que falla al informar) no estropea la tarea', async () => {
    const broken = { async check() { return { action: 'ok' as const }; }, async sample(): Promise<DeviceSample> { throw new Error('plugin caído'); } };
    const env = makeEnv(BOOK, {}, broken);
    const p = await seedProject(env, KEYS);
    const lastJob = await processAll(env, p.id);
    const t = lastJob.timings as { chapter: { device_start: unknown } };
    expect(t.chapter.device_start).toBeNull();
    expect((await env.store.pages(await env.store.get(p.id))).every((g) => g.status === 'cleaned')).toBe(true);
  });
});

describe('resumen del informe', () => {
  it('calcula totales, medias, caché, tokens/s, temperatura, batería y memoria a partir de last_job.timings', async () => {
    const env = makeEnv(BOOK, {}, warmingGuard());
    const p = await seedProject(env, KEYS);
    const lastJob = await processAll(env, p.id);
    const s = summarize(lastJob, 8192)!;
    expect(s.pages_measured).toBe(3);
    expect(s.total_s).toBeGreaterThan(0);
    expect(s.ocr_calls).toBe(3);
    expect(s.ocr_cache_hits).toBe(0);
    expect(s.llm_calls).toBeGreaterThan(0);
    expect(s.translate_cache_hits).toBe(0);
    expect(s.device.ram_total_mb).toBe(8192);
    expect(s.device.battery_temp_c.max).toBeGreaterThan(s.device.battery_temp_c.start!);
    expect(s.device.battery_pct.drop).toBeGreaterThan(0);
    expect(s.device.ram_free_mb.min).toBeLessThan(s.device.ram_free_mb.start!);
    expect(s.device.system_ram_used_max_mb).toBe(8192 - s.device.ram_free_mb.min!);
    expect(s.device.thermal_max).toBe(1);
    expect(s.slowest_page).not.toBeNull();
    expect(s.preserved_originals).toBe(0);
  });

  it('con caché avisa de que esos tiempos no miden el OCR ni el modelo (no se presentan como medidas)', async () => {
    const env = makeEnv(BOOK);
    await processAll(env, (await seedProject(env, KEYS)).id);
    const second = await processAll(env, (await seedProject(env, KEYS)).id);
    const s = summarize(second, null)!;
    expect(s.ocr_calls).toBe(0);
    expect(s.ocr_cache_hits).toBe(3);
    expect(s.llm_calls).toBe(0);
    expect(s.notes.join(' ')).toMatch(/caché de OCR/);
    expect(s.notes.join(' ')).toMatch(/caché de traducción/);
    expect(s.device.system_ram_used_max_mb).toBeNull();                 // sin RAM total ni libre: no se inventa
  });

  it('sin dispositivo que informe, el resumen dice «no informado» (null) y lo explica', async () => {
    const env = makeEnv(BOOK);
    const lastJob = await processAll(env, (await seedProject(env, KEYS)).id);
    const s = summarize(lastJob, null)!;
    expect(s.device.battery_temp_c).toEqual({ start: null, end: null, max: null });
    expect(s.device.battery_pct.drop).toBeNull();
    expect(s.notes.join(' ')).toMatch(/no informó/);
  });

  it('sin ninguna tarea terminada no hay resumen (no se inventa)', () => {
    expect(summarize(null, 8192)).toBeNull();
    expect(summarize({ pages: 3 }, 8192)).toBeNull();
  });
});

describe('informe completo', () => {
  it('lleva esquema, versión, proyecto, estado, cola y los datos crudos, y no incluye secretos', async () => {
    const env = makeEnv(BOOK, {}, warmingGuard());
    const p = await seedProject(env, KEYS);
    const lastJob = await processAll(env, p.id);
    const r = buildReport({
      generated: 1_700_000_000, appVersion: '1.0.0',
      device: { info: { model: 'Redmi Note 8 Pro', ram_mb: 6144 }, caps: { ram_gb: 6, vram_gb: 0, gpu: '', cpu: 'arm64', threads: 8 }, now: null },
      runtime: { cross_origin_isolated: false, user_agent: 'x' },
      settings: { processing: { profile: 'auto' } }, llm: { active: 'qwen3.5-4b' },
      project: { id: p.id, name: p.name, pages: 3, source_lang: 'ja', detected_lang: 'ja', translation_profile: 'natural' },
      run: null, lastJob, queue: [],
    });
    expect(r.schema).toBe(REPORT_SCHEMA);
    expect(r.generated_at).toBe('2023-11-14T22:13:20.000Z');
    expect(r.summary?.device.ram_total_mb).toBe(6144);
    expect(r.last_job).toBe(lastJob);
    const json = JSON.stringify(r);
    expect(JSON.parse(json).summary.pages_measured).toBe(3);   // es JSON válido y completo
    expect(json).not.toMatch(/hf_token|api_key|password/i);
  });

  it('el nombre de archivo es seguro y legible', () => {
    const when = new Date('2026-11-08T21:05:30Z');
    expect(reportFileName('Mi Manga: ¡Capítulo 1!', when)).toBe('starblitz-informe-Mi-Manga-Capitulo-1-2026-11-08-21-05.json');
    expect(reportFileName('???', when)).toBe('starblitz-informe-proyecto-2026-11-08-21-05.json');
    expect(reportFileName('a/b\\c', when)).not.toMatch(/[\\/]/);
  });
});
