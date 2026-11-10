/**
 * Render de páginas traducidas en <canvas>. Es el mismo código para la vista
 * del editor, la app móvil y la exportación, así que lo que se ve es lo que se
 * exporta.
 */
import type { FontRole, Page, Region, TextStyle } from '../types';
import { cssFont, FONT_ROLES } from './fonts';
import { layoutText, type LayoutResult, type Measure } from './layout';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx2D | null = null;

function getMeasureCtx(): Ctx2D {
  if (!measureCtx) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
    measureCtx = canvas.getContext('2d') as Ctx2D;
  }
  return measureCtx;
}

export function makeMeasure(style: TextStyle, ctx: Ctx2D = getMeasureCtx()): Measure {
  return (text, size) => {
    ctx.font = cssFont(style, size);
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${style.letter_spacing * size / 20}px`;
    return ctx.measureText(text).width;
  };
}

/** Suelo absoluto del cuerpo de letra (fracción de la altura de página): por debajo no se rotula, se conserva el original. */
export const MIN_FONT_FLOOR = 0.005;
/** Cuánto puede bajar la letra respecto al cuerpo del texto ORIGINAL: si el original se leía a ese tamaño, la traducción también. */
export const MIN_FONT_VS_ORIGINAL = 0.75;
/** Papel con tipografía condensada que se prueba cuando el texto no cabe con la suya. */
export const CONDENSED_ROLE: FontRole = 'narration';

export function sizeBounds(region: Region, page: Pick<Page, 'height'>): { min: number; max: number } {
  const role = FONT_ROLES[region.style.font] ?? FONT_ROLES.dialogue;
  // Antes el mínimo era fijo (0,8 % de la página, 24 px en una página de 3 000 px), mayor que el rotulado condensado de un cómic
  // occidental: un 36 % de los textos no cabía (medido el 2026-11-09). Ahora puede bajar hasta el 75 % del cuerpo original.
  const fixed = Math.max(8, page.height * 0.008);
  const relative = region.line_size > 0 ? region.line_size * MIN_FONT_VS_ORIGINAL : fixed;
  const min = Math.max(8, page.height * MIN_FONT_FLOOR, Math.min(fixed, relative));
  const [, y1, , y2] = region.layout_box;
  const base = region.line_size > 0 ? region.line_size : (y2 - y1) / 4;
  const max = Math.max(min + 1, Math.min(base * 1.2 * role.scale, (y2 - y1) * 0.9, page.height * 0.06));
  return { min, max };
}

const layoutCache = new Map<string, LayoutResult>();

export function layoutRegion(region: Region, page: Pick<Page, 'height'>): LayoutResult {
  const s = region.style;
  const key = JSON.stringify([region.translation, region.layout_box, region.bubble?.polygon?.length, s, page.height, region.line_size]);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const { min, max } = sizeBounds(region, page);
  const attempt = (style: TextStyle): LayoutResult => layoutText({
    text: region.translation,
    box: region.layout_box,
    polygon: region.bubble ? region.bubble.polygon : null,
    fontSize: style.size,
    minSize: min,
    maxSize: max,
    lineHeight: style.line_height,
    align: style.align,
    uppercase: style.uppercase,
    padding: region.bubble ? 0.28 : 0.15,
    padBox: !region.bubble,
  }, makeMeasure(style));
  let result = attempt(s);
  // Solo si el tamaño es automático (la persona no lo fijó) y la región no usa ya la tipografía condensada.
  if (!result.fits && s.size == null && s.font !== CONDENSED_ROLE) {
    const condensed = attempt({ ...s, font: CONDENSED_ROLE });
    if (condensed.fits) result = { ...condensed, font: CONDENSED_ROLE };
  }
  if (layoutCache.size > 2000) layoutCache.clear();
  layoutCache.set(key, result);
  return result;
}

export function drawRegion(ctx: Ctx2D, region: Region, layout: LayoutResult): void {
  const s = layout.font ? { ...region.style, font: layout.font } : region.style;
  const [x1, y1, x2, y2] = region.layout_box;
  ctx.save();
  if (s.rotation) {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    ctx.translate(cx, cy);
    ctx.rotate((s.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  ctx.font = cssFont(s, layout.fontSize);
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${s.letter_spacing * layout.fontSize / 20}px`;
  ctx.textAlign = layout.anchor;
  ctx.textBaseline = 'alphabetic';
  if (s.stroke_width > 0) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = s.stroke_color;
    ctx.lineWidth = s.stroke_width * 2;
    for (const line of layout.lines) ctx.strokeText(line.text, line.x, line.y);
  }
  ctx.fillStyle = s.color;
  for (const line of layout.lines) ctx.fillText(line.text, line.x, line.y);
  ctx.restore();
}

export interface RenderOptions {
  /** Dibuja el texto traducido (false = solo la página limpia). */
  text?: boolean;
  /**
   * Imagen ORIGINAL de la página. Si se da, una traducción que no cabe en su caja ni con la letra mínima no se dibuja desbordada:
   * se restaura el texto original en su sitio (no hay reconstrucción segura). Lo usa la exportación; el editor no lo pasa, para
   * que la persona vea el desbordamiento y lo corrija.
   */
  original?: CanvasImageSource;
}

export interface RenderStats {
  drawn: number;
  /** Textos que no cabían y se dejaron en el idioma original (solo con `original`). */
  keptOriginal: string[];
}

/** Zona que hay que devolver al original: el texto y un margen por si el borrado se extendió alrededor de los trazos. */
export function restoreArea(region: Region, page: Pick<Page, 'width' | 'height'>): [number, number, number, number] {
  const m = Math.max(4, Math.round((region.line_size || 12) * 0.35));
  const [x1, y1, x2, y2] = region.bbox;
  const ax = Math.max(0, x1 - m), ay = Math.max(0, y1 - m);
  return [ax, ay, Math.min(page.width, x2 + m) - ax, Math.min(page.height, y2 + m) - ay];
}

/** Pinta la página: imagen base (limpia u original) + textos traducidos. */
export function renderPage(ctx: Ctx2D, base: CanvasImageSource, page: Page, opts: RenderOptions = {}): RenderStats {
  ctx.drawImage(base, 0, 0, page.width, page.height);
  const stats: RenderStats = { drawn: 0, keptOriginal: [] };
  if (opts.text === false) return stats;
  for (const region of page.regions) {
    if (!region.render || !region.translation.trim()) continue;
    // Si el original se conservó (no se borró), no se dibuja encima la traducción: se solaparían los dos textos.
    if (region.flags.includes('original_kept')) continue;
    const layout = layoutRegion(region, page);
    if (!layout.fits && opts.original) {
      const [x, y, w, h] = restoreArea(region, page);
      if (w > 0 && h > 0) ctx.drawImage(opts.original, x, y, w, h, x, y, w, h);
      stats.keptOriginal.push(region.id);
      continue;
    }
    drawRegion(ctx, region, layout);
    stats.drawn++;
  }
  return stats;
}

export function regionFits(region: Region, page: Pick<Page, 'height'>): boolean {
  if (!region.translation.trim()) return true;
  return layoutRegion(region, page).fits;
}
