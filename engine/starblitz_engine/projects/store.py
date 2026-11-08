"""Persistencia de proyectos en disco (JSON + imágenes), segura ante concurrencia."""

from __future__ import annotations

import io
import logging
import shutil
import threading
from collections import defaultdict
from pathlib import Path

from PIL import Image

from ..core.errors import NotFoundError
from ..core.fsutil import atomic_write_bytes, atomic_write_json, read_json
from ..core.ids import new_id, validate_id
from .schema import Page, Project, Region, now

log = logging.getLogger(__name__)

THUMB_WIDTH = 360


class ProjectStore:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.RLock] = defaultdict(threading.RLock)
        self._guard = threading.Lock()

    def lock(self, project_id: str) -> threading.RLock:
        with self._guard:
            return self._locks[project_id]

    # -- rutas --------------------------------------------------------------
    def project_dir(self, project_id: str) -> Path:
        return self.root / validate_id(project_id, "proyecto")

    def page_dir(self, project_id: str, page_id: str) -> Path:
        return self.project_dir(project_id) / "pages" / validate_id(page_id, "página")

    def original_path(self, project_id: str, page: Page) -> Path:
        return self.page_dir(project_id, page.id) / f"original.{page.ext}"

    def thumb_path(self, project_id: str, page_id: str) -> Path:
        return self.page_dir(project_id, page_id) / "thumb.webp"

    def mask_path(self, project_id: str, page_id: str) -> Path:
        return self.page_dir(project_id, page_id) / "mask.png"

    def clean_path(self, project_id: str, page_id: str) -> Path:
        return self.page_dir(project_id, page_id) / "clean.png"

    def clean_thumb(self, project_id: str, page_id: str) -> Path | None:
        """Miniatura de la página reconstruida (se genera al pedirla y se renueva si la imagen limpia cambia)."""
        src = self.clean_path(project_id, page_id)
        if not src.exists():
            return None
        dst = self.page_dir(project_id, page_id) / "thumb-clean.webp"
        if not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime:
            self._write_thumb(dst, src.read_bytes())
        return dst

    # -- proyectos ----------------------------------------------------------
    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir()) if self.root.exists() else []:
            data = read_json(d / "project.json") if d.is_dir() else None
            if not data:
                continue
            try:
                project = Project.model_validate(data)
            except Exception:
                log.warning("Proyecto ilegible ignorado: %s", d.name)
                continue
            out.append(self.summary(project))
        out.sort(key=lambda p: p["updated"], reverse=True)
        return out

    def summary(self, project: Project) -> dict:
        pages = [self.get_page(project.id, pid) for pid in project.page_ids if self._page_exists(project.id, pid)]
        regions = [r for p in pages for r in p.regions]
        review = sum(1 for r in regions if r.status == "review")
        translated = sum(1 for r in regions if r.translation.strip())
        return {
            "id": project.id,
            "name": project.name,
            "created": project.created,
            "updated": project.updated,
            "source_lang": project.source_lang,
            "detected_lang": project.detected_lang,
            "target_variant": project.target_variant,
            "page_count": len(pages),
            "cover_page_id": project.cover_page_id or (project.page_ids[0] if project.page_ids else None),
            "regions": len(regions),
            "translated": translated,
            "review": review,
            "approved_pages": sum(1 for p in pages if p.approved),
            "cleaned_pages": sum(1 for p in pages if p.has_clean),
            "last_job": project.last_job,
        }

    def create(self, project: Project) -> Project:
        d = self.project_dir(project.id)
        (d / "pages").mkdir(parents=True, exist_ok=False)
        self.save(project)
        return project

    def new_project_id(self) -> str:
        while True:
            pid = new_id("p")
            if not self.project_dir(pid).exists():
                return pid

    def get(self, project_id: str) -> Project:
        data = read_json(self.project_dir(project_id) / "project.json")
        if not data:
            raise NotFoundError("el proyecto")
        return Project.model_validate(data)

    def save(self, project: Project) -> None:
        project.updated = now()
        atomic_write_json(self.project_dir(project.id) / "project.json", project.model_dump(mode="json"))

    def delete(self, project_id: str) -> None:
        d = self.project_dir(project_id)
        if not d.exists():
            raise NotFoundError("el proyecto")
        with self.lock(project_id):
            shutil.rmtree(d)

    # -- páginas ------------------------------------------------------------
    def _page_exists(self, project_id: str, page_id: str) -> bool:
        return (self.page_dir(project_id, page_id) / "page.json").exists()

    def get_page(self, project_id: str, page_id: str) -> Page:
        data = read_json(self.page_dir(project_id, page_id) / "page.json")
        if not data:
            raise NotFoundError("la página")
        return Page.model_validate(data)

    def save_page(self, project_id: str, page: Page) -> None:
        page.updated = now()
        atomic_write_json(self.page_dir(project_id, page.id) / "page.json", page.model_dump(mode="json"))

    def pages(self, project: Project) -> list[Page]:
        return [self.get_page(project.id, pid) for pid in project.page_ids]

    def add_page(self, project: Project, data: bytes, ext: str, filename: str, width: int, height: int,
                 sha1: str, dhash: str, duplicate_of: str | None) -> Page:
        page_id = new_id("g")
        d = self.page_dir(project.id, page_id)
        d.mkdir(parents=True, exist_ok=False)
        atomic_write_bytes(d / f"original.{ext}", data)
        page = Page(id=page_id, index=len(project.page_ids), filename=filename, ext=ext, width=width, height=height,
                    sha1=sha1, dhash=dhash, duplicate_of=duplicate_of)
        self._write_thumb(d / "thumb.webp", data)
        self.save_page(project.id, page)
        project.page_ids.append(page_id)
        return page

    def delete_page(self, project: Project, page_id: str) -> None:
        if page_id not in project.page_ids:
            raise NotFoundError("la página")
        project.page_ids.remove(page_id)
        shutil.rmtree(self.page_dir(project.id, page_id), ignore_errors=True)
        if project.cover_page_id == page_id:
            project.cover_page_id = None
        self.reindex(project)

    def reorder(self, project: Project, ordered_ids: list[str]) -> None:
        if sorted(ordered_ids) != sorted(project.page_ids):
            from ..core.errors import ValidationError

            raise ValidationError("invalid_order", "El nuevo orden debe contener exactamente las mismas páginas.")
        project.page_ids = list(ordered_ids)
        self.reindex(project)

    def reindex(self, project: Project) -> None:
        for i, pid in enumerate(project.page_ids):
            page = self.get_page(project.id, pid)
            if page.index != i:
                page.index = i
                self.save_page(project.id, page)

    def update_region(self, project_id: str, page_id: str, region_id: str, patch: dict) -> Region:
        with self.lock(project_id):
            page = self.get_page(project_id, page_id)
            for i, r in enumerate(page.regions):
                if r.id == region_id:
                    merged = r.model_dump()
                    merged.update({k: v for k, v in patch.items() if v is not None})
                    if "translation" in patch and patch.get("status") is None and r.status != "approved":
                        merged["status"] = "edited"
                    merged["updated"] = now()
                    page.regions[i] = Region.model_validate(merged)
                    page.regions.sort(key=lambda x: x.order)
                    self.save_page(project_id, page)
                    return page.regions[[x.id for x in page.regions].index(region_id)]
        raise NotFoundError("el texto")

    @staticmethod
    def _write_thumb(path: Path, data: bytes) -> None:
        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGB")
            ratio = THUMB_WIDTH / im.width
            im = im.resize((THUMB_WIDTH, max(1, int(im.height * ratio))), Image.Resampling.LANCZOS) if ratio < 1 else im
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=82, method=4)
        atomic_write_bytes(path, buf.getvalue())
