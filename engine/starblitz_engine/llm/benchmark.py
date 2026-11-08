"""«Comparar modelos»: traduce las mismas frases con cada modelo instalado y mide carga y velocidad.

La calidad de una traducción literaria no se puede puntuar automáticamente de forma fiable; por eso se
muestran las salidas una al lado de otra (y la velocidad real en este equipo) para que la persona decida.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from ..core.errors import AppError, CancelledError
from ..projects.schema import Page, Project, Region
from ..translate.contextual import ContextualTranslator
from .samples import SAMPLES


def make_probe(lang: str, lines: list[str]) -> tuple[Project, Page]:
    """Proyecto y página sintéticos con ``lines`` como textos, para probar un modelo sin tocar proyectos reales."""
    project = Project(id="probe", name="Prueba de modelo", source_lang=lang, page_ids=["probe-page"])
    regions = [Region(id=f"r{i}", order=i, bbox=(0, 0, 100, 100), layout_box=(0, 0, 100, 100), source_text=text,
                      max_chars=max(40, len(text) * 3)) for i, text in enumerate(lines)]
    page = Page(id="probe-page", index=0, filename="probe", ext="png", width=100, height=100, sha1="", dhash="0",
                regions=regions)
    return project, page


def compare(model_ids: list[str], make_translator: Callable[[str], ContextualTranslator],
            progress: Callable[[float, str], None], cancel: threading.Event, langs: tuple[str, ...] = ("ja", "en")) -> dict:
    results = []
    steps = max(1, len(model_ids) * len(langs))
    step = 0
    for mid in model_ids:
        entry: dict = {"id": mid, "load_s": None, "languages": {}, "error": ""}
        try:
            translator = make_translator(mid)
            t0 = time.monotonic()
            warm = getattr(translator.client, "warm_up", None)
            if warm:
                progress(step / steps, f"Cargando {mid}")
                warm(mid, cancel)
            entry["load_s"] = round(time.monotonic() - t0, 1)
            for lang in langs:
                if cancel.is_set():
                    raise CancelledError()
                progress(step / steps, f"{mid}: traduciendo frases de prueba ({lang})")
                project, page = make_probe(lang, SAMPLES[lang])
                t1 = time.monotonic()
                result = translator.translate_page(project, page, prev_page=None, next_page=None, story=[], image_jpeg=None,
                                                   cancel=cancel)
                seconds = time.monotonic() - t1
                stats = getattr(translator.client, "last_stats", {}) or {}
                entry["languages"][lang] = {
                    "seconds": round(seconds, 1), "tokens_per_s": stats.get("tps", 0.0),
                    "items": [{"source": r.source_text, "translation": r.translation, "flags": r.flags,
                               "confidence": r.confidence} for r in result.updated],
                }
                step += 1
        except CancelledError:
            raise
        except AppError as exc:
            entry["error"] = exc.message
            step += len(langs) - len(entry["languages"])
        results.append(entry)
    progress(1.0, "Comparación terminada")
    return {"models": results, "samples": {k: SAMPLES[k] for k in langs}}


__all__ = ["compare", "make_probe"]
