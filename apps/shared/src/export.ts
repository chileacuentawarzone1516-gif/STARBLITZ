/**
 * Exportación de capítulos traducidos: PDF, ZIP o imágenes sueltas.
 * Mantiene la resolución original de cada página y el orden del proyecto.
 */
import { zipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import type { Page } from './types';
import { renderPage } from './typeset/render';

export type ExportFormat = 'pdf' | 'zip' | 'jpg' | 'png' | 'webp';
export type ImageFormat = 'jpg' | 'png' | 'webp';

export interface ExportFile {
  name: string;
  blob: Blob;
}

export interface ExportOptions {
  format: ExportFormat;
  imageFormat?: ImageFormat; // formato de las páginas dentro de ZIP/PDF
  quality?: number; // 0–1 para JPG/WEBP
  baseName: string;
  /** Imagen base de cada página: limpia si existe, si no la original. */
  loadBase: (page: Page) => Promise<ImageBitmap | HTMLImageElement>;
  /**
   * Imagen ORIGINAL de la página (opcional). Con ella, una traducción que no cabe ni con la letra mínima se exporta con el texto
   * original restaurado en vez de desbordada (ver `RenderOptions.original`).
   */
  loadOriginal?: (page: Page) => Promise<ImageBitmap | HTMLImageElement | null>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

const MIME: Record<ImageFormat, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'starblitz').slice(0, 80);
}

export async function renderPageBlob(page: Page, base: CanvasImageSource, format: ImageFormat, quality = 0.92,
  original?: CanvasImageSource | null): Promise<Blob> {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(page.width, page.height)
    : Object.assign(document.createElement('canvas'), { width: page.width, height: page.height });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingQuality = 'high';
  if (format === 'jpg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, page.width, page.height);
  }
  renderPage(ctx, base, page, original ? { original } : {});
  if (canvas instanceof HTMLCanvasElement) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('No se pudo codificar la página'))), MIME[format], quality));
  }
  return (canvas as OffscreenCanvas).convertToBlob({ type: MIME[format], quality });
}

export async function exportPages(pages: Page[], opts: ExportOptions): Promise<ExportFile[]> {
  const base = safeFileName(opts.baseName);
  const imgFormat: ImageFormat = opts.format === 'jpg' || opts.format === 'png' || opts.format === 'webp'
    ? opts.format : opts.imageFormat ?? 'jpg';
  const quality = opts.quality ?? 0.92;
  const pad = String(pages.length).length < 3 ? 3 : String(pages.length).length;
  const rendered: { name: string; blob: Blob; page: Page }[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Exportación cancelada', 'AbortError');
    const page = pages[i];
    const img = await opts.loadBase(page);
    const original = page.has_clean && opts.loadOriginal ? await opts.loadOriginal(page) : null;
    const blob = await renderPageBlob(page, img, imgFormat, quality, original);
    if ('close' in img && typeof img.close === 'function') img.close();
    rendered.push({ name: `${String(i + 1).padStart(pad, '0')}.${imgFormat}`, blob, page });
    opts.onProgress?.(i + 1, pages.length + (opts.format === 'pdf' || opts.format === 'zip' ? 1 : 0));
  }

  if (opts.format === 'zip') {
    const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
    for (const r of rendered) {
      entries[`${base}/${r.name}`] = [new Uint8Array(await r.blob.arrayBuffer()), { level: imgFormat === 'png' ? 6 : 0 }];
    }
    const zipped = zipSync(entries);
    opts.onProgress?.(pages.length + 1, pages.length + 1);
    return [{ name: `${base}.zip`, blob: new Blob([zipped as BlobPart], { type: 'application/zip' }) }];
  }

  if (opts.format === 'pdf') {
    const pdf = await PDFDocument.create();
    pdf.setTitle(base);
    pdf.setCreator('STARBLITZ');
    pdf.setProducer('STARBLITZ');
    for (const r of rendered) {
      const bytes = new Uint8Array(await r.blob.arrayBuffer());
      const image = imgFormat === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(await ensureJpeg(r, bytes, quality));
      // 150 ppp: tamaño físico razonable sin reducir los píxeles de la imagen.
      const w = (r.page.width * 72) / 150;
      const h = (r.page.height * 72) / 150;
      const p = pdf.addPage([w, h]);
      p.drawImage(image, { x: 0, y: 0, width: w, height: h });
    }
    const bytes = await pdf.save();
    opts.onProgress?.(pages.length + 1, pages.length + 1);
    return [{ name: `${base}.pdf`, blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }) }];
  }

  return rendered.map((r) => ({ name: `${base} - ${r.name}`, blob: r.blob }));
}

/** pdf-lib solo incrusta JPG y PNG: una página WEBP se recodifica a JPG. */
async function ensureJpeg(r: { blob: Blob; page: Page }, bytes: Uint8Array, quality: number): Promise<Uint8Array> {
  if (r.blob.type === 'image/jpeg') return bytes;
  const bmp = await createImageBitmap(r.blob);
  const blob = await renderPageBlob({ ...r.page, regions: [] }, bmp, 'jpg', quality);
  bmp.close();
  return new Uint8Array(await blob.arrayBuffer());
}
