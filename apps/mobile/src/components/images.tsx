/** Imágenes de las páginas leídas del almacenamiento local de la app (nunca de un servidor). */
import { loadLetteringFonts, renderPage, type Page } from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import { engine } from '../state/app';

type Kind = 'original' | 'clean' | 'thumb' | 'cthumb';

export function useImageUrl(projectId: string, pageId: string | null | undefined, kind: Kind, version: number | string = 0): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    if (!pageId) return;
    engine().image(projectId, pageId, kind).then((blob) => {
      if (!alive || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => undefined);
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [projectId, pageId, kind, version]);
  return url;
}

let fontsReady = false;
const fonts = loadLetteringFonts().then(() => { fontsReady = true; }, () => { fontsReady = true; });

const bitmapCache = new Map<string, Promise<ImageBitmap | null>>();

/**
 * Página completa como bitmap (original o reconstruida) para el LECTOR, con una caché pequeña. Las imágenes de la caché
 * pueden estar en pantalla: nunca se cierran al desalojarlas (el recolector las libera cuando nadie las usa). Antes se
 * cerraban y la exportación también las cerraba: dibujar un bitmap cerrado lanza `InvalidStateError` (páginas en blanco
 * y una segunda exportación fallida). La exportación usa `ownedPageBitmap`.
 */
export function pageBitmap(projectId: string, page: Page, kind: 'original' | 'base'): Promise<ImageBitmap | null> {
  const k = kind === 'base' && page.has_clean ? 'clean' : 'original';
  const key = `${projectId}/${page.id}/${k}/${k === 'clean' ? page.updated : 0}`;
  if (!bitmapCache.has(key)) {
    if (bitmapCache.size > 8) bitmapCache.delete(bitmapCache.keys().next().value!);
    bitmapCache.set(key, ownedPageBitmap(projectId, page, kind).catch(() => null));
  }
  return bitmapCache.get(key)!;
}

/** Bitmap nuevo, sin caché: quien lo pide es su dueño y debe cerrarlo (lo hace `exportPages`). */
export async function ownedPageBitmap(projectId: string, page: Page, kind: 'original' | 'base'): Promise<ImageBitmap | null> {
  const k = kind === 'base' && page.has_clean ? 'clean' : 'original';
  const blob = await engine().image(projectId, page.id, k);
  return blob ? createImageBitmap(blob) : null;
}

export function clearBitmapCache(): void {
  bitmapCache.clear(); // sin `close()`: alguna puede seguir en pantalla
}

/** Página dibujada en un canvas: original o traducida (misma composición que la exportación). */
export function PageCanvas({ projectId, page, translated, className }: { projectId: string; page: Page; translated: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(fontsReady);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  useEffect(() => { if (!fontsReady) void fonts.then(() => setReady(true)); }, []);
  useEffect(() => {
    let alive = true;
    void pageBitmap(projectId, page, translated ? 'base' : 'original').then((b) => { if (alive) setBmp(b); });
    return () => { alive = false; };
  }, [projectId, page.id, page.has_clean, page.updated, translated]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = ref.current;
    if (!c || !bmp || !ready) return;
    const raf = requestAnimationFrame(() => {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (translated) renderPage(ctx, bmp, page);
      else ctx.drawImage(bmp, 0, 0, page.width, page.height);
    });
    return () => cancelAnimationFrame(raf);
  }, [bmp, ready, page, translated]);
  return <canvas ref={ref} width={page.width} height={page.height} className={className} aria-label={`Página ${page.index + 1}`} role="img" />;
}

/** Miniatura traducida: la imagen reconstruida reducida con el texto nuevo dibujado encima, a escala. */
export function TranslatedThumb({ projectId, page }: { projectId: string; page: Page }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const url = useImageUrl(projectId, page.has_clean ? page.id : null, 'cthumb', page.updated);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      await fonts;
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const scale = img.naturalWidth / page.width;
      canvas.width = img.naturalWidth;
      canvas.height = Math.round(page.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.scale(scale, scale);
      renderPage(ctx, img, page);
      ctx.restore();
    };
    img.src = url;
    return () => { alive = false; img.onload = null; };
  }, [url, page]);
  return page.has_clean ? <canvas ref={ref} className="m-thumb-canvas" aria-hidden /> : null;
}
