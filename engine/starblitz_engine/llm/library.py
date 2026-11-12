"""Biblioteca local de modelos de lenguaje (GGUF): instalar, listar, comprobar compatibilidad y borrar."""

from __future__ import annotations

import logging
import re
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from ..core.download import download_file
from ..core.errors import AppError, NotFoundError
from ..core.fsutil import atomic_write_json, read_json
from ..core.hardware import HardwareInfo
from . import hf
from .catalog import BY_ID, estimate_memory_gb, fit_model, license_info

log = logging.getLogger(__name__)

ProgressFn = Callable[[float, str], None]
GIB = 1024 ** 3
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,79}$")


@dataclass
class InstalledModel:
    id: str
    label: str
    repo: str
    revision: str
    files: list[str]            # trozos del GGUF principal, en orden (el primero es el que se carga)
    mmproj: str | None
    size: int                   # bytes en disco (modelo + mmproj)
    quant: str
    license: str
    arch: str
    params_b: float
    context_native: int
    source: str                 # curated | custom
    installed_at: float

    @property
    def vision(self) -> bool:
        return bool(self.mmproj)


def quant_of(filename: str) -> str:
    m = re.search(r"(?<![A-Za-z0-9])((?:UD-)?I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?![A-Za-z0-9])", filename, re.I)
    return m.group(1).upper() if m else ""


def make_id(repo: str, filename: str) -> str:
    stem = re.sub(r"\.gguf$", "", filename, flags=re.I)
    slug = re.sub(r"[^a-z0-9]+", "-", f"{repo.split('/')[-1]}-{stem}".lower()).strip("-")
    return slug[:80] if len(slug) >= 3 else "modelo-" + slug


class LLMLibrary:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._busy: set[str] = set()
        self._lock = threading.Lock()

    # -- consulta ------------------------------------------------------------
    def installed(self) -> list[InstalledModel]:
        out = []
        for manifest in sorted(self.root.glob("*/manifest.json")):
            raw = read_json(manifest, default=None)
            if not raw:
                continue
            try:
                model = InstalledModel(**raw)
            except TypeError:
                log.warning("Manifiesto ilegible: %s", manifest)
                continue
            base = manifest.parent
            if all((base / f).is_file() for f in model.files):
                out.append(model)
        return out

    def get(self, model_id: str) -> InstalledModel:
        for m in self.installed():
            if m.id == model_id:
                return m
        raise NotFoundError(f"el modelo «{model_id}»")

    def is_installed(self, model_id: str) -> bool:
        return any(m.id == model_id for m in self.installed())

    def model_path(self, model_id: str) -> Path:
        m = self.get(model_id)
        return self.root / m.id / m.files[0]

    def mmproj_path(self, model_id: str) -> Path | None:
        m = self.get(model_id)
        return (self.root / m.id / m.mmproj) if m.mmproj else None

    def installing(self) -> list[str]:
        return sorted(self._busy)

    # -- comprobación previa ---------------------------------------------------
    @staticmethod
    def check(remote: hf.RemoteModel, path: str, mmproj: str | None, hw: HardwareInfo, context: int,
              mobile: bool = False) -> dict:
        shards = remote.shards_of(path)
        size = sum(f.size for f in shards)
        mm_size = remote.file(mmproj).size if mmproj else 0
        params_b = remote.params / 1e9 if remote.params else max(size / GIB / 0.6, 0.5)
        gpu = hw.best_gpu
        need = estimate_memory_gb(size, params_b, context, 0, remote.architecture)
        verdict = fit_model(need, hw.ram_mb / 1024, (gpu.vram_mb / 1024) if gpu else 0.0, mobile=mobile)
        return {**verdict, "size": size, "mmproj_size": mm_size, "params_b": round(params_b, 2),
                "arch": remote.architecture, "license": remote.license}

    # -- instalación -----------------------------------------------------------
    def install(self, repo: str, path: str, *, mmproj: str | None, token: str, hw: HardwareInfo, context: int,
                progress: ProgressFn, cancel: threading.Event, wait_if_paused: Callable[[], None] | None = None,
                force: bool = False, label: str | None = None) -> InstalledModel:
        hf.validate_repo(repo)
        hf.validate_path(path)
        if mmproj:
            hf.validate_path(mmproj)
        if not path.lower().endswith(".gguf"):
            raise AppError("not_gguf", "Solo se pueden instalar modelos en formato GGUF.", 422)
        curated = next((m for m in BY_ID.values() if m.repo == repo and m.file.path == path), None)
        model_id = curated.id if curated else make_id(repo, path)
        if not _ID_RE.match(model_id):
            raise AppError("invalid_id", "No se pudo generar un identificador válido para el modelo.", 422)
        with self._lock:
            if model_id in self._busy:
                raise AppError("busy", "Este modelo ya se está descargando.", 409)
            self._busy.add(model_id)
        try:
            progress(0.0, "Consultando Hugging Face")
            remote = hf.fetch_model(repo, token)
            verdict = self.check(remote, path, mmproj, hw, context)
            if verdict["fits"] == "no" and not force:
                raise AppError("incompatible", f"Este modelo no es compatible con tu equipo: {verdict['note']}", 409)
            shards = remote.shards_of(path)
            extra = [remote.file(mmproj)] if mmproj else []
            todo = [*shards, *extra]
            total = sum(f.size for f in todo) or 1
            target = self.root / model_id
            free = shutil.disk_usage(self.root).free
            # Lo ya descargado (archivos completos y «.part» de una descarga pausada o cancelada) no vuelve a ocupar
            # espacio: antes se exigía el tamaño entero y reanudar una descarga casi completa daba «No hay espacio».
            already = sum(_partial_bytes(target / Path(f.path).name, f.size) for f in todo)
            need_disk = max(0, total - already) * 1.01 + 64 * 1024 * 1024
            if free < need_disk:
                raise AppError("disk_full", f"No hay espacio suficiente: se necesitan {need_disk / GIB:.1f} GB libres "
                                            f"y hay {free / GIB:.1f} GB.", 507)
            done_before = 0
            for f in todo:
                name = Path(f.path).name

                def report(done: int, size: int, base=done_before, name=name) -> None:
                    progress(min(0.995, (base + done) / total), f"Descargando {name}")

                download_file([remote.url(f.path)], target / name, expected_size=f.size, sha256=f.sha256,
                              headers=hf.headers(token), progress=report, cancel=cancel, wait_if_paused=wait_if_paused)
                done_before += f.size
            params_b = (remote.params / 1e9) if remote.params else (curated.params_b if curated else 0.0)
            model = InstalledModel(
                id=model_id, label=label or (curated.label if curated else Path(path).stem), repo=repo,
                revision=remote.revision, files=[Path(f.path).name for f in shards],
                mmproj=Path(mmproj).name if mmproj else None, size=total, quant=quant_of(path), license=remote.license,
                arch=remote.architecture, params_b=round(params_b, 2),
                context_native=remote.context_length, source="curated" if curated else "custom", installed_at=time.time(),
            )
            atomic_write_json(target / "manifest.json", asdict(model))
            progress(1.0, "Instalado")
            log.info("Modelo instalado: %s (%s @ %s)", model_id, repo, remote.revision[:8])
            return model
        finally:
            with self._lock:
                self._busy.discard(model_id)

    def remove(self, model_id: str) -> None:
        if not _ID_RE.match(model_id):
            raise NotFoundError(f"el modelo «{model_id}»")
        if model_id in self._busy:
            raise AppError("busy", "No se puede eliminar un modelo mientras se descarga.", 409)
        target = self.root / model_id
        if not target.is_dir():
            raise NotFoundError(f"el modelo «{model_id}»")
        shutil.rmtree(target, ignore_errors=True)
        log.info("Modelo eliminado: %s", model_id)

    def incomplete(self) -> list[dict]:
        """Descargas sin terminar (carpeta sin manifiesto válido y que no se está descargando ahora): ocupan disco y
        antes no aparecían en ningún sitio. Se pueden reanudar instalando el mismo archivo o borrar con ``remove``."""
        ok = {m.id for m in self.installed()}
        out = []
        for d in sorted(p for p in self.root.iterdir() if p.is_dir()):
            if d.name in ok or d.name in self._busy or not _ID_RE.match(d.name):
                continue
            size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
            if size:
                out.append({"id": d.name, "bytes": size})
        return out

    def disk_usage(self) -> int:
        return sum(m.size for m in self.installed()) + sum(i["bytes"] for i in self.incomplete())


def _partial_bytes(dest: Path, size: int) -> int:
    """Bytes ya presentes de un archivo del modelo: completo (``dest``) o a medias (``dest.part``)."""
    for p in (dest, dest.with_name(dest.name + ".part")):
        try:
            return min(size, p.stat().st_size)
        except OSError:
            continue
    return 0


_SHARD_FIRST = re.compile(r"-0*1-of-0*(\d+)\.gguf$")
_SHARD_ANY = re.compile(r"-\d{5}-of-\d{5}\.gguf$")


def describe_repo(remote: hf.RemoteModel, hw: HardwareInfo, context: int, mobile: bool = False) -> dict:
    """Ficha de un repositorio para elegir qué archivo instalar: cada cuantización con su tamaño y su compatibilidad."""
    files, projectors = [], []
    for path, f in sorted(remote.files.items()):
        low = path.lower()
        if not low.endswith(".gguf"):
            continue
        name = Path(path).name
        if "mmproj" in low:
            projectors.append({"path": path, "size": f.size, "quant": quant_of(name)})
            continue
        if _SHARD_ANY.search(low) and not _SHARD_FIRST.search(low):
            continue  # solo se lista el primer trozo; el tamaño es el del conjunto
        shards = remote.shards_of(path)
        size = sum(x.size for x in shards)
        check = LLMLibrary.check(remote, path, None, hw, context, mobile)
        files.append({"path": path, "size": size, "quant": quant_of(name), "shards": len(shards), "fit": {
            k: check[k] for k in ("fits", "speed", "need_gb", "tight", "note")}})
    files.sort(key=lambda x: x["size"])
    best_mmproj = next((p for p in projectors if p["quant"] in ("F16", "BF16")), projectors[0] if projectors else None)
    return {"repo": remote.repo, "revision": remote.revision, "license": license_info(remote.license), "gated": remote.gated,
            "arch": remote.architecture, "params_b": round(remote.params / 1e9, 2) if remote.params else 0.0,
            "context_native": remote.context_length, "files": files, "mmproj": projectors, "mmproj_suggested": best_mmproj}


def dump(model: InstalledModel) -> dict:
    d = asdict(model)
    d["vision"] = model.vision
    d["license_info"] = license_info(model.license)
    return d


__all__ = ["LLMLibrary", "InstalledModel", "make_id", "quant_of", "dump", "describe_repo"]
