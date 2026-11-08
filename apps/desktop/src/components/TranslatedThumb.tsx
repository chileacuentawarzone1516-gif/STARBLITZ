import { loadLetteringFonts, renderPage, type Page } from '@starblitz/shared';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';

/** Miniatura de la página traducida: imagen reconstruida reducida + el texto nuevo dibujado encima, a escala. */
export function TranslatedThumb({ projectId, page }: { projectId: string; page: Page }) {
  const api = useApp((s) => s.client);
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    setFailed(false);
    const img = new Image();
    img.decoding = 'async';
    img.onload = async () => {
      await loadLetteringFonts().catch(() => undefined);
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
    img.onerror = () => alive && setFailed(true);
    img.src = api.imageUrl(projectId, page.id, 'cthumb', page.updated);
    return () => { alive = false; img.onload = null; img.onerror = null; };
  }, [api, projectId, page]);

  if (failed) return null;
  return <canvas ref={ref} className="thumb-canvas" aria-hidden />;
}
