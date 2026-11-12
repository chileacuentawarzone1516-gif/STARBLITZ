/** Regresiones de la auditoría de estabilización (2026-11-12). Cada caso fallaba antes de su corrección. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPages, type Page, type Region } from '@starblitz/shared';
import { keepReviewed, mergeUnchanged, snapshotRegions } from '../../src/engine/pipeline/processor';
import { indexByNumber } from '../../src/engine/translate/contextual';
import { exportTempPath } from '../../src/lib/exportFile';

// Mismo patrón que SafePath.java (cada tramo de una ruta de la carpeta privada).
const JAVA_SEGMENT = /^[\w][\w .()+@=,-]*$/;

function region(id: string, bbox: [number, number, number, number], extra: Partial<Region> = {}): Region {
  return {
    id, order: 0, kind: 'dialogue', bbox, lines: [], vertical: false, line_size: 0, bubble: null, layout_box: bbox,
    source_text: '', ocr_confidence: 0, ocr_engine: '', ocr_fix: '', translation: '', speaker: '', emotion: '',
    confidence: null, flags: [], note: '', review_note: '', status: 'pending', erase: true, render: true, max_chars: 0,
    style: {} as Region['style'], updated: 1, ...extra,
  } as Region;
}

describe('exportación en Android', () => {
  it.each(['(C99) Mi doujin.pdf', '-Prologo-.zip', '.hack.pdf', 'Capítulo 1.pdf'])('ruta temporal válida para «%s»', (name) => {
    const path = exportTempPath(name);
    for (const part of path.split('/')) expect(part).toMatch(JAVA_SEGMENT);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  function fakeCanvasGlobals(failOn?: number) {
    let n = 0;
    const ctx = new Proxy({}, {
      get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) : () => undefined),
      set: () => true,
    });
    class FakeOffscreen {
      constructor(public width: number, public height: number) {}
      getContext() { return ctx; }
      async convertToBlob() {
        n += 1;
        if (failOn === n) throw new Error('fallo al codificar');
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    vi.stubGlobal('HTMLCanvasElement', class {});
  }

  const page = (i: number): Page => ({ id: `p${i}`, index: i, width: 100, height: 150, regions: [], has_clean: true } as unknown as Page);
  const bitmap = () => ({ width: 100, height: 150, close: vi.fn() }) as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };

  it('libera la base Y el original de cada página (antes el original nunca se cerraba)', async () => {
    fakeCanvasGlobals();
    const bases = [bitmap(), bitmap()], originals = [bitmap(), bitmap()];
    await exportPages([page(0), page(1)], {
      format: 'jpg', baseName: 'x', loadBase: async (p) => bases[p.index], loadOriginal: async (p) => originals[p.index],
    });
    for (const b of [...bases, ...originals]) expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('libera las imágenes aunque falle la codificación de una página', async () => {
    fakeCanvasGlobals(1);
    const base = bitmap(), original = bitmap();
    await expect(exportPages([page(0)], { format: 'jpg', baseName: 'x', loadBase: async () => base, loadOriginal: async () => original }))
      .rejects.toThrow('fallo al codificar');
    expect(base.close).toHaveBeenCalledTimes(1);
    expect(original.close).toHaveBeenCalledTimes(1);
  });
});

describe('ediciones del usuario durante el procesado (paridad con Python)', () => {
  it('la traducción no pisa una región editada mientras tanto', () => {
    const a = region('a', [0, 0, 10, 10]), b = region('b', [0, 20, 10, 30]);
    const seen = snapshotRegions([a, b]);
    const fromModel = [{ ...a, translation: 'Hola', status: 'translated' as const }, { ...b, translation: 'Adiós', status: 'translated' as const }];
    const editedB = { ...b, translation: 'TEXTO DEL USUARIO', status: 'edited' as const, updated: 2 };
    const merged = mergeUnchanged([structuredClone(a), editedB], fromModel, seen);
    expect(merged.map((r) => r.translation)).toEqual(['Hola', 'TEXTO DEL USUARIO']);
  });

  it('volver a analizar conserva lo revisado aunque el detector no lo encuentre', () => {
    const manual = region('manual', [400, 400, 500, 450], { translation: 'A mano', status: 'approved', erase: false });
    const moved = region('old', [10, 10, 110, 60], { source_text: 'OK!', translation: '¡Vale!', status: 'edited', render: false });
    const out = keepReviewed([region('n1', [12, 11, 111, 61], { source_text: '0K!' }), region('n2', [200, 200, 260, 240])], [manual, moved]);
    expect(out.map((r) => r.id)).toEqual(['n1', 'n2', 'manual']);
    expect(out.map((r) => r.order)).toEqual([0, 1, 2]);
    expect([out[0].translation, out[0].status, out[0].source_text, out[0].render]).toEqual(['¡Vale!', 'edited', 'OK!', false]);
  });
});

describe('número de elemento en la respuesta del modelo (paridad con _item_n)', () => {
  it.each([[3, 3], [3.0, 3], ['4', 4], [' 5 ', 5], [null, -1], [2.7, -1], [true, -1], ['dos', -1]])('n=%j → %j', (value, expected) => {
    const map = indexByNumber([{ n: value, translation: 't' }]);
    expect([...map.keys()]).toEqual([expected]); // antes null contaba como 0 y 2.7 iba al globo 2
  });
});

describe('reconstrucción LaMa en el móvil', () => {
  it('cambiar los ajustes libera la sesión de LaMa (antes quedaba ~200 MB sin liberar por cada cambio)', async () => {
    const { VisionService } = await import('../../src/engine/vision/service');
    const svc = Object.create(VisionService.prototype) as InstanceType<typeof VisionService>;
    const dispose = vi.fn(async () => undefined);
    Object.assign(svc, { opts: { inpaintMode: () => 'quality' }, inpainter: { mode: 'fast' }, lama: { dispose }, ocr: new Map() });
    svc.refresh();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((svc as unknown as { lama: unknown }).lama).toBeUndefined();
  });
});

describe('nombres de archivo exportados', () => {
  it.each([['CON', 'CON_'], ['nul', 'nul_'], ['Capítulo 1.', 'Capítulo 1'], ['a/b:c', 'a b c'], ['   ', 'starblitz']])('«%s» → «%s»', async (input, out) => {
    const { safeFileName } = await import('@starblitz/shared');
    expect(safeFileName(input)).toBe(out);
  });
});
