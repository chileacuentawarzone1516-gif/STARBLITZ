/**
 * Estado del editor: página actual, selección, vista, zoom y edición con
 * deshacer/rehacer. Los cambios se aplican al instante en pantalla y se guardan
 * en el motor agrupados (escritura diferida) para no saturarlo al teclear.
 */
import { create } from 'zustand';
import { History, type BBox, type Page, type Project, type Region, type RegionPatch } from '@starblitz/shared';
import { client, reportError } from '../store';

export type ViewMode = 'translated' | 'original' | 'compare';
export type Tool = 'select' | 'draw';

interface EditorState {
  project: Project | null;
  pages: Page[];
  pageIndex: number;
  selectedId: string | null;
  view: ViewMode;
  tool: Tool;
  zoom: number; // 0 = ajustar a la ventana
  staleClean: Record<string, boolean>; // páginas cuya imagen limpia está desactualizada
  saving: number;
  history: History;
  load(project: Project, pages: Page[], pageId?: string): void;
  setPage(index: number): void;
  select(id: string | null): void;
  setView(v: ViewMode): void;
  setTool(t: Tool): void;
  setZoom(z: number): void;
  replacePage(page: Page): void;
  patchRegion(regionId: string, patch: RegionPatch, label: string, mergeKey?: string): void;
  addRegion(bbox: BBox): Promise<void>;
  deleteRegion(regionId: string): Promise<void>;
  reocr(regionId: string): Promise<void>;
  markClean(pageId: string, stale: boolean): void;
}

const pending = new Map<string, { pid: string; gid: string; rid: string; patch: RegionPatch; timer: ReturnType<typeof setTimeout> }>();

function scheduleSave(pid: string, gid: string, rid: string, patch: RegionPatch, set: (fn: (s: EditorState) => Partial<EditorState>) => void) {
  const key = `${gid}/${rid}`;
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const merged = { ...(prev?.patch ?? {}), ...patch };
  const timer = setTimeout(async () => {
    pending.delete(key);
    set((s) => ({ saving: s.saving + 1 }));
    try {
      await client().updateRegion(pid, gid, rid, merged);
    } catch (e) {
      reportError(e, 'No se pudo guardar el cambio');
    } finally {
      set((s) => ({ saving: s.saving - 1 }));
    }
  }, 450);
  pending.set(key, { pid, gid, rid, patch: merged, timer });
}

/** Fuerza el guardado de los cambios pendientes (al cambiar de página o salir). */
export async function flushPending(): Promise<void> {
  const jobs = [...pending.values()];
  pending.clear();
  await Promise.all(jobs.map(async (j) => {
    clearTimeout(j.timer);
    try { await client().updateRegion(j.pid, j.gid, j.rid, j.patch); } catch (e) { reportError(e); }
  }));
}

function pick(region: Region, patch: RegionPatch): RegionPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = structuredClone((region as unknown as Record<string, unknown>)[k]);
  return out as RegionPatch;
}

export const useEditor = create<EditorState>((set, get) => {
  const mutateRegion = (gid: string, rid: string, patch: RegionPatch) => {
    set((s) => ({
      pages: s.pages.map((p) => p.id !== gid ? p : {
        ...p,
        regions: p.regions.map((r) => r.id !== rid ? r : {
          ...r, ...patch,
          status: patch.status ?? (patch.translation !== undefined && r.status !== 'approved' ? 'edited' : r.status),
        } as Region),
      }),
    }));
    const pid = get().project?.id;
    if (pid) scheduleSave(pid, gid, rid, patch, set);
    if (patch.erase !== undefined || patch.bbox !== undefined) get().markClean(gid, true);
  };

  return {
    project: null,
    pages: [],
    pageIndex: 0,
    selectedId: null,
    view: 'translated',
    tool: 'select',
    zoom: 0,
    staleClean: {},
    saving: 0,
    history: new History(),
    load: (project, pages, pageId) => {
      const idx = Math.max(0, pages.findIndex((p) => p.id === pageId));
      get().history.clear();
      set({ project, pages, pageIndex: pages.length ? idx : 0, selectedId: null, tool: 'select' });
    },
    setPage: (index) => {
      const { pages } = get();
      if (index < 0 || index >= pages.length) return;
      flushPending();
      set({ pageIndex: index, selectedId: null });
    },
    select: (id) => set({ selectedId: id }),
    setView: (view) => set({ view }),
    setTool: (tool) => set({ tool }),
    setZoom: (zoom) => set({ zoom: zoom === 0 ? 0 : Math.max(0.1, Math.min(6, zoom)) }),
    replacePage: (page) => set((s) => ({ pages: s.pages.map((p) => (p.id === page.id ? page : p)) })),
    markClean: (pageId, stale) => set((s) => ({ staleClean: { ...s.staleClean, [pageId]: stale } })),

    patchRegion: (regionId, patch, label, mergeKey) => {
      const page = get().pages[get().pageIndex];
      const region = page?.regions.find((r) => r.id === regionId);
      if (!page || !region) return;
      const before = pick(region, patch);
      const gid = page.id;
      mutateRegion(gid, regionId, patch);
      get().history.push({
        label, mergeKey: mergeKey ? `${regionId}:${mergeKey}` : undefined,
        apply: () => mutateRegion(gid, regionId, patch),
        revert: () => mutateRegion(gid, regionId, before),
      });
    },

    addRegion: async (bbox) => {
      const { project, pages, pageIndex } = get();
      const page = pages[pageIndex];
      if (!project || !page) return;
      try {
        const region = await client().addRegion(project.id, page.id, bbox);
        const add = (r: Region) => set((s) => ({
          pages: s.pages.map((p) => p.id !== page.id ? p : { ...p, regions: [...p.regions.filter((x) => x.id !== r.id), r].sort((a, b) => a.order - b.order) }),
        }));
        add(region);
        set({ selectedId: region.id, tool: 'select' });
        get().markClean(page.id, true);
        get().history.push({
          label: 'Añadir texto',
          apply: async () => { add(await client().putRegion(project.id, page.id, region)); },
          revert: async () => {
            await client().deleteRegion(project.id, page.id, region.id);
            set((s) => ({ pages: s.pages.map((p) => p.id !== page.id ? p : { ...p, regions: p.regions.filter((x) => x.id !== region.id) }) }));
          },
        });
      } catch (e) { reportError(e, 'No se pudo reconocer el área'); }
    },

    deleteRegion: async (regionId) => {
      const { project, pages, pageIndex } = get();
      const page = pages[pageIndex];
      const region = page?.regions.find((r) => r.id === regionId);
      if (!project || !page || !region) return;
      await flushPending();
      const remove = () => set((s) => ({
        selectedId: s.selectedId === regionId ? null : s.selectedId,
        pages: s.pages.map((p) => p.id !== page.id ? p : { ...p, regions: p.regions.filter((x) => x.id !== regionId) }),
      }));
      try {
        await client().deleteRegion(project.id, page.id, regionId);
        remove();
        get().markClean(page.id, true);
        get().history.push({
          label: 'Eliminar texto',
          apply: async () => { await client().deleteRegion(project.id, page.id, regionId); remove(); },
          revert: async () => {
            const restored = await client().putRegion(project.id, page.id, region);
            set((s) => ({ pages: s.pages.map((p) => p.id !== page.id ? p : { ...p, regions: [...p.regions, restored].sort((a, b) => a.order - b.order) }) }));
          },
        });
      } catch (e) { reportError(e); }
    },

    reocr: async (regionId) => {
      const { project, pages, pageIndex } = get();
      const page = pages[pageIndex];
      const region = page?.regions.find((r) => r.id === regionId);
      if (!project || !page || !region) return;
      await flushPending();
      try {
        const updated = await client().reocrRegion(project.id, page.id, regionId, region.bbox);
        set((s) => ({ pages: s.pages.map((p) => p.id !== page.id ? p : { ...p, regions: p.regions.map((r) => (r.id === regionId ? updated : r)) }) }));
      } catch (e) { reportError(e, 'No se pudo reconocer de nuevo'); }
    },
  };
});

export function currentPage(): Page | undefined {
  const s = useEditor.getState();
  return s.pages[s.pageIndex];
}
