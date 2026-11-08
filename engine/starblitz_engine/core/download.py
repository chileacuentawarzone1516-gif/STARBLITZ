"""Descarga de archivos grandes con reanudación, verificación de integridad y control de flujo.

Se usa tanto para los modelos de visión como para los modelos de lenguaje (GGUF). Reglas:

- Se escribe en ``<destino>.part`` y solo se renombra al terminar y verificar, de modo que un
  archivo con el nombre final siempre está completo.
- Una descarga interrumpida (cierre de la app, corte de red) continúa donde se quedó con ``Range``.
- Si se conoce el SHA-256 se verifica; si no coincide, se borra y se informa.
- Las credenciales (token de Hugging Face) solo viajan al host original: ``httpx`` las retira
  en las redirecciones a otro dominio (la CDN).
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

import httpx

from .errors import AppError, CancelledError

log = logging.getLogger(__name__)

CHUNK = 1024 * 1024
ProgressFn = Callable[[int, int], None]  # (bytes_hechos, bytes_totales)


def sha256_file(path: Path, progress: Callable[[int], None] | None = None) -> str:
    h = hashlib.sha256()
    done = 0
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK * 4), b""):
            h.update(block)
            done += len(block)
            if progress:
                progress(done)
    return h.hexdigest()


def download_file(
    urls: list[str] | tuple[str, ...],
    dest: Path,
    *,
    expected_size: int = 0,
    sha256: str | None = None,
    headers: dict[str, str] | None = None,
    progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
    wait_if_paused: Callable[[], None] | None = None,
    retries: int = 4,
) -> Path:
    """Descarga ``urls`` (se prueban en orden) hasta ``dest``. Devuelve la ruta final."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and (not expected_size or dest.stat().st_size == expected_size):
        if not sha256 or sha256_file(dest) == sha256:
            if progress:
                progress(dest.stat().st_size, dest.stat().st_size)
            return dest
        dest.unlink()  # existe pero está corrupto

    part = dest.with_name(dest.name + ".part")
    cancel = cancel or threading.Event()
    last: Exception | None = None
    for url in urls:
        for attempt in range(retries):
            try:
                _stream(url, part, expected_size, headers or {}, progress, cancel, wait_if_paused)
                break
            except CancelledError:
                raise
            except AppError:
                raise
            except (httpx.TransportError, httpx.HTTPStatusError) as exc:
                last = exc
                status = getattr(getattr(exc, "response", None), "status_code", 0)
                if status in (401, 403, 404, 410):
                    break  # no tiene sentido reintentar: se prueba la URL siguiente o se informa
                log.warning("Descarga interrumpida (%s), intento %d/%d: %s", url, attempt + 1, retries, exc)
                if cancel.wait(min(2.0 * (attempt + 1), 8.0)):
                    raise CancelledError() from exc
        else:
            continue
        if part.is_file() and (not expected_size or part.stat().st_size == expected_size):
            break
    else:
        _raise_download_error(last)

    if not part.is_file():
        _raise_download_error(last)
    size = part.stat().st_size
    if expected_size and size != expected_size:
        part.unlink(missing_ok=True)
        raise AppError("integrity", f"La descarga de {dest.name} quedó incompleta ({size} de {expected_size} bytes). Reinténtala.", 502)
    if sha256:
        if sha256_file(part) != sha256.lower():
            part.unlink(missing_ok=True)
            raise AppError("integrity", f"La descarga de {dest.name} está corrupta (huella SHA-256 distinta). Reinténtala.", 502)
    part.replace(dest)
    return dest


def _raise_download_error(last: Exception | None) -> None:
    status = getattr(getattr(last, "response", None), "status_code", 0)
    if status in (401, 403):
        raise AppError("auth_required", "Este archivo exige iniciar sesión en Hugging Face (modelo restringido). "
                                        "Añade tu token en Configuración → Modelos y acepta la licencia en la web del modelo.", 403)
    if status == 404:
        raise AppError("not_found", "El archivo ya no existe en el repositorio.", 404)
    raise AppError("download_failed", "No se pudo descargar el archivo. Comprueba tu conexión a Internet y vuelve a intentarlo; "
                                      "la descarga continuará donde se quedó.", 502)


def _stream(url: str, part: Path, expected_size: int, headers: dict[str, str], progress: ProgressFn | None,
            cancel: threading.Event, wait_if_paused: Callable[[], None] | None) -> None:
    offset = part.stat().st_size if part.exists() else 0
    if expected_size and offset > expected_size:
        part.unlink()
        offset = 0
    if expected_size and offset == expected_size:
        return
    req_headers = dict(headers)
    if offset:
        req_headers["Range"] = f"bytes={offset}-"
    timeout = httpx.Timeout(30.0, read=90.0)
    with httpx.stream("GET", url, headers=req_headers, follow_redirects=True, timeout=timeout) as resp:
        if resp.status_code == 416:  # el servidor dice que ya tenemos todo
            return
        resp.raise_for_status()
        if offset and resp.status_code == 200:  # no admite reanudar: se empieza de cero
            offset = 0
        length = int(resp.headers.get("Content-Length", "0") or 0)
        total = expected_size or (length + offset if length else 0)
        written = offset
        last_report = 0.0
        with open(part, "ab" if offset else "wb") as fh:
            for chunk in resp.iter_bytes(CHUNK):
                if cancel.is_set():
                    raise CancelledError()
                if wait_if_paused:
                    wait_if_paused()
                fh.write(chunk)
                written += len(chunk)
                now = time.monotonic()
                if progress and (now - last_report > 0.2):
                    last_report = now
                    progress(written, total)
    if progress:
        progress(written, total or written)
