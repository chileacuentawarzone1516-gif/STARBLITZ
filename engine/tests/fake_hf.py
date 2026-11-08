"""Hugging Face simulado: API de modelos, listado de archivos con SHA‑256 y descarga con Range.

Permite probar el flujo real de búsqueda → ficha → instalación (reanudación, integridad, repos
restringidos, incompatibilidad) sin descargar nada de internet.
"""

from __future__ import annotations

import hashlib
import re
import threading

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

SHA = "a" * 40


def _blob(seed: str, size: int) -> bytes:
    out, block = bytearray(), hashlib.sha256(seed.encode()).digest()
    while len(out) < size:
        block = hashlib.sha256(block).digest()
        out += block
    return bytes(out[:size])


# repo → (info, {archivo: bytes | (tamaño_declarado, None)})
REPOS: dict[str, dict] = {
    "fake-org/Tiny-Qwen-GGUF": {
        "info": {"sha": SHA, "gated": False, "cardData": {"license": "apache-2.0"}, "tags": ["gguf", "license:apache-2.0", "ja", "en", "multilingual"],
                 "gguf": {"total": 4_000_000_000, "architecture": "qwen35", "context_length": 262144}},
        "files": {"Tiny-Q4_K_M.gguf": _blob("q4", 3_000_000), "Tiny-Q8_0.gguf": _blob("q8", 5_000_000),
                  "Big-00001-of-00002.gguf": _blob("b1", 1_200_000), "Big-00002-of-00002.gguf": _blob("b2", 1_100_000),
                  "mmproj-F16.gguf": _blob("mm", 800_000), "README.md": b"# demo"},
    },
    "fake-org/Gated-GGUF": {
        "info": {"sha": SHA, "gated": "manual", "cardData": {"license": "gemma"}, "tags": ["gguf", "license:gemma"],
                 "gguf": {"total": 2_000_000_000, "architecture": "gemma4", "context_length": 131072}},
        "files": {"Gated-Q4_0.gguf": _blob("g", 1_000_000)}, "token": "good",
    },
    "fake-org/Huge-GGUF": {
        "info": {"sha": SHA, "gated": False, "cardData": {"license": "cc-by-nc-4.0"}, "tags": ["gguf", "license:cc-by-nc-4.0"],
                 "gguf": {"total": 400_000_000_000, "architecture": "llama", "context_length": 32768}},
        "files": {"Huge-Q4_K_M.gguf": (230_000_000_000, None)},
    },
}
STATE = {"fail_once": set(), "corrupt": set(), "requests": []}


def build_app() -> FastAPI:
    app = FastAPI()

    def _authorized(repo: str, request: Request) -> bool:
        need = REPOS[repo].get("token")
        return not need or request.headers.get("authorization") == f"Bearer {need}"

    @app.get("/api/models")
    async def search(request: Request, search: str = "", limit: int = 20):
        STATE["requests"].append(("search", search))
        out = [{"id": rid, "downloads": 1000 - i, "likes": i, "tags": r["info"]["tags"], "gated": r["info"]["gated"],
                "lastModified": "2026-10-01T00:00:00Z", "pipeline_tag": "text-generation"}
               for i, (rid, r) in enumerate(REPOS.items()) if search.lower() in rid.lower()]
        return out[:limit]

    @app.get("/api/models/{org}/{name}")
    async def info(org: str, name: str, request: Request):
        repo = f"{org}/{name}"
        if repo not in REPOS:
            return JSONResponse({"error": "not found"}, 404)
        if not _authorized(repo, request):
            return JSONResponse({"error": "gated"}, 401)
        return {"id": repo, **REPOS[repo]["info"]}

    @app.get("/api/models/{org}/{name}/tree/{rev}")
    async def tree(org: str, name: str, rev: str, request: Request):
        repo = f"{org}/{name}"
        if repo not in REPOS:
            return JSONResponse({"error": "not found"}, 404)
        if not _authorized(repo, request):
            return JSONResponse({"error": "gated"}, 401)
        items = []
        for fname, data in REPOS[repo]["files"].items():
            if isinstance(data, tuple):
                items.append({"type": "file", "path": fname, "size": data[0], "lfs": {"oid": "f" * 64, "size": data[0]}})
            elif fname.endswith(".gguf"):
                items.append({"type": "file", "path": fname, "size": 134, "lfs": {"oid": hashlib.sha256(data).hexdigest(), "size": len(data)}})
            else:
                items.append({"type": "file", "path": fname, "size": len(data)})
        return items

    @app.get("/{org}/{name}/resolve/{rev}/{path:path}")
    async def resolve(org: str, name: str, rev: str, path: str, request: Request):
        repo = f"{org}/{name}"
        if repo not in REPOS or path not in REPOS[repo]["files"] or not _authorized(repo, request):
            return Response(status_code=404)
        data = REPOS[repo]["files"][path]
        if isinstance(data, tuple):
            return Response(status_code=404)
        STATE["requests"].append(("resolve", path, request.headers.get("range", ""), request.headers.get("authorization", "")))
        if path in STATE["corrupt"]:
            data = bytes(len(data))  # mismo tamaño, contenido distinto → falla el SHA‑256
        start = 0
        m = re.match(r"bytes=(\d+)-", request.headers.get("range", ""))
        if m:
            start = int(m.group(1))
        body = data[start:]
        if path in STATE["fail_once"] and start == 0:
            STATE["fail_once"].discard(path)
            cut = len(data) // 2

            async def broken():
                yield data[:cut]
                raise RuntimeError("conexión cortada")
            from fastapi.responses import StreamingResponse

            return StreamingResponse(broken(), media_type="application/octet-stream", headers={"Content-Length": str(len(data))})
        headers = {"Accept-Ranges": "bytes", "Content-Length": str(len(body))}
        if m:
            headers["Content-Range"] = f"bytes {start}-{len(data) - 1}/{len(data)}"
            return Response(body, status_code=206, headers=headers, media_type="application/octet-stream")
        return Response(body, headers=headers, media_type="application/octet-stream")

    return app


def serve(port: int) -> uvicorn.Server:
    server = uvicorn.Server(uvicorn.Config(build_app(), host="127.0.0.1", port=port, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    import time

    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    return server
