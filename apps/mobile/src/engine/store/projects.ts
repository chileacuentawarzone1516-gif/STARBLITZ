/**
 * Persistencia de proyectos en el dispositivo (equivalente a `projects/store.py`).
 *
 * Claves:  project/<pid>                  proyecto
 *          page/<pid>/<gid>               página (regiones incluidas)
 *          run/<pid>                      estado de la última ejecución
 *          img/<pid>/<gid>/<tipo>         imágenes: original, thumb, mask, clean, cthumb
 */
import type { Page, Project, ProjectSummary, Region } from '@starblitz/shared';
import { NotFoundError, ValidationError } from '../core/errors';
import { newId, validateId } from '../core/ids';
import { KeyedMutex } from '../core/mutex';
import { mergeStyle, defaultStyle, newPage, now } from '../core/schema';
import type { DocStorage } from './docs';

export type ImageKind = 'original' | 'thumb' | 'mask' | 'clean' | 'cthumb';

export interface ThumbMaker {
  (original: Blob): Promise<Blob>;
}

export class ProjectStore {
  private mutex = new KeyedMutex();

  constructor(readonly storage: DocStorage, private thumbs: ThumbMaker) {}

  /** Ejecuta `fn` con el proyecto bloqueado: las modificaciones concurrentes de un mismo proyecto se encadenan. */
  mutate<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(projectId, fn);
  }

  // -- claves -------------------------------------------------------------
  private kProject = (pid: string) => `project/${validateId(pid, 'proyecto')}`;
  private kPage = (pid: string, gid: string) => `page/${validateId(pid, 'proyecto')}/${validateId(gid, 'página')}`;
  private kImg = (pid: string, gid: string, kind: ImageKind) => `img/${validateId(pid, 'proyecto')}/${validateId(gid, 'página')}/${kind}`;
  private kRun = (pid: string) => `run/${validateId(pid, 'proyecto')}`;

  // -- proyectos ------------------------------------------------------------
  async list(): Promise<ProjectSummary[]> {
    const keys = await this.storage.listDocKeys('project/');
    const out: ProjectSummary[] = [];
    for (const key of keys) {
      const project = await this.storage.getDoc<Project>(key);
      if (!project || !Array.isArray(project.page_ids)) continue; // proyecto ilegible: se ignora
      out.push(await this.summary(project));
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  async summary(project: Project): Promise<ProjectSummary> {
    const pages: Page[] = [];
    for (const gid of project.page_ids) {
      const page = await this.storage.getDoc<Page>(this.kPage(project.id, gid));
      if (page) pages.push(page);
    }
    const regions = pages.flatMap((p) => p.regions);
    return {
      id: project.id, name: project.name, created: project.created, updated: project.updated, source_lang: project.source_lang,
      detected_lang: project.detected_lang, target_variant: project.target_variant, page_count: pages.length,
      cover_page_id: project.cover_page_id ?? project.page_ids[0] ?? null, regions: regions.length,
      translated: regions.filter((r) => r.translation.trim()).length, review: regions.filter((r) => r.status === 'review').length,
      approved_pages: pages.filter((p) => p.approved).length, cleaned_pages: pages.filter((p) => p.has_clean).length,
      last_job: project.last_job,
    };
  }

  async newProjectId(): Promise<string> {
    for (;;) {
      const id = newId('p');
      if (!(await this.storage.getDoc(this.kProject(id)))) return id;
    }
  }

  async create(project: Project): Promise<Project> {
    await this.save(project);
    return project;
  }

  async get(projectId: string): Promise<Project> {
    const project = await this.storage.getDoc<Project>(this.kProject(projectId));
    if (!project) throw new NotFoundError('el proyecto');
    return project;
  }

  async save(project: Project): Promise<void> {
    project.updated = now();
    await this.storage.putDoc(this.kProject(project.id), project);
  }

  async delete(projectId: string): Promise<void> {
    await this.get(projectId);
    await this.mutate(projectId, async () => {
      const id = validateId(projectId, 'proyecto');
      await this.storage.deleteByPrefix(`page/${id}/`);
      await this.storage.deleteByPrefix(`img/${id}/`);
      await this.storage.deleteDoc(this.kRun(id));
      await this.storage.deleteDoc(this.kProject(id));
    });
  }

  // -- ejecución ------------------------------------------------------------
  loadRun<T>(projectId: string): Promise<T | undefined> { return this.storage.getDoc<T>(this.kRun(projectId)); }
  saveRun(projectId: string, data: unknown): Promise<void> { return this.storage.putDoc(this.kRun(projectId), data); }

  // -- páginas ----------------------------------------------------------------
  async pageExists(projectId: string, pageId: string): Promise<boolean> {
    return !!(await this.storage.getDoc(this.kPage(projectId, pageId)));
  }

  async getPage(projectId: string, pageId: string): Promise<Page> {
    const page = await this.storage.getDoc<Page>(this.kPage(projectId, pageId));
    if (!page) throw new NotFoundError('la página');
    return page;
  }

  async savePage(projectId: string, page: Page): Promise<void> {
    page.updated = now();
    await this.storage.putDoc(this.kPage(projectId, page.id), page);
  }

  async pages(project: Project): Promise<Page[]> {
    const out: Page[] = [];
    for (const gid of project.page_ids) out.push(await this.getPage(project.id, gid));
    return out;
  }

  async image(projectId: string, pageId: string, kind: ImageKind): Promise<Blob | undefined> {
    if (kind === 'cthumb') return this.cleanThumb(projectId, pageId);
    return this.storage.getBlob(this.kImg(projectId, pageId, kind));
  }

  putImage(projectId: string, pageId: string, kind: ImageKind, blob: Blob): Promise<void> {
    return this.storage.putBlob(this.kImg(projectId, pageId, kind), blob);
  }

  /** Miniatura de la página reconstruida: se genera al pedirla y se renueva si la imagen limpia cambia. */
  private async cleanThumb(projectId: string, pageId: string): Promise<Blob | undefined> {
    const clean = await this.storage.getBlob(this.kImg(projectId, pageId, 'clean'));
    if (!clean) return undefined;
    const cached = await this.storage.getBlob(this.kImg(projectId, pageId, 'cthumb'));
    if (cached) return cached;
    const thumb = await this.thumbs(clean);
    await this.storage.putBlob(this.kImg(projectId, pageId, 'cthumb'), thumb);
    return thumb;
  }

  async putClean(projectId: string, pageId: string, blob: Blob): Promise<void> {
    await this.putImage(projectId, pageId, 'clean', blob);
    await this.storage.deleteBlob(this.kImg(projectId, pageId, 'cthumb')); // la miniatura antigua ya no vale
  }

  async addPage(project: Project, data: Blob, init: { ext: string; filename: string; width: number; height: number; sha1: string; dhash: string; duplicate_of: string | null }): Promise<Page> {
    const id = await this.newPageId(project.id);
    const page = newPage({ id, index: project.page_ids.length, ...init });
    await this.putImage(project.id, id, 'original', data);
    await this.putImage(project.id, id, 'thumb', await this.thumbs(data));
    await this.savePage(project.id, page);
    project.page_ids.push(id);
    return page;
  }

  private async newPageId(projectId: string): Promise<string> {
    for (;;) {
      const id = newId('g');
      if (!(await this.storage.getDoc(this.kPage(projectId, id)))) return id;
    }
  }

  async deletePage(project: Project, pageId: string): Promise<void> {
    if (!project.page_ids.includes(pageId)) throw new NotFoundError('la página');
    project.page_ids = project.page_ids.filter((p) => p !== pageId);
    await this.storage.deleteDoc(this.kPage(project.id, pageId));
    await this.storage.deleteByPrefix(`img/${project.id}/${pageId}/`);
    if (project.cover_page_id === pageId) project.cover_page_id = null;
    await this.reindex(project);
  }

  async reorder(project: Project, ordered: string[]): Promise<void> {
    const a = [...ordered].sort(), b = [...project.page_ids].sort();
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      throw new ValidationError('invalid_order', 'El nuevo orden debe contener exactamente las mismas páginas.');
    }
    project.page_ids = [...ordered];
    await this.reindex(project);
  }

  async reindex(project: Project): Promise<void> {
    for (const [i, pid] of project.page_ids.entries()) {
      const page = await this.getPage(project.id, pid);
      if (page.index !== i) {
        page.index = i;
        await this.savePage(project.id, page);
      }
    }
  }

  /** Modifica un texto desde el editor. Editar la traducción la marca «editada» salvo que ya esté aprobada. */
  async updateRegion(projectId: string, pageId: string, regionId: string, patch: RegionPatchInput): Promise<Region> {
    return this.mutate(projectId, async () => {
      const page = await this.getPage(projectId, pageId);
      const i = page.regions.findIndex((r) => r.id === regionId);
      if (i < 0) throw new NotFoundError('el texto');
      const current = page.regions[i];
      const { style, ...rest } = patch;
      const merged: Region = { ...current };
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) (merged as unknown as Record<string, unknown>)[k] = v;
      // Igual que el motor del PC: el estilo recibido sustituye al anterior (los campos que falten toman su valor por defecto).
      if (style) merged.style = mergeStyle(defaultStyle(), style);
      if (patch.translation !== undefined && patch.translation !== null && (patch.status === undefined || patch.status === null) && current.status !== 'approved') {
        merged.status = 'edited';
      }
      merged.updated = now();
      page.regions[i] = merged;
      page.regions.sort((a, b) => a.order - b.order);
      await this.savePage(projectId, page);
      return merged;
    });
  }

  /** Espacio ocupado por las imágenes de los proyectos. */
  imageBytes(): Promise<number> { return this.storage.blobBytes('img/'); }
}

export type RegionPatchInput = Partial<Pick<Region, 'kind' | 'source_text' | 'translation' | 'speaker' | 'status' | 'erase' | 'render' | 'layout_box' | 'bbox' | 'order' | 'flags'>> & { style?: Partial<Region['style']> };
