"""Cliente mínimo de Hugging Face: solo catálogo y descarga, nunca la API de inferencia de pago.

Antes de instalar un modelo se consulta el repositorio para conocer el commit exacto, el tamaño y la
huella SHA‑256 de cada archivo (``lfs.oid``). La descarga se hace desde ``resolve/<commit>/<archivo>``,
así lo que se instala es exactamente lo que se mostró al usuario aunque el repositorio cambie después.

``HF_ENDPOINT`` permite apuntar a un espejo (y a un servidor simulado en las pruebas).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from ..core.errors import AppError, NotFoundError

DEFAULT_ENDPOINT = "https://huggingface.co"
_SHARD_RE = re.compile(r"^(?P<stem>.+)-(?P<idx>\d{5})-of-(?P<n>\d{5})\.gguf$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,95}/[A-Za-z0-9][\w.-]{0,95}$")
_PATH_RE = re.compile(r"^[\w][\w .()+@=,-]*(/[\w][\w .()+@=,-]*)*$")


def endpoint() -> str:
    return os.environ.get("HF_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")


def validate_repo(repo: str) -> str:
    if not _REPO_RE.match(repo or ""):
        raise AppError("invalid_repo", "Identificador de repositorio no válido (formato esperado: autor/nombre).", 422)
    return repo


def validate_path(path: str) -> str:
    if not path or ".." in path.split("/") or not _PATH_RE.match(path):
        raise AppError("invalid_file", "Nombre de archivo no válido.", 422)
    return path


@dataclass(frozen=True)
class RemoteFile:
    path: str
    size: int
    sha256: str | None


@dataclass(frozen=True)
class RemoteModel:
    repo: str
    revision: str          # commit exacto
    license: str
    architecture: str
    params: int            # parámetros totales según la cabecera GGUF (0 si no consta)
    context_length: int
    gated: bool
    files: dict[str, RemoteFile]

    def file(self, path: str) -> RemoteFile:
        f = self.files.get(path)
        if f is None:
            raise NotFoundError(f"el archivo «{path}» en {self.repo}")
        return f

    def shards_of(self, path: str) -> list[RemoteFile]:
        """El archivo y, si está troceado (``-00001-of-00003.gguf``), todos sus trozos en orden."""
        m = _SHARD_RE.match(path)
        if not m:
            return [self.file(path)]
        names = [f"{m['stem']}-{i:05d}-of-{m['n']}.gguf" for i in range(1, int(m["n"]) + 1)]
        return [self.file(n) for n in names]

    def url(self, path: str) -> str:
        return f"{endpoint()}/{self.repo}/resolve/{self.revision}/{quote(path)}"


def headers(token: str = "") -> dict[str, str]:
    h = {"User-Agent": "STARBLITZ/1.0"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def fetch_model(repo: str, token: str = "", revision: str = "main", timeout: float = 20.0) -> RemoteModel:
    """Consulta ficha y listado de archivos (con tamaño y SHA‑256) de un repositorio."""
    validate_repo(repo)
    base = endpoint()
    try:
        with httpx.Client(headers=headers(token), timeout=timeout, follow_redirects=True) as http:
            info = http.get(f"{base}/api/models/{repo}", params={"revision": revision} if revision != "main" else None)
            _check(info, repo)
            data = info.json()
            files: dict[str, RemoteFile] = {}
            url = f"{base}/api/models/{repo}/tree/{data.get('sha') or revision}"
            params: dict | None = {"recursive": "true"}
            for _ in range(10):  # paginación por cabecera Link
                resp = http.get(url, params=params)
                _check(resp, repo)
                for item in resp.json():
                    if item.get("type") != "file":
                        continue
                    lfs = item.get("lfs") or {}
                    files[item["path"]] = RemoteFile(item["path"], int(lfs.get("size") or item.get("size") or 0),
                                                     (lfs.get("oid") or None))
                nxt = resp.links.get("next", {}).get("url")
                if not nxt:
                    break
                url, params = nxt, None
    except httpx.HTTPError as exc:
        raise AppError("hf_unreachable", "No se pudo conectar con Hugging Face. Comprueba tu conexión a Internet.", 502) from exc
    gguf = data.get("gguf") or {}
    card = data.get("cardData") or {}
    lic = card.get("license") or next((t.split(":", 1)[1] for t in data.get("tags", []) if t.startswith("license:")), "")
    return RemoteModel(
        repo=repo, revision=data.get("sha") or revision, license=str(lic or "desconocida"),
        architecture=str(gguf.get("architecture") or ""), params=int(gguf.get("total") or 0),
        context_length=int(gguf.get("context_length") or 0), gated=bool(data.get("gated")), files=files,
    )


def search(query: str, token: str = "", limit: int = 20, timeout: float = 20.0) -> list[dict]:
    """Busca repositorios con modelos GGUF ordenados por descargas (solo catálogo público; sin API de inferencia)."""
    query = (query or "").strip()[:100]
    params = {"filter": "gguf", "sort": "downloads", "direction": "-1", "limit": str(max(1, min(limit, 40)))}
    if query:
        params["search"] = query
    try:
        with httpx.Client(headers=headers(token), timeout=timeout, follow_redirects=True) as http:
            resp = http.get(f"{endpoint()}/api/models", params=params)
    except httpx.HTTPError as exc:
        raise AppError("hf_unreachable", "No se pudo conectar con Hugging Face. Comprueba tu conexión a Internet.", 502) from exc
    if resp.status_code >= 400:
        raise AppError("hf_error", f"Hugging Face respondió con un error ({resp.status_code}).", 502)
    out = []
    for item in resp.json():
        tags = item.get("tags") or []
        lic = next((t.split(":", 1)[1] for t in tags if t.startswith("license:")), "")
        langs = [t for t in tags if re.fullmatch(r"[a-z]{2,3}", t) and t not in ("en_", "gguf")] + (
            ["multilingual"] if "multilingual" in tags else [])
        out.append({"repo": item.get("id") or item.get("modelId") or "", "downloads": int(item.get("downloads") or 0),
                    "likes": int(item.get("likes") or 0), "license": lic or "desconocida", "gated": bool(item.get("gated")),
                    "updated": item.get("lastModified") or item.get("createdAt") or "", "languages": langs[:8],
                    "task": item.get("pipeline_tag") or ""})
    return [m for m in out if _REPO_RE.match(m["repo"])]


def _check(resp: httpx.Response, repo: str) -> None:
    if resp.status_code in (401, 403):
        raise AppError("auth_required", f"«{repo}» es un repositorio restringido: acepta su licencia en Hugging Face y "
                                        "añade tu token en Configuración → Modelos.", 403)
    if resp.status_code == 404:
        raise NotFoundError(f"el repositorio «{repo}»")
    if resp.status_code >= 400:
        raise AppError("hf_error", f"Hugging Face respondió con un error ({resp.status_code}).", 502)
