"""Instalación, verificación y eliminación de modelos de visión."""

from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

from ..core.download import download_file, sha256_file
from ..core.errors import AppError, ModelMissingError, NotFoundError
from .registry import REGISTRY, ModelFile, ModelSpec, get_spec

log = logging.getLogger(__name__)

ProgressFn = Callable[[float, str], None]


class ModelManager:
    def __init__(self, models_root: Path):
        self.root = models_root
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {mid: threading.Lock() for mid in REGISTRY}

    # -- consulta ---------------------------------------------------------
    def status(self) -> list[dict]:
        out = []
        for spec in REGISTRY.values():
            out.append({
                "id": spec.id,
                "label": spec.label,
                "purpose": spec.purpose,
                "description": spec.description,
                "license": spec.license,
                "homepage": spec.homepage,
                "required": spec.required,
                "languages": list(spec.languages),
                "approx_mb": spec.approx_mb,
                "installed": spec.is_installed(self.root),
                "downloading": self._locks[spec.id].locked(),
                "offline": True,  # una vez descargado funciona sin Internet
            })
        return out

    def is_installed(self, model_id: str) -> bool:
        spec = get_spec(model_id)
        return bool(spec and spec.is_installed(self.root))

    def path(self, model_id: str, rel_path: str) -> Path:
        spec = get_spec(model_id)
        if spec is None:
            raise NotFoundError(f"el modelo {model_id}")
        if not spec.is_installed(self.root):
            raise ModelMissingError(spec.id, spec.label)
        return spec.directory(self.root) / rel_path

    # -- instalación ------------------------------------------------------
    def install(self, model_id: str, progress: ProgressFn | None = None, cancel: threading.Event | None = None) -> None:
        spec = get_spec(model_id)
        if spec is None:
            raise NotFoundError(f"el modelo {model_id}")
        lock = self._locks[spec.id]
        if not lock.acquire(blocking=False):
            raise AppError("busy", "Este modelo ya se está descargando.", 409)
        try:
            self._install_locked(spec, progress or (lambda p, m: None), cancel or threading.Event())
        finally:
            lock.release()

    def _install_locked(self, spec: ModelSpec, progress: ProgressFn, cancel: threading.Event) -> None:
        target = spec.directory(self.root)
        target.mkdir(parents=True, exist_ok=True)
        total_mb = max(spec.approx_mb, 0.01)
        done_mb = 0.0
        for f in spec.files:
            dest = target / f.rel_path
            if dest.is_file() and (f.sha256 is None or sha256_file(dest) == f.sha256):
                done_mb += f.approx_mb
                continue

            def file_progress(fraction: float, f=f, base=done_mb) -> None:
                progress(min(0.999, (base + f.approx_mb * fraction) / total_mb), f"Descargando {f.rel_path}")

            self._download(f, dest, file_progress, cancel)
            done_mb += f.approx_mb
        progress(1.0, "Instalado")
        log.info("Modelo instalado: %s", spec.id)

    def _download(self, f: ModelFile, dest: Path, progress: Callable[[float], None], cancel: threading.Event) -> None:
        def report(done: int, total: int) -> None:
            if total:
                progress(done / total)

        download_file(f.urls, dest, sha256=f.sha256, progress=report, cancel=cancel)

    def remove(self, model_id: str) -> None:
        spec = get_spec(model_id)
        if spec is None:
            raise NotFoundError(f"el modelo {model_id}")
        if self._locks[spec.id].locked():
            raise AppError("busy", "No se puede eliminar un modelo mientras se descarga.", 409)
        shutil.rmtree(spec.directory(self.root), ignore_errors=True)

