"""Importación de ZIP/CBZ, PDF e imágenes (JPG, PNG, WEBP).

Medidas de seguridad:
- El tipo se decide por la firma del archivo, no por la extensión.
- ZIP: nunca se extrae a disco con los nombres del archivo (evita zip-slip);
  se limitan número de entradas, tamaño descomprimido y ratio de compresión
  (evita bombas zip).
- Imágenes: límite de megapíxeles (evita bombas de descompresión) y
  validación completa con Pillow.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import PurePosixPath

import numpy as np
from PIL import Image, ImageOps

log = logging.getLogger(__name__)

MAX_IMAGE_PIXELS = 60_000_000          # ~ 7700 x 7700
MAX_ENTRY_BYTES = 150 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
MAX_ZIP_ENTRIES = 5000
MAX_COMPRESSION_RATIO = 200
PDF_MAX_SIDE = 3000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS

IMAGE_EXTS = {"jpg", "jpeg", "png", "webp"}


@dataclass
class ImportedImage:
    name: str
    data: bytes
    ext: str
    width: int
    height: int
    sha1: str
    dhash: str


@dataclass
class ImportReport:
    added: list[str] = field(default_factory=list)
    duplicates: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    skipped_limit: int = 0

    def to_dict(self) -> dict:
        return {"added": self.added, "duplicates": self.duplicates, "errors": self.errors,
                "skipped_limit": self.skipped_limit}


def sniff(head: bytes) -> str | None:
    if head.startswith(b"PK\x03\x04") or head.startswith(b"PK\x05\x06"):
        return "zip"
    if head.startswith(b"%PDF"):
        return "pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def natural_key(name: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def dhash(img: Image.Image) -> str:
    g = img.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    a = np.asarray(g, dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def load_image(name: str, data: bytes) -> ImportedImage:
    kind = sniff(data[:16])
    if kind not in IMAGE_EXTS:
        raise ValueError("no es una imagen JPG, PNG o WEBP")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Image.DecompressionBombError as exc:
        raise ValueError("la imagen es demasiado grande") from exc
    except Exception as exc:
        raise ValueError("la imagen está dañada o incompleta") from exc
    oriented = ImageOps.exif_transpose(img)
    needs_reencode = oriented is not img or img.mode not in ("RGB", "L") or kind == "webp" and getattr(img, "is_animated", False)
    if needs_reencode:
        rgb = oriented.convert("RGB")
        buf = io.BytesIO()
        rgb.save(buf, "PNG", optimize=False)
        data, kind, img = buf.getvalue(), "png", rgb
    return ImportedImage(
        name=name, data=data, ext="jpg" if kind == "jpg" else kind, width=img.width, height=img.height,
        sha1=hashlib.sha1(data).hexdigest(), dhash=dhash(img),
    )


def iter_zip(name: str, data: bytes) -> Iterator[tuple[str, bytes | Exception]]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        yield name, ValueError("el ZIP está dañado")
        return
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_ZIP_ENTRIES:
            yield name, ValueError("el ZIP contiene demasiados archivos")
            return
        total = sum(i.file_size for i in infos)
        if total > MAX_ZIP_TOTAL_BYTES:
            yield name, ValueError("el contenido descomprimido del ZIP es demasiado grande")
            return
        for info in sorted(infos, key=lambda i: natural_key(i.filename)):
            entry = PurePosixPath(info.filename.replace("\\", "/"))
            if ".." in entry.parts:
                yield entry.name, ValueError("ruta no permitida dentro del ZIP")
                continue
            if any(part.startswith(".") or part == "__MACOSX" for part in entry.parts):
                continue
            if info.flag_bits & 0x1:
                yield entry.name, ValueError("archivo cifrado con contraseña")
                continue
            if info.file_size > MAX_ENTRY_BYTES or (info.compress_size and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO):
                yield entry.name, ValueError("archivo sospechoso o demasiado grande")
                continue
            ext = entry.suffix.lower().lstrip(".")
            if ext not in IMAGE_EXTS:
                if ext not in {"txt", "xml", "json", "nfo", "db", "ini", "url"}:
                    yield entry.name, ValueError("formato no admitido dentro del ZIP")
                continue
            with zf.open(info) as fh:
                payload = fh.read(MAX_ENTRY_BYTES + 1)
            yield str(entry), payload


def iter_pdf(name: str, data: bytes) -> Iterator[tuple[str, bytes | Exception]]:
    import pypdfium2 as pdfium

    try:
        pdf = pdfium.PdfDocument(data)
    except Exception:
        yield name, ValueError("el PDF está dañado o protegido con contraseña")
        return
    try:
        for i in range(len(pdf)):
            page = pdf[i]
            label = f"{name} · página {i + 1}"
            try:
                img = _pdf_page_image(pdfium, page)
                buf = io.BytesIO()
                img.save(buf, "PNG")
                yield label, buf.getvalue()
            except Exception as exc:
                log.warning("Fallo extrayendo página %s de PDF: %s", i + 1, exc)
                yield label, ValueError("no se pudo extraer la página")
            finally:
                page.close()
    finally:
        pdf.close()


def _pdf_page_image(pdfium, page) -> Image.Image:
    """Si la página es un único escaneo a toda página se extrae a su resolución
    nativa (sin pérdida); si no, se renderiza a alta resolución."""
    w_pt, h_pt = page.get_size()
    try:
        images = [o for o in page.get_objects() if o.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE]
        if len(images) == 1:
            obj = images[0]
            left, bottom, right, top = obj.get_bounds()
            coverage = ((right - left) * (top - bottom)) / max(1.0, w_pt * h_pt)
            if coverage > 0.85:
                native = obj.get_bitmap(render=False).to_pil().convert("RGB")
                if native.width * native.height <= MAX_IMAGE_PIXELS and min(native.size) >= 400:
                    return native
    except Exception as exc:  # cualquier rareza del PDF: se renderiza la página
        log.debug("Extracción nativa no disponible: %s", exc)
    scale = min(300 / 72, PDF_MAX_SIDE / max(w_pt, h_pt))
    return page.render(scale=scale).to_pil().convert("RGB")


def expand_upload(name: str, data: bytes) -> Iterator[tuple[str, bytes | Exception]]:
    kind = sniff(data[:16])
    if kind == "zip":
        yield from iter_zip(name, data)
    elif kind == "pdf":
        yield from iter_pdf(name, data)
    elif kind in IMAGE_EXTS:
        yield name, data
    else:
        yield name, ValueError("formato no admitido (usa ZIP, CBZ, PDF, JPG, PNG o WEBP)")


def ingest(uploads: list[tuple[str, bytes]], existing: list[tuple[str, str, str]], capacity: int,
           add: Callable[[ImportedImage, str | None], str], progress: Callable[[float, str], None] | None = None
           ) -> ImportReport:
    """Importa los archivos subidos.

    `existing`: (page_id, sha1, dhash) de las páginas ya presentes.
    `add`: persiste una imagen y devuelve el id de página creado.
    """
    report = ImportReport()
    known = list(existing)
    sha_index = {sha: pid for pid, sha, _ in known}
    total = len(uploads)
    for n, (name, data) in enumerate(sorted(uploads, key=lambda u: natural_key(u[0]))):
        for entry_name, payload in expand_upload(name, data):
            if progress:
                progress(n / max(1, total), f"Importando {entry_name}")
            if isinstance(payload, Exception):
                report.errors.append({"file": entry_name, "reason": str(payload)})
                continue
            if capacity <= 0:
                report.skipped_limit += 1
                continue
            try:
                img = load_image(PurePosixPath(entry_name).name or entry_name, payload)
            except ValueError as exc:
                report.errors.append({"file": entry_name, "reason": str(exc)})
                continue
            if img.sha1 in sha_index:
                report.duplicates.append({"file": entry_name, "of": sha_index[img.sha1], "exact": True})
                continue
            near = next((pid for pid, _sha, dh in known if hamming(dh, img.dhash) <= 3), None)
            page_id = add(img, near)
            if near:
                report.duplicates.append({"file": entry_name, "of": near, "exact": False, "page_id": page_id})
            known.append((page_id, img.sha1, img.dhash))
            sha_index[img.sha1] = page_id
            report.added.append(page_id)
            capacity -= 1
    if progress:
        progress(1.0, "Importación completada")
    return report
