"""API HTTP local del motor STARBLITZ.

Seguridad:
- Todas las rutas /api (salvo /api/health) exigen el token de sesión que genera
  la aplicación de escritorio (cabecera Authorization o parámetro `t` para
  recursos que el navegador carga directamente: imágenes y eventos SSE).
- Solo escucha en 127.0.0.1: cada dispositivo (PC o móvil) trabaja con sus propios
  recursos y no se expone nunca en la red.
- Los errores devuelven mensajes controlados, nunca trazas internas.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .. import __version__
from ..core.errors import AppError, NotFoundError, ValidationError
from ..core.hardware import detect
from ..core.ids import validate_id
from ..importers.ingest import ImportedImage, ingest
from ..llm import advisor, benchmark, hf
from ..llm.catalog import license_info
from ..llm.library import describe_repo, dump as dump_model
from ..pipeline import runstate
from ..projects.schema import AUTO_LANG, Project, ProjectCreate, ProjectUpdate, Region, RegionUpdate
from ..translate.llm import create_client
from ..vision.langid import direction_for
from ..vision.ocr.router import SUPPORTED_SOURCE_LANGS
from .context import Services

log = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
# Orígenes de la propia app: interfaz servida por el motor y Vite en desarrollo.
ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
LANGUAGES = {AUTO_LANG: "Detectar automáticamente", **SUPPORTED_SOURCE_LANGS}


class ProcessRequest(BaseModel):
    stages: list[str] = Field(default_factory=lambda: ["analyze", "translate", "clean"])
    page_ids: list[str] | None = None
    force: bool = False
    resume: bool = False  # continuar la última ejecución (mismas etapas) en lugar de empezar una nueva


class OrderRequest(BaseModel):
    page_ids: list[str]


class BBoxRequest(BaseModel):
    bbox: tuple[int, int, int, int]


class TranslateRegionsRequest(BaseModel):
    region_ids: list[str] = Field(min_length=1, max_length=200)


class PageUpdate(BaseModel):
    approved: bool | None = None


class InstallRequest(BaseModel):
    repo: str = Field(min_length=3, max_length=200)
    file: str = Field(min_length=5, max_length=300)
    mmproj: str | None = Field(None, max_length=300)
    force: bool = False


class ActivateRequest(BaseModel):
    id: str = Field(min_length=3, max_length=80)


class CompareRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=6)


class TestRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    source_lang: str = "ja"


def create_app(svc: Services, ui_dir: Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        svc.bus.bind_loop(asyncio.get_running_loop())
        yield

    app = FastAPI(title="STARBLITZ Engine", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origin_regex=ALLOWED_ORIGIN_REGEX, allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"],
    )

    # -- seguridad --------------------------------------------------------
    @app.middleware("http")
    async def auth_and_headers(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and path != "/api/health" and request.method != "OPTIONS":
            supplied = ""
            header = request.headers.get("authorization", "")
            if header.lower().startswith("bearer "):
                supplied = header[7:].strip()
            else:
                supplied = request.query_params.get("t", "")
            if not supplied or not hmac.compare_digest(supplied, svc.token):
                return JSONResponse({"error": {"code": "unauthorized", "message": "Sesión no autorizada."}}, 401)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if not path.startswith("/api/"):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
                "font-src 'self' data:; connect-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
            )
            response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.exception_handler(AppError)
    async def _app_error(_req: Request, exc: AppError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message, **({"details": exc.details} if exc.details else {})}},
                            status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_req: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", ())[1:])
        return JSONResponse({"error": {"code": "invalid_request", "message": f"Datos no válidos: {field} {first.get('msg', '')}".strip()}}, 422)

    @app.exception_handler(Exception)
    async def _unexpected(_req: Request, exc: Exception):
        log.exception("Error no controlado: %s", exc)
        return JSONResponse({"error": {"code": "internal", "message": "Error interno inesperado."}}, 500)

    # -- sistema ----------------------------------------------------------
    @app.get("/api/health")
    async def health():
        return {"ok": True, "app": "STARBLITZ", "version": __version__}

    @app.get("/api/system")
    async def system():
        hw = await asyncio.to_thread(detect)
        cfg = svc.settings.value
        profile = advisor.current_profile(hw, cfg.processing.profile)
        llm = await asyncio.to_thread(_llm_summary, svc)
        return {
            "version": __version__,
            "hardware": hw.to_dict(),
            "device": advisor.device_caps(hw),
            "profile": {"id": profile.id, "label": profile.label, "auto": cfg.processing.profile == "auto"},
            "llm": llm,
            "accelerator": _accelerator(hw.onnx_providers, cfg.processing.device),
            "models": svc.models.status(),
            "languages": LANGUAGES,
            "data_dir": str(svc.paths.root),
            "offline": _offline_matrix(svc),
        }

    @app.get("/api/settings")
    async def get_settings():
        return svc.settings.value.public_dict()

    @app.patch("/api/settings")
    async def patch_settings(patch: dict):
        updated = svc.settings.update(patch)
        svc.processor.refresh_settings()
        return updated.public_dict()

    @app.get("/api/events")
    async def events(request: Request):
        q = svc.bus.subscribe()

        async def stream():
            try:
                yield "retry: 2000\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(q.get(), timeout=15)
                        yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                svc.bus.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/jobs")
    async def jobs(project_id: str | None = None):
        return svc.jobs.list(project_id)

    @app.get("/api/jobs/{job_id}")
    async def job(job_id: str):
        j = svc.jobs.get(job_id)
        if not j:
            raise NotFoundError("la tarea")
        return j.public()

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        return {"cancelled": svc.jobs.cancel(job_id)}

    @app.post("/api/jobs/{job_id}/pause")
    async def pause_job(job_id: str):
        return {"paused": svc.jobs.pause(job_id)}

    @app.post("/api/jobs/{job_id}/resume")
    async def resume_job(job_id: str):
        return {"resumed": svc.jobs.resume(job_id)}

    # -- modelos de visión ---------------------------------------------------
    @app.get("/api/models")
    async def models():
        return {"vision": svc.models.status()}

    @app.post("/api/models/{model_id}/install")
    async def install_model(model_id: str):
        spec_ids = {m["id"] for m in svc.models.status()}
        if model_id not in spec_ids:
            raise NotFoundError("el modelo")
        job = svc.jobs.submit("model_install", f"Descargando modelo {model_id}",
                              lambda ctx: svc.models.install(model_id, lambda p, m: ctx.update(p, message=m), ctx.cancel_event),
                              lane="io")
        return job.public()

    @app.delete("/api/models/{model_id}")
    async def remove_model(model_id: str):
        await asyncio.to_thread(svc.models.remove, model_id)
        svc.processor.refresh_settings()
        return {"ok": True}

    # -- modelos de lenguaje (llama.cpp integrado + Hugging Face) ---------------------
    @app.get("/api/llm")
    async def llm_overview():
        return await asyncio.to_thread(_llm_overview, svc)

    @app.get("/api/llm/search")
    async def llm_search(q: str = "", limit: int = 20):
        token = svc.settings.value.llm.hf_token
        results = await asyncio.to_thread(hf.search, q, token, limit)
        installed = {m.repo for m in svc.library.installed()}
        return [{**r, "license_info": license_info(r["license"]), "installed": r["repo"] in installed} for r in results]

    @app.get("/api/llm/repo")
    async def llm_repo(repo: str):
        hf.validate_repo(repo)
        token = svc.settings.value.llm.hf_token

        def load():
            remote = hf.fetch_model(repo, token)
            hw = detect()
            profile = advisor.current_profile(hw, svc.settings.value.processing.profile)
            info = describe_repo(remote, hw, profile.context)
            installed = {(m.repo, m.files[0]) for m in svc.library.installed()}
            for f in info["files"]:
                f["installed"] = (repo, f["path"]) in installed
            return info
        return await asyncio.to_thread(load)

    @app.post("/api/llm/install")
    async def llm_install(body: InstallRequest):
        hf.validate_repo(body.repo)
        hf.validate_path(body.file)
        if svc.jobs.active_for_kind("llm_install"):
            raise AppError("busy", "Ya hay un modelo descargándose. Espera a que termine o cancélalo.", 409)
        cfg = svc.settings.value
        hw = await asyncio.to_thread(detect)
        profile = advisor.current_profile(hw, cfg.processing.profile)

        def run(ctx):
            model = svc.library.install(
                body.repo, body.file, mmproj=body.mmproj, token=cfg.llm.hf_token, hw=hw, context=profile.context,
                progress=lambda p, m: ctx.update(p, message=m), cancel=ctx.cancel_event, wait_if_paused=ctx.wait_if_paused,
                force=body.force)
            if not svc.settings.value.llm.model and cfg.llm.provider == "builtin":
                svc.settings.update({"llm": {"model": model.id}})  # el primero que se instala pasa a ser el activo
            return dump_model(model)
        job = svc.jobs.submit("llm_install", f"Descargando {Path(body.file).name}", run, lane="io", pausable=True)
        return job.public()

    @app.delete("/api/llm/installed/{model_id}")
    async def llm_remove(model_id: str):
        def apply():
            if svc.runtime.running_model() == model_id:
                svc.runtime.stop()
            svc.library.remove(model_id)
            if svc.settings.value.llm.model == model_id:
                svc.settings.update({"llm": {"model": ""}})
        await asyncio.to_thread(apply)
        return {"ok": True}

    @app.post("/api/llm/activate")
    async def llm_activate(body: ActivateRequest):
        def apply():
            svc.library.get(body.id)  # NotFoundError si no está instalado
            svc.settings.update({"llm": {"provider": "builtin", "model": body.id}})
            if svc.runtime.running_model() not in (None, body.id):
                svc.runtime.stop()  # libera la memoria del anterior; el nuevo se carga al traducir
        await asyncio.to_thread(apply)
        return {"ok": True, "active": body.id}

    @app.get("/api/llm/runtime")
    async def llm_runtime():
        return svc.runtime.status()

    @app.post("/api/llm/unload")
    async def llm_unload():
        await asyncio.to_thread(svc.runtime.stop)
        return svc.runtime.status()

    @app.post("/api/llm/compare")
    async def llm_compare(body: CompareRequest):
        for mid in body.ids:
            svc.library.get(mid)

        def run(ctx):
            def make(mid: str):
                cfg = svc.settings.value
                client = create_client(cfg.llm, svc.runtime, svc.library)
                from ..translate.plain import make_translator

                return make_translator(client, mid, cfg.translation.model_copy(update={"quality": "balanced"}), svc.library)
            return benchmark.compare(body.ids, make, lambda p, m: ctx.update(p, message=m), ctx.cancel_event)
        return svc.jobs.submit("llm_compare", "Comparando modelos", run).public()

    @app.post("/api/llm/test")
    async def llm_test(body: TestRequest):
        """Traducción de prueba de una frase para verificar el modelo activo."""
        if body.source_lang not in SUPPORTED_SOURCE_LANGS:
            raise ValidationError("invalid_lang", "Idioma de origen no admitido.")
        project, page = benchmark.make_probe(body.source_lang, [body.text])
        translator = svc.processor.translator()
        result = await asyncio.to_thread(translator.translate_page, project, page, prev_page=None, next_page=None,
                                         story=[], image_jpeg=None)
        r = result.updated[0] if result.updated else page.regions[0]
        return {"model": translator.model, "translation": r.translation, "confidence": r.confidence, "flags": r.flags,
                "note": r.note}

    # -- proyectos --------------------------------------------------------
    @app.get("/api/projects")
    async def list_projects():
        return await asyncio.to_thread(svc.store.list)

    @app.post("/api/projects")
    async def create_project(body: ProjectCreate):
        s = svc.settings.value
        if body.source_lang not in LANGUAGES:
            raise ValidationError("invalid_lang", "Idioma de origen no admitido.")
        project = Project(
            id=svc.store.new_project_id(), name=body.name.strip(), source_lang=body.source_lang,
            target_variant=body.target_variant or s.translation.target_variant,
            reading_direction=body.reading_direction or direction_for(body.source_lang if body.source_lang != AUTO_LANG else "ja"),
            direction_auto=body.reading_direction is None and body.source_lang == AUTO_LANG,
            honorifics=body.honorifics or s.translation.honorifics, sfx=s.translation.sfx, synopsis=body.synopsis,
            translation_profile=body.translation_profile or s.translation.profile,
        )
        await asyncio.to_thread(svc.store.create, project)
        return project.model_dump(mode="json")

    @app.get("/api/projects/{pid}")
    async def get_project(pid: str):
        def load():
            project = svc.store.get(pid)
            return {"project": project.model_dump(mode="json"),
                    "pages": [p.model_dump(mode="json") for p in svc.store.pages(project)],
                    "summary": svc.store.summary(project), "run": _run_info(svc, pid)}
        return await asyncio.to_thread(load)

    @app.patch("/api/projects/{pid}")
    async def update_project(pid: str, body: ProjectUpdate):
        def apply():
            with svc.store.lock(pid):
                project = svc.store.get(pid)
                data = project.model_dump()
                patch = body.model_dump(exclude_none=True)
                data.update(patch)
                if data["source_lang"] not in LANGUAGES:
                    raise ValidationError("invalid_lang", "Idioma de origen no admitido.")
                if "reading_direction" in patch:
                    data["direction_auto"] = False  # la elección manual manda sobre la deducida
                elif "source_lang" in patch and data["source_lang"] != AUTO_LANG:
                    data["reading_direction"], data["direction_auto"] = direction_for(data["source_lang"]), False
                elif data["source_lang"] == AUTO_LANG and project.source_lang != AUTO_LANG:
                    data["detected_lang"], data["direction_auto"] = "", True  # vuelve a detectarse en el próximo proceso
                updated = Project.model_validate(data)
                svc.store.save(updated)
                return updated.model_dump(mode="json")
        return await asyncio.to_thread(apply)

    @app.delete("/api/projects/{pid}")
    async def delete_project(pid: str):
        if svc.jobs.active_for(pid):
            raise AppError("busy", "Espera a que termine el procesamiento o cancélalo antes de eliminar el proyecto.", 409)
        await asyncio.to_thread(svc.store.delete, pid)
        return {"ok": True}

    @app.post("/api/projects/{pid}/import")
    async def import_files(pid: str, request: Request, files: list[UploadFile] = File(...)):
        length = int(request.headers.get("content-length", "0") or 0)
        if length > MAX_UPLOAD_BYTES:
            raise AppError("too_large", "El archivo supera el máximo de 2 GB.", 413)
        validate_id(pid, "proyecto")
        svc.store.get(pid)
        uploads: list[tuple[str, bytes]] = []
        for f in files:
            uploads.append((Path(f.filename or "archivo").name, await f.read()))
            await f.close()

        def run(ctx):
            with svc.store.lock(pid):
                project = svc.store.get(pid)
                existing = [(p.id, p.sha1, p.dhash) for p in svc.store.pages(project)]
                capacity = svc.settings.value.processing.max_pages - len(project.page_ids)

                def add(img: ImportedImage, dup: str | None) -> str:
                    page = svc.store.add_page(project, img.data, img.ext, img.name, img.width, img.height, img.sha1, img.dhash, dup)
                    return page.id

                report = ingest(uploads, existing, capacity, add, lambda p, m: ctx.update(p, message=m))
                if project.cover_page_id is None and project.page_ids:
                    project.cover_page_id = project.page_ids[0]
                svc.store.save(project)
            result = report.to_dict()
            result["limit"] = svc.settings.value.processing.max_pages
            return result

        job = svc.jobs.submit("import", "Importando archivos", run, project_id=pid, lane="io")
        return job.public()

    @app.put("/api/projects/{pid}/pages/order")
    async def reorder(pid: str, body: OrderRequest):
        def apply():
            with svc.store.lock(pid):
                project = svc.store.get(pid)
                svc.store.reorder(project, body.page_ids)
                svc.store.save(project)
                return project.page_ids
        return {"page_ids": await asyncio.to_thread(apply)}

    @app.get("/api/projects/{pid}/pages/{gid}")
    async def get_page(pid: str, gid: str):
        return (await asyncio.to_thread(svc.store.get_page, pid, gid)).model_dump(mode="json")

    @app.patch("/api/projects/{pid}/pages/{gid}")
    async def patch_page(pid: str, gid: str, body: PageUpdate):
        def apply():
            with svc.store.lock(pid):
                page = svc.store.get_page(pid, gid)
                if body.approved is not None:
                    page.approved = body.approved
                    if body.approved:
                        for r in page.regions:
                            if r.translation.strip() and r.status in ("translated", "review", "edited"):
                                r.status = "approved"
                svc.store.save_page(pid, page)
                return page.model_dump(mode="json")
        return await asyncio.to_thread(apply)

    @app.delete("/api/projects/{pid}/pages/{gid}")
    async def delete_page(pid: str, gid: str):
        def apply():
            with svc.store.lock(pid):
                project = svc.store.get(pid)
                svc.store.delete_page(project, gid)
                svc.store.save(project)
        await asyncio.to_thread(apply)
        return {"ok": True}

    @app.get("/api/projects/{pid}/pages/{gid}/image/{kind}")
    async def page_image(pid: str, gid: str, kind: str):
        page = await asyncio.to_thread(svc.store.get_page, pid, gid)
        paths = {
            "original": svc.store.original_path(pid, page),
            "thumb": svc.store.thumb_path(pid, gid),
            "clean": svc.store.clean_path(pid, gid),
            "mask": svc.store.mask_path(pid, gid),
            "cthumb": None,
        }
        path = paths.get(kind)
        if kind == "cthumb":
            path = await asyncio.to_thread(svc.store.clean_thumb, pid, gid)
        if path is None or not path.exists():
            raise NotFoundError("la imagen")
        media = {"original": f"image/{'jpeg' if page.ext == 'jpg' else page.ext}", "thumb": "image/webp",
                 "cthumb": "image/webp"}.get(kind, "image/png")
        return FileResponse(path, media_type=media, headers={"Cache-Control": "private, max-age=0, must-revalidate"})

    @app.patch("/api/projects/{pid}/pages/{gid}/regions/{rid}")
    async def patch_region(pid: str, gid: str, rid: str, body: RegionUpdate):
        patch = body.model_dump(exclude_none=True)
        if "style" in patch:
            patch["style"] = body.style
        region = await asyncio.to_thread(svc.store.update_region, pid, gid, rid, patch)
        return region.model_dump(mode="json")

    @app.put("/api/projects/{pid}/pages/{gid}/regions/{rid}")
    async def put_region(pid: str, gid: str, rid: str, body: Region):
        """Inserta o sustituye una región completa (p. ej. deshacer un borrado)."""
        if body.id != rid:
            raise ValidationError("id_mismatch", "El identificador no coincide.")

        def apply():
            with svc.store.lock(pid):
                page = svc.store.get_page(pid, gid)
                page.regions = [r for r in page.regions if r.id != rid] + [body]
                page.regions.sort(key=lambda r: r.order)
                for i, r in enumerate(page.regions):
                    r.order = i
                svc.store.save_page(pid, page)
                return next(r for r in page.regions if r.id == rid).model_dump(mode="json")
        return await asyncio.to_thread(apply)

    @app.post("/api/projects/{pid}/pages/{gid}/regions")
    async def add_region(pid: str, gid: str, body: BBoxRequest):
        region = await asyncio.to_thread(svc.processor.reocr_region, pid, gid, None, body.bbox)
        return region.model_dump(mode="json")

    @app.post("/api/projects/{pid}/pages/{gid}/regions/{rid}/ocr")
    async def reocr(pid: str, gid: str, rid: str, body: BBoxRequest):
        region = await asyncio.to_thread(svc.processor.reocr_region, pid, gid, rid, body.bbox)
        return region.model_dump(mode="json")

    @app.delete("/api/projects/{pid}/pages/{gid}/regions/{rid}")
    async def delete_region(pid: str, gid: str, rid: str):
        def apply():
            with svc.store.lock(pid):
                page = svc.store.get_page(pid, gid)
                before = len(page.regions)
                page.regions = [r for r in page.regions if r.id != rid]
                if len(page.regions) == before:
                    raise NotFoundError("el texto")
                for i, r in enumerate(page.regions):
                    r.order = i
                svc.store.save_page(pid, page)
        await asyncio.to_thread(apply)
        return {"ok": True}

    @app.post("/api/projects/{pid}/pages/{gid}/translate")
    async def translate_regions(pid: str, gid: str, body: TranslateRegionsRequest):
        job = svc.jobs.submit("translate_regions", "Retraduciendo textos",
                              lambda ctx: [r.model_dump(mode="json") for r in svc.processor.translate_single(pid, gid, body.region_ids)],
                              project_id=pid)
        return job.public()

    @app.post("/api/projects/{pid}/pages/{gid}/clean")
    async def clean(pid: str, gid: str):
        def run(ctx):
            project = svc.store.get(pid)
            page = svc.store.get_page(pid, gid)
            return svc.processor.clean_page(project, page).model_dump(mode="json")
        return svc.jobs.submit("clean", "Reconstruyendo página", run, project_id=pid).public()

    @app.post("/api/projects/{pid}/process")
    async def process(pid: str, body: ProcessRequest):
        stages = tuple(s for s in body.stages if s in ("analyze", "translate", "clean"))
        if body.resume:
            previous = await asyncio.to_thread(runstate.load, svc.store, pid)
            if previous and previous.get("stages"):
                stages = tuple(previous["stages"])
        if not stages:
            raise ValidationError("invalid_stages", "Indica al menos una etapa válida.")
        if svc.jobs.active_for(pid):
            raise AppError("busy", "Este proyecto ya se está procesando.", 409)
        svc.store.get(pid)
        title = "Reanudando proyecto" if body.resume else "Procesando proyecto"
        job = svc.jobs.submit("process", title, lambda ctx: svc.processor.run(ctx, pid, stages, body.page_ids, body.force),
                              project_id=pid, pausable=True)
        return job.public()

    @app.get("/api/projects/{pid}/run")
    async def run_info(pid: str):
        svc.store.get(pid)
        return await asyncio.to_thread(_run_info, svc, pid)

    # -- interfaz web ------------------------------------------------------
    if ui_dir and ui_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(ui_dir), html=True), name="ui")

    return app


def _offline_matrix(svc: Services) -> list[dict]:
    m = svc.models
    llm_ready = svc.runtime.available() and bool(svc.library.installed())
    return [
        {"component": "Importación y exportación", "offline": True, "requires": ""},
        {"component": "Detección de texto", "offline": m.is_installed("text-detector"),
         "requires": "" if m.is_installed("text-detector") else "Descargar el detector (95 MB) una vez"},
        {"component": "OCR multilingüe (PP-OCR)", "offline": True, "requires": ""},
        {"component": "OCR japonés especializado (Manga OCR)", "offline": m.is_installed("manga-ocr"),
         "requires": "" if m.is_installed("manga-ocr") else "Descargar Manga OCR (460 MB) una vez"},
        {"component": "Reconstrucción avanzada (LaMa)", "offline": m.is_installed("lama"),
         "requires": "" if m.is_installed("lama") else "Descargar LaMa (208 MB) una vez"},
        {"component": "Traducción contextual (motor de lenguaje integrado)", "offline": llm_ready,
         "requires": "" if llm_ready else ("Instalar un modelo de traducción una vez (sección Modelos)"
                                          if svc.runtime.available() else "Falta el servidor de modelos integrado")},
        {"component": "Descarga de modelos y actualizaciones", "offline": False, "requires": "Internet (solo para descargar)"},
    ]


def _run_info(svc: Services, pid: str) -> dict | None:
    job = svc.jobs.active_for(pid)
    return runstate.describe(svc.store, pid, job.public() if job else None)


def _llm_summary(svc: Services) -> dict:
    cfg = svc.settings.value
    hw = detect()
    active = None
    if cfg.llm.provider == "builtin":
        chosen = advisor.resolve_model(svc.library, cfg.llm.model, hw, cfg.processing.profile)
        active = chosen.id if chosen else None
    else:
        active = cfg.llm.model or None
    runtime = svc.runtime.status()
    installed = svc.library.installed()
    return {"provider": cfg.llm.provider, "active": active, "installed": len(installed),
            "ready": (runtime["available"] and bool(installed)) if cfg.llm.provider == "builtin" else bool(active),
            "runtime_available": runtime["available"], "running": runtime["running"], "running_model": runtime["model"],
            "disk_bytes": svc.library.disk_usage()}


def _llm_overview(svc: Services) -> dict:
    cfg = svc.settings.value
    hw = detect()
    profile = advisor.current_profile(hw, cfg.processing.profile)
    summary = _llm_summary(svc)
    installed = []
    for m in svc.library.installed():
        d = dump_model(m)
        d["fit"] = advisor.fit_for(m, hw, profile.context)
        d["active"] = m.id == summary["active"]
        installed.append(d)
    external: dict | None = None
    if cfg.llm.provider != "builtin":
        client = create_client(cfg.llm, svc.runtime, svc.library)
        health = client.health()
        names: list[str] = []
        if health.get("ok"):
            try:
                names = [m.name for m in client.list_models()]
            except AppError:
                names = []
        external = {"base_url": cfg.llm.base_url, "ok": health.get("ok", False), "models": names}
    return {**summary, "runtime": svc.runtime.status(), "installed_models": installed,
            "advice": advisor.advise(hw, svc.library, summary["active"] or "", cfg.processing.profile),
            "installing": svc.library.installing(), "hf_token_set": bool(cfg.llm.hf_token), "external": external}


def _accelerator(providers: list[str], device: str) -> dict:
    if device == "cpu":
        return {"name": "CPU", "gpu": False}
    if "CUDAExecutionProvider" in providers:
        return {"name": "NVIDIA CUDA", "gpu": True}
    if "DmlExecutionProvider" in providers:
        return {"name": "DirectML (GPU)", "gpu": True}
    return {"name": "CPU", "gpu": False}
