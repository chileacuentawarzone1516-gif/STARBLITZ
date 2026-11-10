/**
 * Cajas de rotulado solapadas (corrección general del 2026-11-09, igual que `separate_layouts` en Python) y zona que se devuelve
 * al original cuando una traducción no cabe al exportar.
 */
import { describe, expect, it } from 'vitest';
import type { Region } from '@starblitz/shared';
import { restoreArea } from '@starblitz/shared';
import { newRegion } from '../../src/engine/core/schema';
import { separateLayouts } from '../../src/engine/vision/regions';

type Box = [number, number, number, number];
const region = (id: string, bbox: Box, layout: Box, bubble = false): Region => ({
  ...newRegion({ id, bbox, layout_box: layout, source_text: 'X', max_chars: 10 }), line_size: 20,
  bubble: bubble ? { polygon: [[0, 0], [1, 0], [1, 1]], bbox: layout, fill: [255, 255, 255], uniform: true } : null,
});

describe('cajas de rotulado solapadas', () => {
  it('se cortan por la línea media entre los textos originales y se recalcula el límite de caracteres', () => {
    const a = region('a', [100, 100, 200, 160], [60, 60, 320, 220], true);
    const b = region('b', [300, 110, 380, 150], [240, 70, 450, 200], true);
    expect(separateLayouts([a, b], 1200)).toBe(2);
    expect(a.layout_box[2]).toBe(250);
    expect(b.layout_box[0]).toBe(250);
    expect([a.layout_box[0], b.layout_box[2]]).toEqual([60, 450]);
    expect(a.max_chars).toBeGreaterThan(0);
  });

  it('nunca encoge una caja por debajo de su texto y no toca textos que se solapan', () => {
    const a = region('a', [100, 100, 200, 300], [90, 90, 400, 320]);
    const b = region('b', [210, 100, 260, 300], [150, 90, 300, 320]);
    separateLayouts([a, b], 1200);
    expect(a.layout_box[2]).toBeGreaterThanOrEqual(a.bbox[2]);
    expect(b.layout_box[0]).toBeLessThanOrEqual(b.bbox[0]);
    const c = region('c', [100, 100, 200, 200], [90, 90, 210, 210]);
    const d = region('d', [150, 150, 250, 250], [140, 140, 260, 260]);
    expect(separateLayouts([c, d], 1200)).toBe(0);
    expect(c.layout_box).toEqual([90, 90, 210, 210]);
  });

  it('textos apilados: corte horizontal', () => {
    const a = region('a', [100, 100, 300, 140], [80, 80, 320, 260]);
    const b = region('b', [110, 200, 290, 240], [80, 160, 320, 300]);
    separateLayouts([a, b], 1200);
    expect([a.layout_box[3], b.layout_box[1]]).toEqual([170, 170]);
  });
});

describe('texto que no cabe al exportar', () => {
  it('se restaura el original en el área del texto con un margen, sin salirse de la página', () => {
    const r = region('a', [10, 20, 110, 80], [0, 0, 200, 200]);
    expect(restoreArea(r, { width: 1000, height: 1000 })).toEqual([3, 13, 114, 74]);
    const edge = region('b', [0, 0, 50, 50], [0, 0, 60, 60]);
    expect(restoreArea(edge, { width: 52, height: 52 })).toEqual([0, 0, 52, 52]);
  });
});
