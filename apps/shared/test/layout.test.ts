import { describe, expect, it } from 'vitest';
import { History } from '../src/history';
import { hyphenPoints, layoutText, normalizeText, polygonSpan } from '../src/typeset/layout';

const measure = (text: string, size: number) => text.length * size * 0.55;

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 48): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)] as [number, number];
  });
}

describe('layoutText', () => {
  it('ajusta el tamaño automáticamente y nunca desborda la caja', () => {
    const r = layoutText({ text: '¿Una carta de casa…? No me lo esperaba para nada.', box: [0, 0, 200, 160], minSize: 8,
      maxSize: 40, lineHeight: 1.12, align: 'center' }, measure);
    expect(r.fits).toBe(true);
    expect(r.fontSize).toBeGreaterThan(10);
    for (const l of r.lines) expect(l.width).toBeLessThanOrEqual(l.available + 0.01);
    const lastBaseline = r.lines.at(-1)!.y;
    expect(lastBaseline).toBeLessThanOrEqual(160);
  });

  it('respeta la forma del globo: líneas centrales más anchas que las extremas', () => {
    const poly = ellipse(150, 150, 140, 110);
    const r = layoutText({ text: 'Esto es una frase bastante larga para comprobar que el texto sigue la forma del globo elíptico',
      box: [10, 40, 290, 260], polygon: poly, minSize: 8, maxSize: 30, lineHeight: 1.1, align: 'center' }, measure);
    expect(r.fits).toBe(true);
    const avail = r.lines.map((l) => l.available);
    const mid = avail[Math.floor(avail.length / 2)];
    expect(mid).toBeGreaterThan(avail[0]);
    expect(mid).toBeGreaterThan(avail.at(-1)!);
  });

  it('equilibra las líneas en lugar de dejar una palabra sola', () => {
    const r = layoutText({ text: 'Vamos a comer ramen esta noche', box: [0, 0, 260, 200], fontSize: 20, minSize: 8, maxSize: 30,
      lineHeight: 1.1, align: 'center' }, measure);
    const words = r.lines.map((l) => l.text.split(' ').length);
    expect(Math.min(...words)).toBeGreaterThan(1);
  });

  it('parte palabras largas por sílabas cuando es imprescindible', () => {
    const r = layoutText({ text: 'Extraordinariamente', box: [0, 0, 90, 200], fontSize: 14, minSize: 8, maxSize: 30,
      lineHeight: 1.1, align: 'center' }, measure);
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.lines[0].text.endsWith('-')).toBe(true);
  });

  it('marca como desbordado lo que no cabe ni al mínimo', () => {
    const r = layoutText({ text: 'Texto larguísimo '.repeat(30), box: [0, 0, 40, 30], minSize: 8, maxSize: 20, lineHeight: 1.1,
      align: 'center' }, measure);
    expect(r.fits).toBe(false);
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it('normaliza espacios y mayúsculas en español', () => {
    expect(normalizeText('  ¡hola   niño!\n  ¿qué tal? ', true)).toBe('¡HOLA NIÑO!\n¿QUÉ TAL?');
  });

  it('calcula intervalos de polígono y sílabas', () => {
    expect(polygonSpan([[0, 0], [100, 0], [100, 100], [0, 100]], 50)).toEqual([0, 100]);
    expect(hyphenPoints('camino')).toContain(2);
  });
});

describe('History', () => {
  it('deshace, rehace y fusiona ediciones seguidas', async () => {
    let value = 'a';
    const h = new History();
    const set = (from: string, to: string, key?: string) => {
      value = to;
      h.push({ label: 'editar', mergeKey: key, apply: () => { value = to; }, revert: () => { value = from; } });
    };
    set('a', 'ab', 'r1');
    set('ab', 'abc', 'r1');
    expect(value).toBe('abc');
    await h.undo();
    expect(value).toBe('a');
    await h.redo();
    expect(value).toBe('abc');
    expect(h.canRedo).toBe(false);
  });
});
