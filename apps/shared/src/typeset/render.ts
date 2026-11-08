/**
 * Render de páginas traducidas en <canvas>. Es el mismo código para la vista
 * del editor, la app móvil y la exportación, así que lo que se ve es lo que se
 * exporta.
 */
import type { Page, Region, TextStyle } from '../types';
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

export function sizeBounds(region: Region, page: Pick<Page, 'height'>): { min: number; max: number } {
  const role = FONT_ROLES[region.style.font] ?? FONT_ROLES.dialogue;
  const min = Math.max(8, page.height * 0.008);
  const [, y1, , y2] = region.layout_box;
  const base = region.line_size > 0 ? region.line_size : (y2 - y1) / 4;
  const max = Math.max(min + 1, Math.min(base * 1.2 * role.scale, (y2 - y1) * 0.9, page.height * 0.06));
  return { min, max };
}

const layoutCache = new Map<string, LayoutResult>();

export function layoutRegion(region: Region, page: Pick<Page, 'height'>): LayoutResult {
  const s = region.style;
  const key = JSON.stringify([region.translation, region.layout_box, region.bubble?.polygon?.length, s, page.height]);
  const hit = layoutCache.get(key);
  if (hit) return hit;
  const { min, max } = sizeBounds(region, page);
  const result = layoutText({
    text: region.translation,
    box: region.layout_box,
    polygon: region.bubble ? region.bubble.polygon : null,
    fontSize: s.size,
    minSize: min,
    maxSize: max,
    lineHeight: s.line_height,
    align: s.align,
    uppercase: s.uppercase,
    padding: region.bubble ? 0.28 : 0.15,
  }, makeMeasure(s));
  if (layoutCache.size > 2000) layoutCache.clear();
  layoutCache.set(key, result);
  return result;
}

export function drawRegion(ctx: Ctx2D, region: Region, layout: LayoutResult): void {
  const s = region.style;
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
}

/** Pinta la página: imagen base (limpia u original) + textos traducidos. */
export function renderPage(ctx: Ctx2D, base: CanvasImageSource, page: Page, opts: RenderOptions = {}): void {
  ctx.drawImage(base, 0, 0, page.width, page.height);
  if (opts.text === false) return;
  for (const region of page.regions) {
    if (!region.render || !region.translation.trim()) continue;
    drawRegion(ctx, region, layoutRegion(region, page));
  }
}

export function regionFits(region: Region, page: Pick<Page, 'height'>): boolean {
  if (!region.translation.trim()) return true;
  return layoutRegion(region, page).fits;
}
