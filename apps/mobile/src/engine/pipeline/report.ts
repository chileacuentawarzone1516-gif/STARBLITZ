/**
 * Informe de rendimiento exportable (JSON): reúne, SIN modificar nada del motor, lo que se midió en la última tarea de un proyecto
 * (`project.last_job.timings`), el estado del proyecto y del dispositivo, y un resumen calculado con esos mismos datos.
 *
 * Qué NO contiene: contraseñas, tokens (el de Hugging Face queda fuera), imágenes ni textos del manga. Solo cifras y ajustes.
 * Qué NO puede medir: la memoria que consume la app por sí sola (Android no la entrega al WebView). Se informa la memoria libre
 * del sistema; para la de la app hay que usar `adb shell dumpsys meminfo app.starblitz.mobile` (ver docs/VALIDACION-FASE4-ANDROID.md).
 */
import type { DeviceCaps, QueueEntry, RunInfo } from '@starblitz/shared';
import type { DeviceSample } from './ports';
import type { PageTiming, TimingSummary } from './processor';

export const REPORT_SCHEMA = 'starblitz-report/1';

export interface ReportInput {
  generated: number;
  appVersion: string;
  device: { info: unknown; caps: DeviceCaps; now: DeviceSample | null };
  runtime: { cross_origin_isolated: boolean | null; user_agent: string };
  settings: Record<string, unknown>;
  llm: Record<string, unknown>;
  project: { id: string; name: string; pages: number; source_lang: string; detected_lang: string; translation_profile: string };
  run: RunInfo | null;
  lastJob: Record<string, unknown> | null;
  queue: QueueEntry[];
}

export interface ReportSummary {
  pages_measured: number;
  total_s: number | null;
  stages_s: { ocr: number; translate: number; clean: number };
  per_page_avg_s: { ocr: number; translate: number; clean: number };
  slowest_page: { page: number; total_s: number } | null;
  llm_tokens_per_s: { avg: number; min: number; max: number } | null;
  ocr_calls: number | null;
  ocr_cache_hits: number | null;
  llm_calls: number | null;
  translate_cache_hits: number | null;
  model_load_s: number | null;
  trims: number | null;
  overlapped_pages: number | null;
  concurrency_plan: string;
  preserved_originals: number | null;
  device: {
    ram_total_mb: number | null;
    ram_free_mb: { start: number | null; end: number | null; min: number | null };
    /** Estimación del sistema completo (total − libre mínima), NO de la app sola. */
    system_ram_used_max_mb: number | null;
    battery_pct: { start: number | null; end: number | null; drop: number | null };
    battery_temp_c: { start: number | null; end: number | null; max: number | null };
    thermal_max: number | null;
    charging_at_start: boolean | null;
  };
  /** Avisos de lectura honestos sobre lo que el informe no puede afirmar. */
  notes: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const known = (n: number | undefined | null): n is number => typeof n === 'number' && n >= 0 && Number.isFinite(n);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const minOf = (xs: number[]) => (xs.length ? Math.min(...xs) : null);

/** Calcula el resumen a partir de `last_job.timings` (o `null` si todavía no hay una tarea terminada). */
export function summarize(lastJob: Record<string, unknown> | null, ramTotalMb: number | null): ReportSummary | null {
  const t = lastJob?.timings as TimingSummary | undefined;
  if (!t || !Array.isArray(t.pages)) return null;
  const pages: PageTiming[] = t.pages;
  const c = t.chapter;
  const n = pages.length;
  const sum = (k: 'analyze_s' | 'translate_s' | 'clean_s') => pages.reduce((a, p) => a + (p[k] || 0), 0);
  const avg = (k: 'analyze_s' | 'translate_s' | 'clean_s') => (n ? r1(sum(k) / n) : 0);
  const slowest = pages.map((p) => ({ page: p.page, total_s: r1(p.analyze_s + p.translate_s + p.clean_s) })).sort((a, b) => b.total_s - a.total_s)[0] ?? null;
  const tps = pages.map((p) => p.llm_tps).filter((x) => x > 0);
  const samples = [c?.device_start, ...pages.map((p) => p.device), c?.device_end].filter((s): s is DeviceSample => !!s);
  const temps = samples.map((s) => s.battery_temp_c).filter(known);
  const free = samples.map((s) => s.ram_free_mb).filter(known);
  const ds = c?.device_start ?? null;
  const de = c?.device_end ?? null;
  const minFree = known(c?.min_free_mb) ? Math.min(c!.min_free_mb as number, ...(free.length ? free : [Infinity])) : minOf(free);
  const notes: string[] = [];
  if (!samples.length) notes.push('El dispositivo no informó batería, temperatura ni memoria durante la tarea (normal en el navegador de desarrollo).');
  if (c && c.ocr_cache_hits > 0) notes.push(`${c.ocr_cache_hits} página(s) salieron de la caché de OCR: sus tiempos de lectura NO son una medida del OCR.`);
  if (c && c.translate_cache_hits > 0) notes.push(`${c.translate_cache_hits} respuesta(s) salieron de la caché de traducción: sus tiempos NO son una medida del modelo.`);
  notes.push('«system_ram_used_max_mb» es del sistema completo, no de la app. «llm_tokens_per_s» usa la última llamada de cada página.');
  notes.push('Es el informe de la ÚLTIMA tarea terminada del proyecto: si se interrumpió, solo cuenta las páginas de la tarea que sí terminó.');
  return {
    pages_measured: n,
    total_s: c ? r1(c.total_s) : null,
    stages_s: { ocr: r1(sum('analyze_s')), translate: r1(sum('translate_s')), clean: r1(sum('clean_s')) },
    per_page_avg_s: { ocr: avg('analyze_s'), translate: avg('translate_s'), clean: avg('clean_s') },
    slowest_page: slowest,
    llm_tokens_per_s: tps.length ? { avg: r1(tps.reduce((a, b) => a + b, 0) / tps.length), min: r1(Math.min(...tps)), max: r1(Math.max(...tps)) } : null,
    ocr_calls: c ? (c.ocr_calls ?? c.ocr_cache_misses) : null,
    ocr_cache_hits: c ? c.ocr_cache_hits : null,
    llm_calls: c ? c.llm_calls : null,
    translate_cache_hits: c ? c.translate_cache_hits : null,
    model_load_s: c ? c.model_load_s : null,
    trims: c ? c.trims : null,
    overlapped_pages: c ? c.overlapped_pages : null,
    concurrency_plan: c?.plan ?? '',
    preserved_originals: typeof lastJob?.preserved === 'number' ? lastJob.preserved : null,
    device: {
      ram_total_mb: ramTotalMb,
      ram_free_mb: { start: known(ds?.ram_free_mb) ? ds!.ram_free_mb : null, end: known(de?.ram_free_mb) ? de!.ram_free_mb : null, min: minFree },
      system_ram_used_max_mb: ramTotalMb !== null && minFree !== null ? Math.round(ramTotalMb - minFree) : null,
      battery_pct: {
        start: known(ds?.battery_pct) ? ds!.battery_pct : null, end: known(de?.battery_pct) ? de!.battery_pct : null,
        drop: known(ds?.battery_pct) && known(de?.battery_pct) ? ds!.battery_pct - de!.battery_pct : null,
      },
      battery_temp_c: { start: known(ds?.battery_temp_c) ? ds!.battery_temp_c : null, end: known(de?.battery_temp_c) ? de!.battery_temp_c : null, max: maxOf(temps) },
      thermal_max: maxOf(samples.map((s) => s.thermal).filter(known)),
      charging_at_start: ds ? ds.charging : null,
    },
    notes,
  };
}

export function buildReport(i: ReportInput) {
  const ramTotal = (i.device.info as { ram_mb?: number } | null)?.ram_mb;
  return {
    schema: REPORT_SCHEMA,
    generated_at: new Date(i.generated * 1000).toISOString(),
    app_version: i.appVersion,
    device: i.device,
    runtime: i.runtime,
    settings: i.settings,
    llm: i.llm,
    project: i.project,
    run: i.run ? { status: i.run.status, interrupted: i.run.interrupted, resumable: i.run.resumable, stages: i.run.stages, counts: i.run.counts } : null,
    queue: i.queue.filter((e) => e.project_id === i.project.id),
    summary: summarize(i.lastJob, typeof ramTotal === 'number' ? ramTotal : null),
    /** Datos crudos tal como los guardó el motor (incluye `timings.pages` con una fila por página). */
    last_job: i.lastJob,
  };
}

export type PerformanceReport = ReturnType<typeof buildReport>;
