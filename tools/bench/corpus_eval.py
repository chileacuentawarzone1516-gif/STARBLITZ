#!/usr/bin/env python3
"""Evaluación del pipeline COMPLETO del motor Python sobre un capítulo real (importación → análisis → traducción → reconstrucción).

Usa la API REAL del motor (FastAPI, en el mismo proceso, sin red) y los modelos reales; solo añade cronómetros alrededor de las
funciones del pipeline para desglosar el tiempo por página y etapa, y un muestreador de RAM/CPU. No cambia ningún resultado.

  detección        detector().detect (por defecto o experimental, según --detector)
  viñetas/orden    detect_panels + reading_order
  OCR              recognize() del motor de OCR del idioma
  globos           find_bubble (asociación texto ↔ globo)
  traducción       translate_page del traductor (incluye la espera al servidor de lenguaje)
  reconstrucción   clean_page (borrado + relleno/LaMa)

El cómic NO se copia al repositorio: se pasa por ruta y los resultados van a --out (fuera del repo).

Ejemplo (servidor de lenguaje propio, compatible con OpenAI):
  llama-server -m Qwen3.5-4B-Q4_K_M.gguf --port 8081 -ngl 99 -c 8192
  PYTHONPATH=engine python tools/bench/corpus_eval.py --source cap01.pdf --lang en --detector default \
      --model text-detector=ruta/comictextdetector.onnx --llm-url http://127.0.0.1:8081/v1 --llm-model qwen3.5-4b --out res/default
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))

from fastapi.testclient import TestClient  # noqa: E402

from starblitz_engine.api.app import create_app  # noqa: E402
from starblitz_engine.api.context import Services  # noqa: E402
from starblitz_engine.core.paths import DataPaths  # noqa: E402
from starblitz_engine.models.registry import get_spec  # noqa: E402
from starblitz_engine.pipeline import processor as proc_mod  # noqa: E402

_page = threading.local()
T: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
COUNTS: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))


@contextmanager
def timed(stage: str):
    t = time.perf_counter()
    try:
        yield
    finally:
        pid = getattr(_page, "id", "_sin_pagina")
        T[pid][stage] += time.perf_counter() - t
        COUNTS[pid][stage] += 1


def wrap(fn, stage):
    def inner(*a, **k):
        with timed(stage):
            return fn(*a, **k)
    return inner


def instrument(svc: Services) -> None:
    p = svc.processor
    cls = type(p)
    orig_analyze, orig_clean, orig_detector, orig_translator = cls.analyze_page, cls.clean_page, cls.detector, cls.translator

    def analyze_page(self, project, page):
        _page.id = page.id
        with timed("analisis_total"):
            return orig_analyze(self, project, page)

    def clean_page(self, project, page):
        _page.id = page.id
        with timed("reconstruccion"):
            return orig_clean(self, project, page)

    def detector(self):
        d = orig_detector(self)
        if not getattr(d, "_timed", False):
            d.detect = wrap(d.detect, "deteccion")
            d._timed = True
        return d

    def translator(self):
        tr = orig_translator(self)
        inner = tr.translate_page

        def translate_page(project, page, *a, **k):
            _page.id = page.id
            with timed("traduccion"):
                return inner(project, page, *a, **k)
        tr.translate_page = translate_page
        return tr

    cls.analyze_page, cls.clean_page, cls.detector, cls.translator = analyze_page, clean_page, detector, translator
    # Asociación texto ↔ globo (el nombre cambió el 2026-11-09: búsqueda normal + ampliada exclusiva).
    for name in ("find_bubble_exclusive", "find_bubble"):
        if hasattr(proc_mod, name):
            setattr(proc_mod, name, wrap(getattr(proc_mod, name), "globos"))
            break
    proc_mod.detect_panels = wrap(proc_mod.detect_panels, "vinetas_orden")
    proc_mod.reading_order = wrap(proc_mod.reading_order, "vinetas_orden")
    router = p._ocr
    orig_engine_for = router.engine_for

    def engine_for(lang):
        eng = orig_engine_for(lang)
        if not getattr(eng, "_timed", False):
            eng.recognize = wrap(eng.recognize, "ocr")
            eng._timed = True
        return eng
    router.engine_for = engine_for


class Sampler(threading.Thread):
    """RAM (RSS) y CPU de este proceso y, si se indica, del servidor de lenguaje; cada `every` segundos."""

    def __init__(self, extra_pid: int | None, every: float = 0.5):
        super().__init__(daemon=True)
        self.me, self.extra = psutil.Process(), (psutil.Process(extra_pid) if extra_pid else None)
        self.every, self.stop_evt, self.samples = every, threading.Event(), []
        self.me.cpu_percent(None)
        if self.extra:
            self.extra.cpu_percent(None)

    def run(self):
        t0 = time.time()
        while not self.stop_evt.wait(self.every):
            s = {"t": round(time.time() - t0, 2), "rss_mb": self.me.memory_info().rss / 2**20, "cpu": self.me.cpu_percent(None),
                 "stage": getattr(_page, "id", "")}
            if self.extra:
                try:
                    s["llm_rss_mb"] = self.extra.memory_info().rss / 2**20
                    s["llm_cpu"] = self.extra.cpu_percent(None)
                except psutil.Error:
                    pass
            self.samples.append(s)

    def summary(self, key):
        v = [s[key] for s in self.samples if key in s]
        return {"max": round(max(v), 1), "media": round(sum(v) / len(v), 1)} if v else {}


def install_local_models(models_root: Path, pairs: list[str]) -> None:
    """Copia modelos ya descargados a la carpeta del motor verificando el SHA-256 del registro (como haría la instalación)."""
    for pair in pairs:
        mid, path = pair.split("=", 1)
        spec = get_spec(mid)
        if spec is None:
            raise SystemExit(f"modelo desconocido: {mid}")
        f = spec.files[0]
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if f.sha256 and digest != f.sha256:
            raise SystemExit(f"SHA-256 distinto para {mid}: {digest}")
        dst = spec.directory(models_root) / f.rel_path
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dst)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="PDF/ZIP/carpeta del capítulo (no se modifica)")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--detector", choices=["default", "manga-det"], default="default")
    ap.add_argument("--model", action="append", default=[], help="id=ruta de un modelo de visión ya descargado")
    ap.add_argument("--llm-url", default="", help="servidor compatible con OpenAI (vacío = solo análisis y reconstrucción)")
    ap.add_argument("--llm-model", default="")
    ap.add_argument("--llm-pid", type=int, default=0, help="PID del servidor de lenguaje para medir su RAM/CPU")
    ap.add_argument("--profile", default="mid")
    ap.add_argument("--inpaint", default="fast")
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-images", action="store_true")
    a = ap.parse_args()

    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    data = out / "data"
    paths = DataPaths(data)
    paths.ensure() if hasattr(paths, "ensure") else None
    install_local_models(paths.models, a.model)
    svc = Services.build(paths, token="bench")
    instrument(svc)
    client = TestClient(create_app(svc))
    H = {"Authorization": "Bearer bench"}

    def call(method, url, **k):
        r = client.request(method, url, headers=H, **k)
        if r.status_code >= 400:
            raise SystemExit(f"{method} {url} → {r.status_code}: {r.text[:400]}")
        return r.json() if "json" in r.headers.get("content-type", "") else r.content

    def wait(job):
        while True:
            j = call("GET", f"/api/jobs/{job['id']}")
            if j["status"] in ("done", "error", "cancelled"):
                return j
            time.sleep(0.5)

    llm = {"provider": "openai", "base_url": a.llm_url, "model": a.llm_model, "use_vision": False} if a.llm_url else {}
    call("PATCH", "/api/settings", json={"processing": {"device": "cpu", "profile": a.profile, "inpaint": a.inpaint,
                                                        "detector": a.detector, "max_pages": 1000}, **({"llm": llm} if llm else {})})
    sampler = Sampler(a.llm_pid or None)
    sampler.start()
    src = Path(a.source)
    result: dict = {"source": src.name, "source_sha256": hashlib.sha256(src.read_bytes()).hexdigest(), "detector": a.detector,
                    "lang": a.lang, "llm_model": a.llm_model, "profile": a.profile, "inpaint": a.inpaint, "cpu_count": os.cpu_count()}
    proj = call("POST", "/api/projects", json={"name": "corpus", "source_lang": a.lang})
    pid = proj["id"]
    t0 = time.perf_counter()
    job = call("POST", f"/api/projects/{pid}/import", files=[("files", (src.name, src.read_bytes(), "application/pdf"))])
    j = wait(job)
    result["import_s"] = round(time.perf_counter() - t0, 2)
    result["import_status"] = j["status"]
    stages = ["analyze", "translate", "clean"] if a.llm_url else ["analyze", "clean"]
    t0 = time.perf_counter()
    j = wait(call("POST", f"/api/projects/{pid}/process", json={"stages": stages}))
    result["process_s"] = round(time.perf_counter() - t0, 2)
    result["process_status"], result["process_error"] = j["status"], j.get("error", "")
    sampler.stop_evt.set()
    sampler.join()
    project = call("GET", f"/api/projects/{pid}")
    pages = project.get("pages") or []
    result["run"] = call("GET", f"/api/projects/{pid}/run")
    rows = []
    img_dir = out / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    for i, pg in enumerate(pages, 1):
        page = call("GET", f"/api/projects/{pid}/pages/{pg['id']}")
        regs = page.get("regions", [])
        t = {k: round(v, 3) for k, v in T.get(pg["id"], {}).items()}
        rows.append({"n": i, "id": pg["id"], "w": page.get("width"), "h": page.get("height"), "status": page.get("status"),
                     "error": page.get("error", ""), "regions": len(regs),
                     "lines": sum(len(r.get("lines") or []) for r in regs),
                     "with_bubble": sum(1 for r in regs if r.get("bubble")),
                     "ocr_empty": sum(1 for r in regs if "ocr_empty" in (r.get("flags") or [])),
                     "review": sum(1 for r in regs if r.get("status") == "review"),
                     "kinds": dict(sorted({k: sum(1 for r in regs if r.get("kind") == k) for k in {r.get("kind") for r in regs}}.items())),
                     "timings": t, "calls": dict(COUNTS.get(pg["id"], {})),
                     "texts": [{"bbox": r.get("bbox"), "kind": r.get("kind"), "src": r.get("source_text"), "es": r.get("translation"),
                                "status": r.get("status"), "flags": r.get("flags"), "bubble": bool(r.get("bubble")),
                                "vertical": r.get("vertical"), "conf": r.get("ocr_confidence")} for r in regs]})
        if a.keep_images:
            for kind in ("original", "clean"):
                try:
                    (img_dir / f"{i:03d}-{kind}.png").write_bytes(call("GET", f"/api/projects/{pid}/pages/{pg['id']}/image/{kind}"))
                except SystemExit:
                    pass
            (img_dir / f"{i:03d}-page.json").write_text(json.dumps(page, ensure_ascii=False), encoding="utf-8")
    result["pages"] = rows
    result["resources"] = {"motor_rss_mb": sampler.summary("rss_mb"), "motor_cpu_pct": sampler.summary("cpu"),
                           "llm_rss_mb": sampler.summary("llm_rss_mb"), "llm_cpu_pct": sampler.summary("llm_cpu"),
                           "samples": len(sampler.samples)}
    (out / "samples.json").write_text(json.dumps(sampler.samples), encoding="utf-8")
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    svc.shutdown()
    ok = sum(1 for r in rows if r["status"] in ("cleaned", "translated", "analyzed"))
    print(json.dumps({"pages": len(rows), "ok": ok, "import_s": result["import_s"], "process_s": result["process_s"],
                      "status": result["process_status"], "error": result["process_error"], "resources": result["resources"]},
                     ensure_ascii=False))
    return 0 if result["process_status"] == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
