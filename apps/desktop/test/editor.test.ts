/** Regresiones de la auditoría de estabilización (2026-11-12) en la app de escritorio. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateRegion = vi.fn();
vi.mock('../src/store', () => ({ client: () => ({ updateRegion }), reportError: vi.fn() }));

import { flushPending, pendingCount, useEditor } from '../src/editor/useEditor';
import { mergeMemoryEdits, undoSnapshot } from '../src/memory';

const region = { id: 'r1', translation: 'Hola', status: 'translated', style: { size: 12 } };

describe('memoria del proyecto', () => {
  it('conserva lo que la IA añadió mientras la pestaña estaba abierta', () => {
    const base = [{ source: 'Kaito', target: 'Kaito' }];
    const edited = [{ source: 'Kaito', target: 'Kaito el Grande' }];
    const latest = [...base, { source: 'Mira', target: 'Mira' }];
    expect(mergeMemoryEdits(edited, base, latest).map((e) => e.source)).toEqual(['Kaito', 'Mira']);
  });

  it('lo que la persona borró sigue borrado', () => {
    const base = [{ source: 'Kaito', target: 'K' }, { source: 'Ren', target: 'R' }];
    expect(mergeMemoryEdits([base[0]], base, base).map((e) => e.source)).toEqual(['Kaito']);
  });
});

describe('deshacer', () => {
  it('guarda también el estado anterior al cambiar la traducción', () => {
    expect(undoSnapshot(region, { translation: 'Adiós' })).toEqual({ translation: 'Hola', status: 'translated' });
    expect(undoSnapshot(region, { style: { size: 14 } })).toEqual({ style: { size: 12 } });
  });
});

describe('guardado diferido del editor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateRegion.mockReset();
    useEditor.getState().load({ id: 'p' } as never, [{ id: 'g', regions: [{ ...region }] }] as never);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un guardado fallido vuelve a la cola y se reintenta (antes se perdía)', async () => {
    updateRegion.mockRejectedValueOnce(new Error('motor caído')).mockResolvedValue({});
    useEditor.getState().patchRegion('r1', { translation: 'Uno' }, 'Texto');
    await vi.advanceTimersByTimeAsync(500);
    expect(updateRegion).toHaveBeenCalledTimes(1);
    expect(pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4100);
    expect(updateRegion).toHaveBeenCalledTimes(2);
    expect(updateRegion.mock.calls[1][3]).toEqual({ translation: 'Uno' });
    expect(pendingCount()).toBe(0);
  });

  it('lo escrito después del fallo gana a lo reintentado', async () => {
    updateRegion.mockRejectedValueOnce(new Error('motor caído')).mockResolvedValue({});
    useEditor.getState().patchRegion('r1', { translation: 'Uno' }, 'Texto');
    await vi.advanceTimersByTimeAsync(500);
    useEditor.getState().patchRegion('r1', { translation: 'Dos' }, 'Texto');
    await flushPending();
    expect(updateRegion.mock.calls.at(-1)?.[3]).toEqual({ translation: 'Dos' });
    expect(pendingCount()).toBe(0);
  });

  it('cerrar la ventana guarda lo pendiente sin esperar al temporizador', async () => {
    updateRegion.mockResolvedValue({});
    useEditor.getState().patchRegion('r1', { translation: 'Tres' }, 'Texto');
    await flushPending();
    expect(updateRegion).toHaveBeenCalledWith('p', 'g', 'r1', { translation: 'Tres' });
  });
});
