/**
 * Lectura de PDF con pdf.js: cada página se dibuja a alta resolución (300 ppp, máximo 3000 px de lado) sobre un
 * lienzo fuera de pantalla, así funciona también dentro de un Worker. Los PDF de escaneos se leen a su resolución de
 * dibujo; el motor del PC además extrae el bitmap nativo, algo que pdf.js no expone de forma estable.
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfOpener, PdfPages } from './ingest';

export const PDF_MAX_SIDE = 3000;

interface CanvasAndContext { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }

/** Fábrica de lienzos sin DOM para pdf.js. */
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc: CanvasAndContext, width: number, height: number): void {
    if (cc.canvas) { cc.canvas.width = width; cc.canvas.height = height; }
  }
  destroy(cc: CanvasAndContext): void {
    if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; }
    cc.canvas = null;
    cc.context = null;
  }
}

export const openPdf: PdfOpener = async (data: Uint8Array): Promise<PdfPages> => {
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({
    data: data.slice(), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    CanvasFactory: OffscreenCanvasFactory,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    async render(index: number): Promise<Uint8Array> {
      const page = await doc.getPage(index + 1);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(300 / 72, PDF_MAX_SIDE / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('lienzo no disponible');
        ctx.fillStyle = '#ffffff'; // las páginas de PDF son transparentes: se dibujan sobre papel blanco
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
        return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      } finally {
        page.cleanup();
      }
    },
    async destroy() { await doc.destroy(); },
  };
};
