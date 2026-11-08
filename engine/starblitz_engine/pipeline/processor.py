"""Orquestación del procesamiento: un proyecto completo como una sola tarea automática.

Cada página recorre ``analizar → traducir → reconstruir`` y queda terminada antes de pasar a la siguiente
(se puede ver y revisar mientras el resto se procesa). Para que la traducción tenga contexto, la página
siguiente se analiza una vez por adelantado. Las etapas son idempotentes y el estado de cada página se
guarda en ``run.json``: una tarea cancelada, pausada o interrumpida se reanuda sin repetir trabajo, y los
textos aprobados o editados por el usuario nunca se sobrescriben.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

import cv2
import numpy as np

from ..core.errors import AppError, CancelledError, LLMUnavailableError, ModelMissingError
from ..core.hardware import detect as detect_hardware
from ..core.ids import new_id
from ..core.jobs import JobContext
from ..core.settings import SettingsStore
from ..llm.advisor import current_profile, resolve_model
from ..llm.library import LLMLibrary
from ..llm.runtime import LlamaRuntime
from ..models.manager import ModelManager
from ..projects.schema import AUTO_LANG, Bubble, Page, Project, Region, TextStyle, now
from ..projects.store import ProjectStore
from ..render.inpaint import EraseTarget, Inpainter
from ..translate.contextual import ContextualTranslator, estimate_max_chars, merge_memory
from ..translate.llm import create_client
from ..vision.bubbles import find_bubble, text_ring_stats
from ..vision.detector import DetectedBlock, TextDetector
from ..vision.langid import direction_for, guess_from_blocks, guess_from_text
from ..vision.layout import detect_panels, reading_order
from ..vision.ocr.router import OCRRouter
from .imaging import annotate_for_llm, read_bgr, read_gray, write_png
from .runstate import STAGE_WEIGHT, RunState

log = logging.getLogger(__name__)

STAGES = ("analyze", "translate", "clean")
LANG_SAMPLE_PAGES = 8


class Processor:
    def __init__(self, store: ProjectStore, models: ModelManager, settings: SettingsStore, library: LLMLibrary,
                 runtime: LlamaRuntime, publish: Callable[[dict], None] | None = None):
        self.store = store
        self.models = models
        self.settings = settings
        self.library = library
        self.runtime = runtime
        self._publish = publish or (lambda _e: None)
        self._detector: TextDetector | None = None
        self._device = settings.value.processing.device
        self._ocr = OCRRouter(models, self._device)
        self._inpainter = Inpainter(models, self._device, self._inpaint_mode())
        self._lock = threading.Lock()

    # -- recursos -----------------------------------------------------------
    def profile(self):
        return current_profile(detect_hardware(), self.settings.value.processing.profile)

    def _inpaint_mode(self) -> str:
        chosen = self.settings.value.processing.inpaint
        return self.profile().inpaint if chosen == "auto" else chosen

    def refresh_settings(self) -> None:
        s = self.settings.value.processing
        with self._lock:
            if s.device != self._device:
                self._device = s.device
                self._detector = None
                self._ocr.reset(s.device)
                self._inpainter = Inpainter(self.models, s.device, self._inpaint_mode())
            else:
                self._inpainter.mode = self._inpaint_mode()

    def detector(self) -> TextDetector:
        with self._lock:
            if self._detector is None:
                if not self.models.is_installed("text-detector"):
                    raise ModelMissingError("text-detector", "Detector de texto")
                self._detector = TextDetector(self.models.path("text-detector", "comictextdetector.onnx"), self._device)
            return self._detector

    def llm_model(self) -> str:
        """Identificador del modelo de traducción que se usará (el elegido, o el que mejor encaja con el equipo)."""
        s = self.settings.value.llm
        if s.provider != "builtin":
            if not s.model:
                raise LLMUnavailableError("Elige el modelo de tu servidor externo en Configuración → Modelos.")
            return s.model
        chosen = resolve_model(self.library, s.model, detect_hardware(), self.settings.value.processing.profile)
        if chosen is None:
            raise LLMUnavailableError("Todavía no hay ningún modelo de traducción instalado. Instala uno en la sección "
                                      "Modelos: hay una recomendación para tu equipo.")
        return chosen.id

    def use_vision(self) -> bool:
        """¿Se envía la imagen de la página al modelo? Requiere permiso del usuario, equipo capaz y modelo con visión."""
        s = self.settings.value.llm
        if not s.use_vision or not self.profile().vision_llm:
            return False
        if s.provider == "builtin":
            try:
                return self.library.get(self.llm_model()).vision
            except AppError:
                return False
        return True

    # -- ejecución completa -------------------------------------------------
    def run(self, ctx: JobContext, project_id: str, stages: tuple[str, ...] = STAGES,
            page_ids: list[str] | None = None, force: bool = False) -> dict:
        project = self.store.get(project_id)
        all_ids = list(project.page_ids)
        ids = [p for p in (page_ids or all_ids) if p in all_ids]
        if not ids:
            raise AppError("empty_project", "El proyecto no tiene páginas.")
        active = [s for s in STAGES if s in stages]
        full = sum(STAGE_WEIGHT[s] for s in active)

        pages = {pid: self.store.get_page(project_id, pid) for pid in ids}
        todo = {pid: _todo(pages[pid], active, force) for pid in ids}
        initial = {pid: _initial_state(pages[pid], todo[pid]) for pid in ids}
        run = RunState(self.store, project_id, self._publish)
        run.begin(active, ids, initial, force, ctx.job.id)
        total_units = len(ids) * full
        pre_units = sum(full - sum(STAGE_WEIGHT[s] for s in todo[pid]) for pid in ids)
        work_units = total_units - pre_units
        progress = _Progress(ctx, run, len(ids), total_units, pre_units, work_units)
        stats: dict = {"pages": len(ids), "pages_with_work": sum(1 for t in todo.values() if t), "lines": 0, "review": 0,
                       "refused": 0, "edited_by_reviewer": 0, "errors": 0, "model": ""}
        started = time.time()
        translator: ContextualTranslator | None = None
        try:
            ctx.update(stage="prepare", message="Preparando", force=True)
            if project.source_lang == AUTO_LANG and not project.detected_lang and any("analyze" in t for t in todo.values()):
                lang = self._detect_language(ctx, project, ids)
                run.set_language(lang)
                project = self.store.get(project_id)
            else:
                run.set_language(project.lang)
            if "translate" in active and any("translate" in t for t in todo.values()):
                translator = self.translator()
                stats["model"] = translator.model
                health = translator.client.health()
                if not health.get("ok"):
                    raise LLMUnavailableError(_unavailable_message(self.settings.value.llm.provider))
                threading.Thread(target=_warm_up, args=(translator, ctx.cancel_event), name="llm-warmup", daemon=True).start()
            story: dict[str, str] = {}
            for p in all_ids:  # memoria narrativa: resúmenes de lo ya traducido, también de páginas fuera de esta tarea
                pg = pages.get(p) or self.store.get_page(project_id, p)
                if pg.summary:
                    story[p] = f"p.{pg.index + 1}: {pg.summary}"

            def analyzed_ahead(pid: str) -> None:
                """Analiza la página siguiente por adelantado (la traducción necesita su texto como contexto)."""
                nxt_idx = all_ids.index(pid) + 1
                if nxt_idx >= len(all_ids):
                    return
                nxt = all_ids[nxt_idx]
                if nxt in todo and "analyze" in todo[nxt] and run.data["pages"][nxt]["state"] == "pending":
                    self._step_analyze(ctx, progress, run, project_id, nxt, stats, label=f"Página {nxt_idx + 1}")

            for pid in ids:
                if not todo[pid]:
                    continue
                progress.checkpoint()
                idx = all_ids.index(pid)
                label = f"Página {idx + 1}"
                try:
                    if "analyze" in todo[pid] and run.data["pages"][pid]["state"] == "pending":
                        self._step_analyze(ctx, progress, run, project_id, pid, stats, label=label)
                    if run.data["pages"][pid]["state"] == "error":  # falló aquí o al analizarla por adelantado
                        progress.page_finished(pid, todo[pid])
                        continue
                    if "translate" in todo[pid]:
                        if "analyze" in active:
                            analyzed_ahead(pid)
                        self._step_translate(ctx, progress, run, translator, project_id, pid, story, stats, label=label)
                    if "clean" in todo[pid]:
                        self._step_clean(ctx, progress, run, project_id, pid, label=label)
                    run.set_page(pid, "done")
                    progress.page_finished(pid, todo[pid])
                except (CancelledError, ModelMissingError, LLMUnavailableError):
                    raise
                except Exception as exc:  # una página dañada no detiene el resto de la obra
                    log.exception("Error procesando %s", label)
                    msg = exc.message if isinstance(exc, AppError) else "No se pudo procesar la página."
                    self._mark_page_error(project_id, pid, msg)
                    run.set_page(pid, "error", msg)
                    stats["errors"] += 1
                    progress.page_finished(pid, todo[pid])

            stats["seconds"] = round(time.time() - started, 1)
            counts = run.counts()
            stats["done_pages"], stats["error_pages"] = counts["done"], counts["error"]
            with self.store.lock(project_id):
                project = self.store.get(project_id)
                project.last_job = {"finished": now(), "stages": list(active), **{k: v for k, v in stats.items()}}
                self.store.save(project)
            run.finish("done")
            ctx.update(1.0, stage="done", message="Proceso completado", force=True, eta_s=0.0,
                       detail=progress.detail(None, "done"))
            return stats
        except CancelledError:
            run.finish("cancelled")
            raise
        except Exception as exc:
            run.finish("error", exc.message if isinstance(exc, AppError) else "Error interno inesperado.")
            raise

    # -- pasos de la canalización -----------------------------------------------
    def _step_analyze(self, ctx: JobContext, progress: "_Progress", run: RunState, project_id: str, pid: str, stats: dict,
                      label: str) -> None:
        progress.checkpoint()
        run.set_page(pid, "analyzing")
        progress.message(pid, "analyze", f"{label} · detectando diálogos")
        project = self.store.get(project_id)
        page = self.store.get_page(project_id, pid)
        try:
            self.analyze_page(project, page)
        except (ModelMissingError, CancelledError):
            raise
        except Exception:
            log.exception("Error analizando %s", label)
            self._mark_page_error(project_id, pid, "No se pudo analizar la página.")
            run.set_page(pid, "error", "No se pudo analizar la página.")
            stats["errors"] += 1
            return
        run.set_page(pid, "analyzed")
        progress.step_done("analyze", pid)

    def _step_translate(self, ctx: JobContext, progress: "_Progress", run: RunState, translator: ContextualTranslator | None,
                        project_id: str, pid: str, story: dict[str, str], stats: dict, label: str) -> None:
        progress.checkpoint()
        if translator is None:
            raise LLMUnavailableError(_unavailable_message(self.settings.value.llm.provider))
        run.set_page(pid, "translating")
        progress.message(pid, "translate", f"{label} · traduciendo")
        project = self.store.get(project_id)
        all_ids = project.page_ids
        idx = all_ids.index(pid)
        page = self.store.get_page(project_id, pid)
        prev_page = self.store.get_page(project_id, all_ids[idx - 1]) if idx > 0 else None
        next_page = self.store.get_page(project_id, all_ids[idx + 1]) if idx + 1 < len(all_ids) else None
        if page.regions:
            image = None
            if self.use_vision():
                image = annotate_for_llm(read_bgr(self.store.original_path(project_id, page)), [r.bbox for r in page.regions])
            earlier = [story[p] for p in all_ids[:idx] if p in story]
            result = translator.translate_page(project, page, prev_page=prev_page, next_page=next_page, story=earlier,
                                               image_jpeg=image, cancel=ctx.cancel_event)
            with self.store.lock(project_id):
                project = self.store.get(project_id)
                page = self.store.get_page(project_id, pid)
                by_id = {r.id: r for r in result.updated}
                page.regions = [by_id.get(r.id, r) for r in page.regions]
                page.summary = result.summary or page.summary
                if page.status in ("imported", "analyzed"):
                    page.status = "translated"
                self.store.save_page(project_id, page)
                merge_memory(project, result)
                self.store.save(project)
            if page.summary:
                story[pid] = f"p.{page.index + 1}: {page.summary}"
            stats["lines"] += len(result.updated)
            stats["review"] += sum(1 for r in result.updated if r.status == "review")
            stats["refused"] += sum(1 for r in result.updated if "refused" in r.flags)
            stats["edited_by_reviewer"] += result.reviewed
        else:
            with self.store.lock(project_id):
                page = self.store.get_page(project_id, pid)
                if page.status in ("imported", "analyzed"):
                    page.status = "translated"
                self.store.save_page(project_id, page)
        run.set_page(pid, "translated")
        progress.step_done("translate", pid)

    def _step_clean(self, ctx: JobContext, progress: "_Progress", run: RunState, project_id: str, pid: str, label: str) -> None:
        progress.checkpoint()
        run.set_page(pid, "cleaning")
        progress.message(pid, "clean", f"{label} · reconstruyendo globos")
        project = self.store.get(project_id)
        page = self.store.get_page(project_id, pid)
        if page.regions:
            self.clean_page(project, page)
        progress.step_done("clean", pid)

    def _mark_page_error(self, project_id: str, pid: str, message: str) -> None:
        with self.store.lock(project_id):
            page = self.store.get_page(project_id, pid)
            page.status, page.error = "error", message
            self.store.save_page(project_id, page)

    # -- idioma automático ----------------------------------------------------------
    def _detect_language(self, ctx: JobContext, project: Project, ids: list[str]) -> str:
        """Deduce si la obra es japonesa o inglesa mirando las primeras páginas con texto."""
        ctx.update(stage="prepare", message="Detectando el idioma del original", force=True)
        detector = self.detector()
        blocks: list[DetectedBlock] = []
        best: tuple[int, np.ndarray, list[DetectedBlock]] | None = None
        for pid in ids[:LANG_SAMPLE_PAGES]:
            ctx.check()
            img = read_bgr(self.store.original_path(project.id, self.store.get_page(project.id, pid)))
            found, _mask = detector.detect(img)
            blocks += found
            if found and (best is None or len(found) > best[0]):
                best = (len(found), img, found)
            if len(blocks) >= 10:
                break
        guess, _confidence = guess_from_blocks(blocks)
        lang = guess or "ja"
        if best is not None:
            _n, img, found = best
            biggest = sorted(found, key=lambda b: b.area, reverse=True)[:4]
            engine = self._ocr.engine_for(lang)
            confirmed = guess_from_text(engine.recognize(img, b).text for b in biggest)
            if confirmed and confirmed != lang:
                log.info("Idioma corregido por la lectura del texto: %s → %s", lang, confirmed)
                lang = confirmed
        log.info("Idioma detectado para %s: %s", project.id, lang)
        with self.store.lock(project.id):
            fresh = self.store.get(project.id)
            fresh.detected_lang = lang
            if fresh.direction_auto:
                fresh.reading_direction = direction_for(lang)
            self.store.save(fresh)
        return lang

    # -- etapa 1: análisis ----------------------------------------------------
    def analyze_page(self, project: Project, page: Page) -> Page:
        img = read_bgr(self.store.original_path(project.id, page))
        blocks, mask = self.detector().detect(img)
        panels = detect_panels(img)
        order = reading_order([b.bbox for b in blocks], panels, project.reading_direction)
        engine = self._ocr.engine_for(project.lang)
        median_line = float(np.median([b.line_size for b in blocks])) if blocks else 0.0
        keep = {r.id: r for r in page.regions if r.status in ("approved", "edited")}
        regions: list[Region] = []
        for rank, bi in enumerate(order):
            block = blocks[bi]
            ocr = engine.recognize(img, block)
            if not ocr.text.strip():
                continue
            regions.append(self._make_region(project, page, img, mask, block, ocr.text, ocr.confidence, ocr.engine,
                                             rank, median_line))
        # Se conservan los textos que el usuario ya revisó si siguen en el mismo sitio.
        for r in regions:
            for old in keep.values():
                if _iou(r.bbox, old.bbox) > 0.6:
                    r.translation, r.status, r.style, r.speaker = old.translation, old.status, old.style, old.speaker
        page.regions = regions
        page.panels = [tuple(int(v) for v in p) for p in panels]
        page.status, page.error, page.ocr_engine = "analyzed", "", engine.id
        page.has_clean = False
        write_png(self.store.mask_path(project.id, page.id), mask, compression=6)
        self.store.save_page(project.id, page)
        return page

    def _make_region(self, project: Project, page: Page, img: np.ndarray, mask: np.ndarray, block: DetectedBlock,
                     text: str, conf: float, engine: str, order: int, median_line: float, region_id: str | None = None
                     ) -> Region:
        bubble = find_bubble(img, mask, block)
        x1, y1, x2, y2 = block.bbox
        bw, bh = x2 - x1, y2 - y1
        h, w = img.shape[:2]
        bg, spread = text_ring_stats(img, mask, block.bbox)
        if bubble:
            # Se usa todo el interior del globo (el polígono ajusta el ancho de cada línea): los globos
            # verticales japoneses son estrechos y el español horizontal necesita su anchura completa.
            bx1, by1, bx2, by2 = bubble.bbox
            ix, iy = int((bx2 - bx1) * 0.06), int((by2 - by1) * 0.08)
            layout = (min(bx1 + ix, x1), min(by1 + iy, y1), max(bx2 - ix, x2), max(by2 - iy, y2))
        else:
            layout = _grow_into_free_space(img, mask, block.bbox, bg) if spread < 12 else (
                max(0, x1 - int(bw * 0.08)), max(0, y1 - int(bh * 0.08)), min(w, x2 + int(bw * 0.08)), min(h, y2 + int(bh * 0.08)))

        kind = _classify(block, bubble, median_line)
        dark_bg = float(np.mean(bg)) < 100
        style = TextStyle(font={"narration": "narration", "sfx": "sfx", "thought": "dialogue"}.get(kind, "dialogue"))
        if dark_bg:
            style.color, style.stroke_color = "#ffffff", "#000000"
        if not bubble and spread >= 12:
            style.stroke_width = round(max(2.0, block.line_size * 0.12), 1)  # legibilidad sobre dibujo
        if kind == "sfx":
            style.uppercase, style.stroke_width = True, max(style.stroke_width, 3.0)
        # Las onomatopeyas forman parte del dibujo: no se borran; con sfx="note" se rotula su traducción encima.
        render = kind != "sfx" or project.sfx == "note"
        return Region(
            id=region_id or new_id("r"), order=order, kind=kind, bbox=block.bbox,
            lines=[p.astype(int).tolist() for p in block.lines], vertical=block.vertical, line_size=round(block.line_size, 1),
            bubble=Bubble(polygon=bubble.polygon, bbox=bubble.bbox, fill=bubble.fill, uniform=bubble.uniform) if bubble else None,
            layout_box=tuple(int(v) for v in layout), source_text=text, ocr_confidence=round(conf, 3), ocr_engine=engine,
            max_chars=estimate_max_chars(layout, block.line_size, page.height, bubble is not None),
            style=style, erase=kind != "sfx", render=render,
        )

    def reocr_region(self, project_id: str, page_id: str, region_id: str | None, bbox: tuple[int, int, int, int]) -> Region:
        """Vuelve a reconocer un área (corrige o crea una región dibujada por el usuario)."""
        project = self.store.get(project_id)
        with self.store.lock(project_id):
            page = self.store.get_page(project_id, page_id)
            x1, y1, x2, y2 = (int(v) for v in bbox)
            x1, y1 = max(0, min(x1, page.width - 2)), max(0, min(y1, page.height - 2))
            x2, y2 = max(x1 + 2, min(x2, page.width)), max(y1 + 2, min(y2, page.height))
            img = read_bgr(self.store.original_path(project_id, page))
            mask_path = self.store.mask_path(project_id, page_id)
            mask = read_gray(mask_path) if mask_path.exists() else np.zeros(img.shape[:2], np.uint8)
            vertical = project.lang in ("ja", "zh", "zh-hant") and (y2 - y1) > (x2 - x1) * 1.2
            lines = _split_lines(img, mask, (x1, y1, x2, y2), vertical)
            if lines:
                thick = [min(np.ptp(p[:, 0]), np.ptp(p[:, 1])) for p in lines]
                line_size = float(np.median(thick))
            else:
                line_size = float(min(x2 - x1, y2 - y1)) / 2
            block = DetectedBlock(bbox=(x1, y1, x2, y2), lines=lines, vertical=vertical, confidence=1.0, line_size=line_size)
            ocr = self._ocr.engine_for(project.lang).recognize(img, block)
            existing = next((r for r in page.regions if r.id == region_id), None) if region_id else None
            order = existing.order if existing else len(page.regions)
            region = self._make_region(project, page, img, mask, block, ocr.text, ocr.confidence, ocr.engine, order,
                                       line_size, region_id=existing.id if existing else None)
            if existing:
                region.style, region.erase, region.render = existing.style, existing.erase, existing.render
                page.regions = [region if r.id == existing.id else r for r in page.regions]
            else:
                page.regions.append(region)
            page.regions.sort(key=lambda r: r.order)
            self.store.save_page(project_id, page)
            return region

    # -- etapa 2: traducción --------------------------------------------------
    def translator(self) -> ContextualTranslator:
        s = self.settings.value
        quality = self.profile().quality if s.translation.quality == "auto" else s.translation.quality
        client = create_client(s.llm, self.runtime, self.library)
        return ContextualTranslator(client, self.llm_model(), s.translation.model_copy(update={"quality": quality}))

    def translate_single(self, project_id: str, page_id: str, region_ids: list[str]) -> list[Region]:
        """Retraduce textos concretos con todo el contexto de su página."""
        project = self.store.get(project_id)
        page = self.store.get_page(project_id, page_id)
        idx = project.page_ids.index(page_id)
        prev_page = self.store.get_page(project_id, project.page_ids[idx - 1]) if idx > 0 else None
        next_page = self.store.get_page(project_id, project.page_ids[idx + 1]) if idx + 1 < len(project.page_ids) else None
        story = [p.summary for p in self.store.pages(project) if p.summary][:idx]
        subset = page.model_copy(deep=True)
        for r in subset.regions:
            if r.id in region_ids:
                r.status = "pending"
        image = None
        if self.use_vision():
            image = annotate_for_llm(read_bgr(self.store.original_path(project_id, page)), [r.bbox for r in page.regions])
        result = self.translator().translate_page(project, subset, prev_page=prev_page, next_page=next_page, story=story,
                                                  image_jpeg=image)
        wanted = {r.id: r for r in result.updated if r.id in region_ids}
        with self.store.lock(project_id):
            page = self.store.get_page(project_id, page_id)
            page.regions = [wanted.get(r.id, r) for r in page.regions]
            self.store.save_page(project_id, page)
        return list(wanted.values())

    # -- etapa 3: limpieza ----------------------------------------------------
    def clean_page(self, project: Project, page: Page) -> Page:
        img = read_bgr(self.store.original_path(project.id, page))
        mask_path = self.store.mask_path(project.id, page.id)
        mask = read_gray(mask_path) if mask_path.exists() else np.zeros(img.shape[:2], np.uint8)
        targets = []
        for r in page.regions:
            if not r.erase:
                continue
            b = r.bubble
            targets.append(EraseTarget(
                bbox=tuple(r.bbox), lines=[np.asarray(p, np.int32) for p in r.lines], line_size=r.line_size or 16.0,
                bubble_polygon=b.polygon if b else None, fill=tuple(b.fill) if b else None, uniform=bool(b and b.uniform),
            ))
        with self._lock:
            inpainter = self._inpainter
        cleaned = inpainter.erase(img, mask, targets) if targets else img
        write_png(self.store.clean_path(project.id, page.id), cleaned)
        with self.store.lock(project.id):
            page = self.store.get_page(project.id, page.id)
            page.has_clean = True
            if page.status != "error":
                page.status = "cleaned"
            self.store.save_page(project.id, page)
        return page


def _classify(block: DetectedBlock, bubble, median_line: float) -> str:
    if bubble is not None:
        poly = np.array(bubble.polygon)
        x1, y1, x2, y2 = bubble.bbox
        rect_fill = cv2.contourArea(poly.astype(np.int32)) / max(1, (x2 - x1) * (y2 - y1))
        if len(poly) <= 6 and rect_fill > 0.93:
            return "narration"  # cartela rectangular
        return "dialogue"
    if median_line and block.line_size > median_line * 2.4 and len(block.lines) <= 2:
        return "sfx"
    return "narration" if len(block.lines) >= 2 else "other"


def _grow_into_free_space(img: np.ndarray, mask: np.ndarray, bbox, bg: np.ndarray) -> tuple[int, int, int, int]:
    """Amplía el área de un texto sin globo hacia el fondo liso que lo rodea (sin invadir dibujo),
    para que la traducción horizontal no quede comprimida en una columna estrecha."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bbox
    bw, bh = x2 - x1, y2 - y1
    diff = np.abs(img.astype(np.int16) - bg.astype(np.int16)).max(axis=2)
    free = (diff < 28) | (mask > 0)

    def clear(ax1, ay1, ax2, ay2) -> bool:
        if ax1 < 0 or ay1 < 0 or ax2 > w or ay2 > h or ax2 <= ax1 or ay2 <= ay1:
            return False
        return float(free[ay1:ay2, ax1:ax2].mean()) > 0.985

    step_x, step_y = max(2, int(bw * 0.05)), max(2, int(bh * 0.05))
    for _ in range(12):  # hasta +60 % por lado
        grown = False
        if x2 - x1 < bw * 2.2 and clear(x1 - step_x, y1, x1, y2):
            x1 -= step_x
            grown = True
        if x2 - x1 < bw * 2.2 and clear(x2, y1, x2 + step_x, y2):
            x2 += step_x
            grown = True
        if not grown:
            break
    for _ in range(6):  # hasta +30 % por lado
        grown = False
        if clear(x1, y1 - step_y, x2, y1):
            y1 -= step_y
            grown = True
        if clear(x1, y2, x2, y2 + step_y):
            y2 += step_y
            grown = True
        if not grown:
            break
    # Margen interior para no pegar el texto al dibujo vecino.
    mx, my = int((x2 - x1 - bw) * 0.15), int((y2 - y1 - bh) * 0.15)
    return (x1 + mx, y1 + my, x2 - mx, y2 - my)


def _split_lines(img: np.ndarray, mask: np.ndarray, bbox, vertical: bool) -> list[np.ndarray]:
    """Separa líneas/columnas de un área dibujada por el usuario mediante proyecciones."""
    x1, y1, x2, y2 = bbox
    sub = mask[y1:y2, x1:x2] > 0
    if sub.sum() < 20:  # sin máscara: se binariza la zona (texto oscuro sobre claro o al revés)
        gray = cv2.cvtColor(img[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        sub = bw == 0 if (bw == 0).mean() < 0.5 else bw > 0
    profile = sub.sum(axis=0 if vertical else 1).astype(np.float32)
    if profile.max() <= 0:
        return []
    on = profile > max(1.0, profile.max() * 0.05)
    segments, start = [], None
    for i, v in enumerate(list(on) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= 3:
                segments.append((start, i))
            start = None
    lines = []
    for a, b in segments:
        pad = max(1, (b - a) // 6)
        if vertical:
            cols = sub[:, a:b].any(axis=1).nonzero()[0]
            if not len(cols):
                continue
            lx1, lx2, ly1, ly2 = x1 + max(0, a - pad), x1 + min(x2 - x1, b + pad), y1 + cols[0], y1 + cols[-1] + 1
        else:
            rows = sub[a:b, :].any(axis=0).nonzero()[0]
            if not len(rows):
                continue
            ly1, ly2, lx1, lx2 = y1 + max(0, a - pad), y1 + min(y2 - y1, b + pad), x1 + rows[0], x1 + rows[-1] + 1
        lines.append(np.array([[lx1, ly1], [lx2, ly1], [lx2, ly2], [lx1, ly2]], np.int32))
    return lines


def _iou(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def _todo(page: Page, active: list[str], force: bool) -> list[str]:
    """Etapas que aún faltan en la página (las hechas no se repiten salvo con ``force``)."""
    if force:
        return list(active)
    todo = []
    if "analyze" in active and page.status in ("imported", "error"):
        todo.append("analyze")
    analyzed = page.status in ("analyzed", "translated", "cleaned") or "analyze" in todo
    if "translate" in active and analyzed and page.status not in ("translated", "cleaned"):
        todo.append("translate")
    if "clean" in active and (analyzed or page.status == "cleaned") and page.status != "cleaned":
        todo.append("clean")
    return todo


def _initial_state(page: Page, todo: list[str]) -> str:
    if todo:
        return "pending"
    if page.status == "error":
        return "error"
    return "pending" if page.status == "imported" else "done"


def _unavailable_message(provider: str) -> str:
    if provider == "builtin":
        return ("El motor de lenguaje integrado no está listo: falta el servidor de modelos o no hay ningún modelo "
                "instalado. Revisa la sección Modelos.")
    return "No se pudo conectar con el servidor de modelos configurado. Comprueba que está abierto e inténtalo de nuevo."


def _warm_up(translator: ContextualTranslator, cancel: threading.Event) -> None:
    """Carga el modelo en segundo plano mientras la visión analiza las primeras páginas."""
    warm = getattr(translator.client, "warm_up", None)
    if warm is None:
        return
    try:
        warm(translator.model, cancel)
    except Exception as exc:  # el error real, con su mensaje, saldrá en la primera traducción
        log.info("Precarga del modelo no completada: %s", exc)


class _Progress:
    """Progreso global, ETA y estado visible de la tarea."""

    def __init__(self, ctx: JobContext, run: RunState, pages: int, total_units: float, pre_units: float, work_units: float):
        self.ctx, self.run = ctx, run
        self.pages, self.total, self.pre, self.work = pages, total_units or 1.0, pre_units, max(work_units, 1e-9)
        self.done_units = 0.0       # trabajo realmente hecho en esta ejecución (base del ritmo)
        self.skipped_units = 0.0    # trabajo que ya no se hará (páginas con error): cuenta para el % pero no para el ritmo
        self._per_page: dict[str, float] = {}
        self.finished_pages = 0
        self.started = time.monotonic()
        self.idle = 0.0             # tiempo en pausa: no cuenta para el ETA

    def checkpoint(self) -> None:
        t0 = time.monotonic()
        self.ctx.check()
        waited = time.monotonic() - t0
        if waited > 0.4:
            self.idle += waited

    def step_done(self, stage: str, pid: str) -> None:
        self.done_units += STAGE_WEIGHT[stage]
        self._per_page[pid] = self._per_page.get(pid, 0.0) + STAGE_WEIGHT[stage]
        self._push(pid, stage)

    def page_finished(self, pid: str, stages: list[str]) -> None:
        missing = sum(STAGE_WEIGHT[s] for s in stages) - self._per_page.pop(pid, 0.0)
        if missing > 1e-9:
            self.skipped_units += missing
        else:
            self.finished_pages += 1
        self._push(pid, "")

    def message(self, pid: str, stage: str, text: str) -> None:
        self.ctx.update(stage=stage, message=text, force=True)
        self._push(pid, stage)

    def eta(self) -> float | None:
        elapsed = time.monotonic() - self.started - self.idle
        if self.finished_pages < 1 or self.done_units <= 0 or elapsed < 4:  # con una página completa ya hay un ritmo fiable
            return None
        return max(0.0, (self.work - self.skipped_units - self.done_units) * elapsed / self.done_units)

    def detail(self, current: str | None, stage: str) -> dict:
        c = self.run.counts()
        return {"pages_total": c["total"], "pages_done": c["done"], "pages_error": c["error"], "pages_pending": c["pending"],
                "current_page": current, "stage": stage}

    def _push(self, current: str | None, stage: str) -> None:
        frac = (self.pre + self.skipped_units + self.done_units) / self.total
        self.ctx.update(min(frac, 0.999), eta_s=self.eta(), detail=self.detail(current, stage))
